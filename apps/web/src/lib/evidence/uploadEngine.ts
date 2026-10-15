// The photo upload engine: takes processed photos from the persistent queue to "evidence on the
// server", surviving reloads, dead zones and double taps. It has no UI and no browser globals of its
// own: everything environmental (the API, the storage PUT, timers, locks, online state, the signed-in
// user) is injected, so the failure paths can be tested exhaustively and deterministically.
//
// Per photo, using only the existing C2/C5a API:
//   queued -> init (idempotent on submissionId) -> PUT to the signed URL -> complete -> poll status
//          -> done (AVAILABLE) | rejected (final)
// Guarantees:
//   * One submissionId per photo, generated once and persisted, so a retry, a reload or a second tab
//     can never create a second evidence record; `init`/`complete` are idempotent server-side.
//   * The signed URL and headers live only in memory for one attempt. They are never persisted,
//     logged, or put in an error. Failures are persisted as short codes.
//   * A storage 403 (expired signature, size or type mismatch all look alike) triggers exactly one
//     fresh `init`; a second 403 is final.
//   * Retryable failures back off with jitter and stop consuming attempts while offline. After the
//     attempt budget a photo needs a manual retry; final failures never retry.
//   * Work resumes on foreground and on connectivity recovery, and at most `concurrency` uploads run.
//   * Nothing is ever uploaded under a different account: the signed-in user must equal the queue's
//     user before every network call.
import type { EvidenceFileInitRequest, EvidenceFileRef } from '@acaos/shared'
import { EVIDENCE_LIMITS, type EvidenceLimits } from './limits'
import type { PutFn } from './uploadTransport'
import { backoffMs } from './backoff'
import {
  classifyApiError, classifyPutStatus, dispositionOf, isUploadMissing, ERROR_TEXT, type UploadErrorCode,
} from './uploadErrors'
import { ImageError, type PreparedImage } from './imagePipeline'
import type { QueueItem, QueueState, QueueStore, Scope } from './queueStore'
import { scopeKey } from './queueStore'

export interface EvidenceApi {
  init(jobId: string, body: EvidenceFileInitRequest): Promise<{ file: EvidenceFileRef; upload?: { method: 'PUT'; url: string; headers: Record<string, string>; expiresAt: string } }>
  complete(jobId: string, fileId: string, workspaceId: string): Promise<{ file: EvidenceFileRef; processing?: boolean }>
  status(jobId: string, fileId: string, workspaceId: string): Promise<{ file: { status: string } }>
  cancel(jobId: string, fileId: string, workspaceId: string): Promise<{ file: EvidenceFileRef }>
}

export type LockFn = <T>(name: string, fn: () => Promise<T>) => Promise<{ ran: true; value: T } | { ran: false }>
export type LogFn = (event: string, data?: Record<string, string | number | boolean | null>) => void

export type EngineDeps = {
  scope: Scope
  store: QueueStore
  api: EvidenceApi
  put: PutFn
  /** Turns a picked photo into the bytes to upload. Throws ImageError. */
  prepare: (file: Blob) => Promise<PreparedImage>
  /** The currently signed-in user id, or null. Uploads only run while it equals scope.userId. */
  sessionUserId: () => string | null
  isOnline: () => boolean
  now?: () => number
  random?: () => number
  newId?: () => string
  timers?: { set: (fn: () => void, ms: number) => unknown; clear: (h: unknown) => void }
  lock?: LockFn
  /** Subscribe to online/foreground events (call `resume` from them); returns the unsubscribe function. */
  attach?: (resume: () => void) => () => void
  log?: LogFn
  limits?: EvidenceLimits
}

export type EnqueueResult =
  | { ok: true; id: string }
  | { ok: false; reason: ImageError['code'] | 'queue_full' | 'storage_full' | 'duplicate' | 'wrong_session' | 'unexpected'; message: string }

export type ItemView = {
  id: string
  jobId: string
  state: QueueState
  /** 0 to 1 while uploading. */
  progress: number
  errorCode: UploadErrorCode | null
  /** Fixed text for the person; never anything from the network. */
  errorText: string | null
  attempts: number
  nextAttemptAt: number | null
  sizeBytes: number
  width: number
  height: number
  createdAt: number
  hasPhoto: boolean
}
export type Snapshot = { items: ItemView[]; online: boolean; paused: 'session' | null }

const ACTIVE: ReadonlySet<QueueState> = new Set(['queued', 'uploading', 'processing', 'cancelling'])
const UNSENT: ReadonlySet<QueueState> = new Set(['queued', 'uploading', 'processing', 'failed'])
const POLL_WAKE_MS = 30_000
const DISABLED_DELAY_MS = 5 * 60_000
const TICK_MS = 15_000

export function createUploadEngine(deps: EngineDeps) {
  const { scope, store, api } = deps
  const limits = deps.limits ?? EVIDENCE_LIMITS
  const now = deps.now ?? (() => Date.now())
  const random = deps.random ?? Math.random
  const newId = deps.newId ?? (() => crypto.randomUUID())
  const timers = deps.timers ?? { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) }
  const log: LogFn = deps.log ?? (() => {})
  const sKey = scopeKey(scope)

  const inflight = new Map<string, { abort: AbortController; done: Promise<void> }>()
  const cancelled = new Set<string>()
  const progress = new Map<string, { loaded: number; total: number }>()
  const listeners = new Set<(s: Snapshot) => void>()
  let snapshot: Snapshot = { items: [], online: deps.isOnline(), paused: null }
  let started = false
  let disposed = false
  let current: Promise<void> | null = null
  let pumpAgain = false
  const lockedUntil = new Map<string, number>()
  let authPausedUntil = 0
  let lastUser: string | null | undefined
  let wake: unknown = null
  let tick: unknown = null
  let detach: (() => void) | null = null
  let lastProgressEmit = 0
  let enqueueChain: Promise<unknown> = Promise.resolve()

  const short = (id: string) => id.slice(0, 8)
  const sessionOk = () => deps.sessionUserId() === scope.userId

  // ── snapshot ───────────────────────────────────────────────────────────────
  async function refresh() {
    const items = await store.list(scope)
    snapshot = {
      online: deps.isOnline(),
      paused: sessionOk() ? null : 'session',
      items: items.map((i): ItemView => {
        const p = progress.get(i.id)
        return {
          id: i.id, jobId: i.jobId, state: i.state,
          progress: i.state === 'uploading' && p && p.total ? Math.min(1, p.loaded / p.total) : i.state === 'processing' || i.state === 'done' ? 1 : 0,
          errorCode: (i.errorCode as UploadErrorCode | null) ?? null,
          errorText: i.errorCode ? ERROR_TEXT[i.errorCode as UploadErrorCode] ?? ERROR_TEXT.unknown : null,
          attempts: i.attempts, nextAttemptAt: i.nextAttemptAt, sizeBytes: i.sizeBytes, width: i.width, height: i.height,
          createdAt: i.createdAt, hasPhoto: i.blob !== null,
        }
      }),
    }
    for (const l of listeners) l(snapshot)
  }
  const emitSoon = () => { if (!disposed) void refresh().catch(() => {}) }
  const emitProgress = () => { const t = now(); if (t - lastProgressEmit >= 200) { lastProgressEmit = t; emitSoon() } }

  // ── store writes that must not resurrect a cancelled photo ─────────────────
  async function patch(id: string, p: Partial<QueueItem>): Promise<boolean> {
    if (cancelled.has(id) && p.state !== 'cancelling') return false
    const ok = await store.update(scope, id, { ...p, updatedAt: now() })
    emitSoon()
    return ok
  }

  // ── failure handling ───────────────────────────────────────────────────────
  async function fail(item: QueueItem, code: UploadErrorCode, status: number | null) {
    const disp = dispositionOf(code)
    log('upload_failed', { id: short(item.id), code, status, disposition: disp })
    if (disp === 'final') {
      await patch(item.id, { state: 'rejected', errorCode: code, errorStatus: status, blob: null, nextAttemptAt: null })
      return
    }
    if (disp === 'pause_auth') {
      // The photo stays queued and everything pauses briefly. A change of the signed-in user (signing in again) lifts the pause at once.
      authPausedUntil = now() + POLL_WAKE_MS
      await patch(item.id, { state: 'queued', errorCode: code, errorStatus: status, nextAttemptAt: null })
      return
    }
    // retry
    if (code === 'uploads_disabled') {
      await patch(item.id, { state: 'queued', errorCode: code, errorStatus: status, nextAttemptAt: now() + DISABLED_DELAY_MS })
      return
    }
    if (!deps.isOnline()) {
      // No connection is not the photo's fault: keep it queued without spending an attempt; the online event resumes it.
      await patch(item.id, { state: 'queued', errorCode: code, errorStatus: status, nextAttemptAt: null })
      return
    }
    const attempts = item.attempts + 1
    if (attempts >= limits.maxAttempts) {
      await patch(item.id, { state: 'failed', attempts, errorCode: code, errorStatus: status, nextAttemptAt: null })
      return
    }
    await patch(item.id, {
      state: 'queued', attempts, errorCode: code, errorStatus: status,
      nextAttemptAt: now() + backoffMs(attempts, { baseMs: limits.backoffBaseMs, capMs: limits.backoffCapMs, random }),
    })
  }

  async function markDone(item: QueueItem) {
    await patch(item.id, { state: 'done', blob: null, doneAt: now(), errorCode: null, errorStatus: null, nextAttemptAt: null })
    progress.delete(item.id)
    log('upload_done', { id: short(item.id) })
  }

  const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    const h = timers.set(() => { signal.removeEventListener('abort', onAbort); resolve() }, ms)
    const onAbort = () => { timers.clear(h); resolve() }
    signal.addEventListener('abort', onAbort, { once: true })
  })

  // ── one photo ──────────────────────────────────────────────────────────────
  async function uploadStage(item: QueueItem, signal: AbortSignal): Promise<'next' | 'stop'> {
    if (!item.blob) { await fail(item, 'invalid', null); return 'stop' }
    let current = item
    for (;;) {
      if (signal.aborted || cancelled.has(item.id)) return 'stop'
      let init: Awaited<ReturnType<EvidenceApi['init']>>
      try {
        init = await api.init(current.jobId, { workspaceId: scope.workspaceId, submissionId: current.id, contentType: 'image/jpeg', sizeBytes: current.sizeBytes })
      } catch (e) {
        if (cancelled.has(item.id)) { await store.remove(scope, item.id); cancelled.delete(item.id); emitSoon(); return 'stop' }
        const c = classifyApiError(e)
        await fail(current, c.code, c.status)
        return 'stop'
      }
      if (cancelled.has(item.id)) { await remoteCancel({ ...current, fileId: init.file.id }); return 'stop' }
      await patch(item.id, { state: 'uploading', fileId: init.file.id, errorCode: null, errorStatus: null })
      current = { ...current, fileId: init.file.id }

      if (!init.upload) {
        // The server already knows this file beyond PENDING (a retry after a lost response, or another tab).
        if (init.file.status === 'AVAILABLE') { await markDone(current); return 'stop' }
        if (init.file.status === 'REJECTED') { await fail(current, 'server_rejected', null); return 'stop' }
        return 'next'
      }

      const expiresAt = Date.parse(init.upload.expiresAt)
      if (Number.isFinite(expiresAt) && expiresAt - now() < limits.presignSafetyMs) {
        // The link would expire during the upload: ask for a fresh one (counts against the single re-init).
        if (current.reinits < 1) { current = { ...current, reinits: current.reinits + 1 }; await patch(item.id, { reinits: current.reinits }); continue }
      }

      progress.set(item.id, { loaded: 0, total: current.sizeBytes })
      const out = await deps.put({
        url: init.upload.url, contentType: 'image/jpeg', body: current.blob!, signal, timeoutMs: limits.putTimeoutMs,
        onProgress: (loaded, total) => { progress.set(item.id, { loaded, total }); emitProgress() },
      })
      // init.upload (the signed URL and headers) goes out of scope here and is never retained.
      if (out.aborted || signal.aborted || cancelled.has(item.id)) return 'stop'
      const code = classifyPutStatus(out.status, out)
      if (code === null) {
        await patch(item.id, { state: 'processing', errorCode: null, errorStatus: null, nextAttemptAt: null })
        return 'next'
      }
      if (code === 'upload_rejected' && out.status === 403 && current.reinits < 1) {
        current = { ...current, reinits: current.reinits + 1 }
        await patch(item.id, { reinits: current.reinits })
        log('reinit_after_403', { id: short(item.id) })
        continue
      }
      await fail(current, code, out.status)
      return 'stop'
    }
  }

  async function processingStage(item: QueueItem, signal: AbortSignal): Promise<void> {
    if (!item.fileId) { await patch(item.id, { state: 'queued' }); return }
    try {
      await api.complete(item.jobId, item.fileId, scope.workspaceId)
    } catch (e) {
      if (isUploadMissing(e)) {
        // The object never arrived (or the link expired before it did): upload again, once.
        if (item.reinits < 2) { await patch(item.id, { state: 'queued', reinits: item.reinits + 1, nextAttemptAt: now() }); return }
        await fail(item, 'upload_rejected', 409)
        return
      }
      const c = classifyApiError(e)
      await fail(item, c.code, c.status)
      return
    }
    const deadline = now() + limits.pollDeadlineMs
    for (let i = 0; ; i++) {
      if (signal.aborted || cancelled.has(item.id)) return
      let st: string
      try {
        st = (await api.status(item.jobId, item.fileId, scope.workspaceId)).file.status
      } catch (e) {
        const c = classifyApiError(e)
        await fail(item, c.code, c.status)
        return
      }
      if (st === 'AVAILABLE') { await markDone(item); return }
      if (st === 'REJECTED') { await fail(item, 'server_rejected', null); return }
      if (now() >= deadline) {
        // Still processing server-side. Not a failure: look again later without spending an attempt.
        await patch(item.id, { state: 'processing', nextAttemptAt: now() + POLL_WAKE_MS })
        return
      }
      await sleep(limits.pollIntervalMs[Math.min(i, limits.pollIntervalMs.length - 1)], signal)
    }
  }

  async function remoteCancel(item: QueueItem) {
    if (!item.fileId) { await store.remove(scope, item.id); cancelled.delete(item.id); emitSoon(); return }
    try {
      await api.cancel(item.jobId, item.fileId, scope.workspaceId)
    } catch (e) {
      const c = classifyApiError(e)
      if (c.status === 409) {
        // Finished before the cancel arrived: it is evidence now and is not removable here.
        cancelled.delete(item.id)
        await store.update(scope, item.id, { state: 'done', blob: null, doneAt: now(), errorCode: null, errorStatus: null, nextAttemptAt: null, updatedAt: now() })
        emitSoon()
        return
      }
      if (c.status === 404 || c.status === 403) { await store.remove(scope, item.id); cancelled.delete(item.id); emitSoon(); return }
      // Could not reach the server: keep the tombstone and try again later; stop after the attempt budget (the server sweeper reaps it).
      const attempts = item.attempts + 1
      if (attempts >= limits.maxAttempts) { await store.remove(scope, item.id); cancelled.delete(item.id); emitSoon(); return }
      await store.update(scope, item.id, { state: 'cancelling', blob: null, attempts, nextAttemptAt: now() + backoffMs(attempts, { baseMs: limits.backoffBaseMs, capMs: limits.backoffCapMs, random }), updatedAt: now() })
      return
    }
    await store.remove(scope, item.id)
    cancelled.delete(item.id)
    progress.delete(item.id)
    emitSoon()
  }

  async function run(item: QueueItem, ctl: AbortController) {
    try {
      if (cancelled.has(item.id) && !item.fileId) { await store.remove(scope, item.id); cancelled.delete(item.id); emitSoon(); return }
      if (item.state === 'cancelling') { await remoteCancel(item); return }
      let cur = item
      if (cur.state === 'queued' || cur.state === 'uploading') {
        if ((await uploadStage(cur, ctl.signal)) === 'stop') return
        const fresh = await store.get(scope, item.id)
        if (!fresh || cancelled.has(item.id)) return
        cur = fresh
      }
      if (cur.state === 'processing') await processingStage(cur, ctl.signal)
    } catch (e) {
      log('engine_error', { id: short(item.id), name: (e as Error)?.name ?? 'Error' })
      // A storage failure (e.g. the database being closed) must not wedge the item: try again later.
      await store.update(scope, item.id, { nextAttemptAt: now() + POLL_WAKE_MS, updatedAt: now() }).catch(() => {})
    }
  }

  // ── scheduling ─────────────────────────────────────────────────────────────
  const isDue = (i: QueueItem) => ACTIVE.has(i.state) && (i.nextAttemptAt === null ? true : i.nextAttemptAt <= now())

  /** Start whatever is due, up to the concurrency limit. Re-entrant calls coalesce into one more pass. */
  function pump(): Promise<void> {
    if (disposed) return Promise.resolve()
    if (current) { pumpAgain = true; return current }
    current = (async () => {
      try {
        // A kick that arrives while we are between passes (including while scheduling the wake-up) must not be lost.
        do {
          pumpAgain = false
          await refresh()
          const user = deps.sessionUserId()
          if (user !== lastUser) { lastUser = user; authPausedUntil = 0 }
          if (sessionOk() && deps.isOnline() && now() >= authPausedUntil) {
            const items = await store.list(scope)
            const due = items.filter((i) => isDue(i) && !inflight.has(i.id) && (lockedUntil.get(i.id) ?? 0) <= now())
            for (const item of due) {
              if (inflight.size >= limits.concurrency) break
              startItem(item)
            }
          }
          await scheduleWake()
        } while (pumpAgain && !disposed)
      } finally {
        current = null
      }
    })()
    return current
  }

  function startItem(item: QueueItem) {
    const ctl = new AbortController()
    const task = (async () => {
      const locked = deps.lock ? await deps.lock(`acaos-evidence:${sKey}:${item.id}`, () => run(item, ctl)) : (await run(item, ctl), { ran: true as const, value: undefined })
      if (!locked.ran) { lockedUntil.set(item.id, now() + 10_000); log('skipped_locked', { id: short(item.id) }) }
    })().finally(() => {
      inflight.delete(item.id)
      progress.delete(item.id)
      if (!disposed) void pump()
    })
    inflight.set(item.id, { abort: ctl, done: task })
  }

  async function scheduleWake() {
    if (wake) { timers.clear(wake); wake = null }
    if (disposed) return
    const items = await store.list(scope)
    const times = items.filter((i) => ACTIVE.has(i.state) && !inflight.has(i.id))
      .map((i) => Math.max(i.nextAttemptAt ?? 0, lockedUntil.get(i.id) ?? 0)).filter((t) => t > 0)
    if (authPausedUntil > now() && items.some((i) => ACTIVE.has(i.state))) times.push(authPausedUntil)
    if (!times.length) return
    const delay = Math.max(250, Math.min(...times) - now())
    wake = timers.set(() => { wake = null; void pump() }, delay)
  }

  const kick = () => { if (started && !disposed) void pump() }

  /**
   * The connection came back or the app returned to the foreground: whatever was waiting out a retry
   * delay should go now. A server that said "uploads are off" keeps its long pause.
   */
  async function resume() {
    if (!started || disposed) return
    for (const i of await store.list(scope)) {
      if (ACTIVE.has(i.state) && i.nextAttemptAt !== null && i.errorCode !== 'uploads_disabled') await store.update(scope, i.id, { nextAttemptAt: null, updatedAt: now() })
    }
    lockedUntil.clear()
    authPausedUntil = 0
    void pump()
  }

  // ── public API ─────────────────────────────────────────────────────────────
  return {
    async start() {
      if (started || disposed) return
      started = true
      // Finished items keep only their metadata; drop the old ones.
      const cutoff = now() - limits.doneRetentionMs
      for (const i of await store.list(scope)) if (i.state === 'done' && (i.doneAt ?? i.updatedAt) < cutoff) await store.remove(scope, i.id)
      detach = deps.attach ? deps.attach(() => { void resume() }) : null
      tick = timers.set(function loop() { void pump(); tick = timers.set(loop, TICK_MS) }, TICK_MS)
      await pump()
    },

    /** Process and queue a photo. Serialised: one photo at a time, to bound memory on a phone. */
    enqueue(o: { jobId: string; file: Blob; allowDuplicate?: boolean }): Promise<EnqueueResult> {
      const job = async (): Promise<EnqueueResult> => {
        if (disposed || !sessionOk()) return { ok: false, reason: 'wrong_session', message: 'Sign in again to add photos.' }
        let prepared: PreparedImage
        try {
          prepared = await deps.prepare(o.file)
        } catch (e) {
          if (e instanceof ImageError) return { ok: false, reason: e.code, message: e.message }
          return { ok: false, reason: 'unexpected', message: 'That photo could not be prepared. Try again.' }
        }
        if (disposed || !sessionOk()) return { ok: false, reason: 'wrong_session', message: 'Sign in again to add photos.' } // the session may have changed while the photo was processed
        const t = now()
        const item: QueueItem = {
          id: newId(), userId: scope.userId, workspaceId: scope.workspaceId, jobId: o.jobId, state: 'queued',
          blob: prepared.blob, sizeBytes: prepared.sizeBytes, contentType: 'image/jpeg', width: prepared.width, height: prepared.height, sha256: prepared.sha256,
          createdAt: t, updatedAt: t, attempts: 0, reinits: 0, nextAttemptAt: null, fileId: null, errorCode: null, errorStatus: null, doneAt: null,
        }
        let r: Awaited<ReturnType<QueueStore['add']>>
        try { r = await store.add(scope, item, { limits, allowDuplicate: o.allowDuplicate }) } catch {
          return { ok: false, reason: 'storage_full', message: ERROR_TEXT.storage_full }
        }
        if (!r.ok) {
          const reason = r.reason === 'exists' ? 'unexpected' : r.reason
          const message = reason === 'duplicate' ? 'That photo is already waiting to upload for this job.'
            : reason === 'queue_full' ? 'Too many photos are waiting to upload. Wait for some to finish.'
            : reason === 'storage_full' ? ERROR_TEXT.storage_full : 'That photo could not be added.'
          return { ok: false, reason, message }
        }
        emitSoon()
        kick()
        return { ok: true, id: item.id }
      }
      const next = enqueueChain.then(job, job)
      enqueueChain = next.catch(() => {})
      return next
    },

    /** Manual retry of a failed photo: resets its attempt budget. */
    async retry(id: string) {
      const it = await store.get(scope, id)
      if (!it || it.state !== 'failed' || !it.blob) return false
      await patch(id, { state: 'queued', attempts: 0, reinits: 0, nextAttemptAt: null, errorCode: null, errorStatus: null })
      kick()
      return true
    },

    /** Remove a photo. If the server already knows it, the unfinished upload is cancelled there too. */
    async cancel(id: string) {
      // Abort first, synchronously, so the person sees the upload stop at once.
      if (inflight.has(id)) { cancelled.add(id); inflight.get(id)!.abort.abort() }
      const it = await store.get(scope, id)
      if (!it) { cancelled.delete(id); return }
      if (it.state === 'done' || it.state === 'rejected') { await store.remove(scope, id); emitSoon(); return }
      cancelled.add(id)
      inflight.get(id)?.abort.abort()
      if (it.fileId) {
        // The server knows this upload: mark it for cancellation there (retried until it succeeds).
        await store.update(scope, id, { state: 'cancelling', blob: null, attempts: 0, nextAttemptAt: null, updatedAt: now() })
        emitSoon()
        kick()
      } else if (!inflight.has(id)) {
        await store.remove(scope, id); cancelled.delete(id); emitSoon()
      }
      // else: an `init` is in flight; uploadStage sees `cancelled` when it returns and cancels the new file.
    },

    /** Remove a finished or final-failed record from the list (it holds no photo). */
    async dismiss(id: string) {
      const it = await store.get(scope, id)
      if (it && (it.state === 'done' || it.state === 'rejected')) { await store.remove(scope, id); emitSoon() }
    },

    /** Photos that still exist only on this phone: show this before signing out or switching workspace. */
    async unsent(): Promise<{ count: number; bytes: number }> {
      const items = (await store.list(scope)).filter((i) => UNSENT.has(i.state) && i.blob)
      return { count: items.length, bytes: items.reduce((n, i) => n + i.sizeBytes, 0) }
    },

    async preview(id: string): Promise<Blob | null> { return (await store.get(scope, id))?.blob ?? null },

    getSnapshot: () => snapshot,
    subscribe(l: (s: Snapshot) => void) { listeners.add(l); l(snapshot); return () => { listeners.delete(l) } },
    kick,
    resume,

    /** Wait until nothing is running (tests, and "finish before sign-out"). */
    async whenSettled() {
      for (let quiet = 0; quiet < 3;) {
        if (current) { await current; quiet = 0 }
        else if (inflight.size) { await Promise.allSettled([...inflight.values()].map((v) => v.done)); quiet = 0 }
        else { await Promise.resolve(); quiet++ }
      }
    },

    /** Stop all work and release timers and listeners. Queued photos stay on disk for the next session. */
    dispose() {
      disposed = true
      for (const v of inflight.values()) v.abort.abort()
      if (wake) timers.clear(wake)
      if (tick) timers.clear(tick)
      detach?.()
      listeners.clear()
    },
  }
}

export type UploadEngine = ReturnType<typeof createUploadEngine>
