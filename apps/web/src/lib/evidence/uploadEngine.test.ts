import { describe, it, expect, afterEach, vi } from 'vitest'
import { createUploadEngine, type EvidenceApi, type EngineDeps, type LockFn } from './uploadEngine'
import { MemoryQueueStore, type QueueItem, type Scope } from './queueStore'
import { item as storeItem } from './queueStoreContract'
import { ImageError, type PreparedImage } from './imagePipeline'
import { EVIDENCE_LIMITS } from './limits'
import type { PutFn, PutOutcome } from './uploadTransport'

const SCOPE: Scope = { userId: 'user-a', workspaceId: 'ws-1' }
// Real timers with tiny delays: the engine's waits are the thing under test.
const LIMITS = { ...EVIDENCE_LIMITS, backoffBaseMs: 4, backoffCapMs: 16, pollIntervalMs: [1], pollDeadlineMs: 250, presignSafetyMs: 30_000, maxAttempts: 4, concurrency: 2 }
const SIGNED_URL = 'https://storage.example.test/bucket/ws/ws-1/job/job-1/upload/SECRETKEY?X-Amz-Signature=SIGSECRET&X-Amz-Credential=AKIDSECRET'
const OK: PutOutcome = { status: 200, timedOut: false, networkError: false, aborted: false }
const NET: PutOutcome = { status: 0, timedOut: false, networkError: true, aborted: false }
const status = (n: number): PutOutcome => ({ status: n, timedOut: false, networkError: false, aborted: false })
const apiErr = (statusCode: number | undefined, message: string) => Object.assign(new Error(message), statusCode === undefined ? {} : { status: statusCode })
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(cond: () => boolean | Promise<boolean>, ms = 3000) {
  const t0 = Date.now()
  while (!(await cond())) { if (Date.now() - t0 > ms) throw new Error('timed out waiting for condition'); await wait(2) }
}

class FakeApi implements EvidenceApi {
  calls: Array<{ op: string; jobId: string; fileId?: string; body?: unknown }> = []
  files = new Map<string, { id: string; status: string; sizeBytes: number }>()
  bySubmission = new Map<string, string>()
  nextInit: Array<Error | 'ok'> = []
  nextComplete: Array<Error | 'ok'> = []
  nextStatus: Array<Error | string> = []
  nextCancel: Array<Error | 'ok'> = []
  defaultStatus = 'AVAILABLE'
  initDelayMs = 0
  statusDelayMs = 0
  expiresInMs = 300_000
  async init(jobId: string, body: { submissionId: string; sizeBytes: number; workspaceId: string; contentType: string }) {
    this.calls.push({ op: 'init', jobId, body })
    if (this.initDelayMs) await wait(this.initDelayMs)
    const next = this.nextInit.shift()
    if (next instanceof Error) throw next
    let id = this.bySubmission.get(body.submissionId)
    if (!id) { id = `file-${this.files.size + 1}`; this.bySubmission.set(body.submissionId, id); this.files.set(id, { id, status: 'PENDING', sizeBytes: body.sizeBytes }) }
    const f = this.files.get(id)!
    if (f.status !== 'PENDING') return { file: { id, status: f.status, kind: 'PHOTO' } }
    return { file: { id, status: 'PENDING', kind: 'PHOTO' }, upload: { method: 'PUT' as const, url: SIGNED_URL, headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(body.sizeBytes) }, expiresAt: new Date(Date.now() + this.expiresInMs).toISOString() } }
  }
  async complete(jobId: string, fileId: string) {
    this.calls.push({ op: 'complete', jobId, fileId })
    const next = this.nextComplete.shift()
    if (next instanceof Error) throw next
    return { file: { id: fileId, status: 'PENDING', kind: 'PHOTO' }, processing: true }
  }
  async status(jobId: string, fileId: string) {
    this.calls.push({ op: 'status', jobId, fileId })
    if (this.statusDelayMs) await wait(this.statusDelayMs)
    const next = this.nextStatus.shift()
    if (next instanceof Error) throw next
    const st = next ?? this.defaultStatus
    const f = this.files.get(fileId); if (f) f.status = st
    return { file: { status: st } }
  }
  async cancel(jobId: string, fileId: string) {
    this.calls.push({ op: 'cancel', jobId, fileId })
    const next = this.nextCancel.shift()
    if (next instanceof Error) throw next
    return { file: { id: fileId, status: 'REJECTED', kind: 'PHOTO' } }
  }
  count(op: string) { return this.calls.filter((c) => c.op === op).length }
}

type Harness = ReturnType<typeof harness>
const engines: Array<{ dispose: () => void }> = []
afterEach(() => { while (engines.length) engines.pop()!.dispose() })

let photoCounter = 0
const preparedFor = (_file: Blob): PreparedImage => {
  const n = ++photoCounter
  return { blob: new Blob([new Uint8Array(500 + n)], { type: 'image/jpeg' }), contentType: 'image/jpeg', sizeBytes: 500 + n, width: 800, height: 600, sha256: String(n).padStart(64, '0') }
}

function harness(over: Partial<EngineDeps> & { putOutcomes?: Array<PutOutcome | (() => Promise<PutOutcome>)>; scope?: Scope } = {}) {
  const store = (over.store as MemoryQueueStore) ?? new MemoryQueueStore()
  const api = (over.api as FakeApi) ?? new FakeApi()
  const state = { online: true, user: over.scope?.userId ?? SCOPE.userId as string | null }
  const logs: string[] = []
  const puts: Array<{ url: string; contentType: string; size: number; signal: AbortSignal }> = []
  let inFlightPuts = 0, maxInFlightPuts = 0
  const outcomes = over.putOutcomes ?? []
  const put: PutFn = async (a) => {
    puts.push({ url: a.url, contentType: a.contentType, size: a.body.size, signal: a.signal })
    inFlightPuts++; maxInFlightPuts = Math.max(maxInFlightPuts, inFlightPuts)
    try {
      a.onProgress(a.body.size / 2, a.body.size)
      const next = outcomes.shift()
      if (typeof next === 'function') return await next()
      return next ?? OK
    } finally { inFlightPuts-- }
  }
  const engine = createUploadEngine({
    scope: over.scope ?? SCOPE, store, api, put,
    prepare: over.prepare ?? (async (f) => preparedFor(f)),
    sessionUserId: () => state.user, isOnline: () => state.online,
    limits: LIMITS, log: (e, d) => logs.push(`${e} ${JSON.stringify(d ?? {})}`),
    random: () => 0.5, ...over,
  })
  engines.push(engine)
  return { engine, store, api, state, logs, puts, maxPuts: () => maxInFlightPuts }
}
const photo = () => new Blob([new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3])])
const items = (h: Harness) => h.store.list(SCOPE)
const stateOf = async (h: Harness, id: string) => (await h.store.get(SCOPE, id))?.state

describe('happy path', () => {
  it('queues, uploads, completes and finishes; the photo is dropped and nothing sensitive is persisted or logged', async () => {
    const h = harness()
    h.api.nextStatus = ['PENDING', 'AVAILABLE']
    await h.engine.start()
    const r = await h.engine.enqueue({ jobId: 'job-1', file: photo() })
    expect(r.ok).toBe(true)
    const id = (r as { id: string }).id
    await until(async () => (await stateOf(h, id)) === 'done')
    const done = (await h.store.get(SCOPE, id))!
    expect(done.blob).toBeNull()
    expect(done.fileId).toBe('file-1')
    expect(h.api.calls.map((c) => c.op)).toEqual(['init', 'complete', 'status', 'status'])
    expect((h.api.calls[0].body as { submissionId: string }).submissionId).toBe(id)
    expect(h.puts).toHaveLength(1)
    expect(h.puts[0].contentType).toBe('image/jpeg')
    // the signed URL / credentials exist only in memory for the attempt
    const persisted = JSON.stringify([...h.store.data.values()].map((m) => [...m.values()].map((i) => ({ ...i, blob: i.blob ? 'blob' : null }))))
    const everything = persisted + h.logs.join('\n') + JSON.stringify(h.engine.getSnapshot())
    for (const secret of ['X-Amz', 'SIGSECRET', 'AKIDSECRET', 'SECRETKEY', 'https://', 'Authorization', 'Bearer']) expect(everything).not.toContain(secret)
  })

  it('exposes progress and a readable snapshot, and previews the stored photo', async () => {
    const h = harness({ putOutcomes: [async () => { await wait(40); return OK }] })
    await h.engine.start()
    const seen: number[] = []
    h.engine.subscribe((s) => { const it = s.items[0]; if (it) seen.push(it.progress) })
    const r = await h.engine.enqueue({ jobId: 'job-1', file: photo() }) as { id: string }
    expect(await h.engine.preview(r.id)).toBeInstanceOf(Blob)
    await until(async () => (await stateOf(h, r.id)) === 'done')
    expect(Math.max(...seen)).toBe(1)
    expect(h.engine.getSnapshot().items[0]).toMatchObject({ state: 'done', hasPhoto: false, errorText: null })
  })
})

describe('idempotency and duplicates', () => {
  it('retries use the same submissionId, so the server only ever sees one file', async () => {
    const h = harness({ putOutcomes: [NET, status(503), OK] })
    await h.engine.start()
    const r = await h.engine.enqueue({ jobId: 'job-1', file: photo() }) as { id: string }
    await until(async () => (await stateOf(h, r.id)) === 'done')
    const inits = h.api.calls.filter((c) => c.op === 'init').map((c) => (c.body as { submissionId: string }).submissionId)
    expect(inits.length).toBeGreaterThanOrEqual(3)
    expect(new Set(inits)).toEqual(new Set([r.id]))
    expect(h.api.files.size).toBe(1)
    expect(await items(h)).toHaveLength(1)
  })

  it('a double tap on the same photo adds it once; the same photo for another job is allowed', async () => {
    const same = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 9])])
    let sha = 'dup'.padEnd(64, '0')
    const h = harness({ prepare: async () => ({ blob: new Blob([new Uint8Array(600)], { type: 'image/jpeg' }), contentType: 'image/jpeg' as const, sizeBytes: 600, width: 1, height: 1, sha256: sha }) })
    // keep everything queued so we can see the queue itself
    h.state.online = false
    await h.engine.start()
    const [a, b] = await Promise.all([h.engine.enqueue({ jobId: 'job-1', file: same }), h.engine.enqueue({ jobId: 'job-1', file: same })])
    expect([a.ok, b.ok].sort()).toEqual([false, true])
    expect([a, b].find((x) => !x.ok)).toMatchObject({ reason: 'duplicate' })
    expect((await h.engine.enqueue({ jobId: 'job-2', file: same })).ok).toBe(true)
    expect((await h.engine.enqueue({ jobId: 'job-1', file: same, allowDuplicate: true })).ok).toBe(true)
    sha = 'other'.padEnd(64, '0')
    expect((await h.engine.enqueue({ jobId: 'job-1', file: same })).ok).toBe(true)
    expect(await items(h)).toHaveLength(4)
    expect(h.api.calls).toHaveLength(0)
  })

  it('a server that already finished the file (lost response) completes the item without a second upload', async () => {
    const h = harness()
    h.api.bySubmission.set('will-be-set', 'file-9')
    await h.engine.start()
    h.state.online = false
    const r = await h.engine.enqueue({ jobId: 'job-1', file: photo() }) as { id: string }
    h.api.files.set('file-9', { id: 'file-9', status: 'AVAILABLE', sizeBytes: 1 })
    h.api.bySubmission.set(r.id, 'file-9')
    h.state.online = true
    h.engine.kick()
    await until(async () => (await stateOf(h, r.id)) === 'done')
    expect(h.puts).toHaveLength(0)
    expect(h.api.count('complete')).toBe(0)
  })
})

describe('retries, backoff and offline', () => {
  it('retries a network failure with backoff and succeeds, clearing the error', async () => {
    const h = harness({ putOutcomes: [NET, OK] })
    await h.engine.start()
    const r = await h.engine.enqueue({ jobId: 'job-1', file: photo() }) as { id: string }
    await until(async () => (await h.store.get(SCOPE, r.id))?.attempts === 1)
    const mid = (await h.store.get(SCOPE, r.id))!
    expect(mid.errorCode).toBe('network')
    expect(mid.nextAttemptAt).toBeGreaterThan(0)
    await until(async () => (await stateOf(h, r.id)) === 'done')
    expect((await h.store.get(SCOPE, r.id))!.errorCode).toBeNull()
  })

  it('does nothing while offline, spends no attempts on failures that happen offline, and resumes when back online', async () => {
    const h = harness({ putOutcomes: [async () => { h.state.online = false; return NET }, OK] })
    await h.engine.start()
    const r = await h.engine.enqueue({ jobId: 'job-1', file: photo() }) as { id: string }
    await until(async () => (await h.store.get(SCOPE, r.id))?.errorCode === 'network')
    const stuck = (await h.store.get(SCOPE, r.id))!
    expect(stuck.attempts).toBe(0)
    expect(stuck.nextAttemptAt).toBeNull()
    expect(stuck.state).toBe('queued')
    const callsWhileOffline = h.api.calls.length
    h.engine.kick(); await wait(30)
    expect(h.api.calls.length).toBe(callsWhileOffline)
    h.state.online = true
    h.engine.kick()
    await until(async () => (await stateOf(h, r.id)) === 'done')
  })

  it('stops automatic retries after the attempt budget; a manual retry resets it and succeeds', async () => {
    const h = harness({ putOutcomes: [NET, NET, NET, NET] })
    await h.engine.start()
    const r = await h.engine.enqueue({ jobId: 'job-1', file: photo() }) as { id: string }
    await until(async () => (await stateOf(h, r.id)) === 'failed')
    const failed = (await h.store.get(SCOPE, r.id))!
    expect(failed.attempts).toBe(LIMITS.maxAttempts)
    expect(failed.blob).not.toBeNull()
    const before = h.puts.length
    h.engine.kick(); await wait(40)
    expect(h.puts.length).toBe(before)
    expect(await h.engine.retry(r.id)).toBe(true)
    await until(async () => (await stateOf(h, r.id)) === 'done')
    expect(await h.engine.retry(r.id)).toBe(false)
  })

  it('retries a 5xx and a rate limit from the API', async () => {
    const h = harness()
    h.api.nextInit = [apiErr(503 - 3, 'Bad gateway'), apiErr(429, 'Too many unfinished uploads; complete them or wait for them to expire')]
    await h.engine.start()
    const r = await h.engine.enqueue({ jobId: 'job-1', file: photo() }) as { id: string }
    await until(async () => (await stateOf(h, r.id)) === 'done')
    expect(h.api.count('init')).toBe(3)
  })

  it('uploads-disabled is a long pause that costs no attempts', async () => {
    const h = harness()
    h.api.nextInit = [apiErr(503, 'Evidence uploads are not enabled')]
    await h.engine.start()
    const r = await h.engine.enqueue({ jobId: 'job-1', file: photo() }) as { id: string }
    await until(async () => (await h.store.get(SCOPE, r.id))?.errorCode === 'uploads_disabled')
    const it = (await h.store.get(SCOPE, r.id))!
    expect(it.attempts).toBe(0)
    expect(it.nextAttemptAt! - Date.now()).toBeGreaterThan(60_000)
    expect(it.state).toBe('queued')
  })
})

describe('foreground and connectivity resume', () => {
  const SLOW = { ...LIMITS, backoffBaseMs: 60_000, backoffCapMs: 120_000 }
  it('resume() (online / foreground) skips the retry delay', async () => {
    let resume!: () => void
    const h = harness({ limits: SLOW, putOutcomes: [NET, OK], attach: (r) => { resume = r; return () => {} } })
    await h.engine.start()
    const r = await h.engine.enqueue({ jobId: 'job-1', file: photo() }) as { id: string }
    await until(async () => (await h.store.get(SCOPE, r.id))?.errorCode === 'network')
    const waiting = (await h.store.get(SCOPE, r.id))!
    expect(waiting.nextAttemptAt! - Date.now()).toBeGreaterThan(10_000)
    await wait(30)
    expect(await stateOf(h, r.id)).toBe('queued')       // really waiting out the delay
    resume()
    await until(async () => (await stateOf(h, r.id)) === 'done')
  })

  it('an "uploads are off" pause is not cut short by foregrounding', async () => {
    let resume!: () => void
    const h = harness({ attach: (r) => { resume = r; return () => {} } })
    h.api.nextInit = [apiErr(503, 'Evidence uploads are not enabled')]
    await h.engine.start()
    const r = await h.engine.enqueue({ jobId: 'job-1', file: photo() }) as { id: string }
    await until(async () => (await h.store.get(SCOPE, r.id))?.errorCode === 'uploads_disabled')
    resume(); await wait(50)
    expect(h.api.count('init')).toBe(1)
    expect((await h.store.get(SCOPE, r.id))!.nextAttemptAt! - Date.now()).toBeGreaterThan(60_000)
  })

  it('stops listening after dispose', async () => {
    const detach = vi.fn()
    const h = harness({ attach: () => detach })
    await h.engine.start()
    h.engine.dispose()
    expect(detach).toHaveBeenCalledTimes(1)
  })
})

describe('storage rejections', () => {
  it('a storage 403 triggers exactly one fresh init and then succeeds', async () => {
    const h = harness({ putOutcomes: [status(403), OK] })
    await h.engine.start()
    const r = await h.engine.enqueue({ jobId: 'job-1', file: photo() }) as { id: string }
    await until(async () => (await stateOf(h, r.id)) === 'done')
    expect(h.api.count('init')).toBe(2)
    expect(h.puts).toHaveLength(2)
  })

  it('a second storage 403 is final: the photo is rejected and its bytes are dropped', async () => {
    const h = harness({ putOutcomes: [status(403), status(403)] })
    await h.engine.start()
    const r = await h.engine.enqueue({ jobId: 'job-1', file: photo() }) as { id: string }
    await until(async () => (await stateOf(h, r.id)) === 'rejected')
    const it = (await h.store.get(SCOPE, r.id))!
    expect(it.errorCode).toBe('upload_rejected')
    expect(it.blob).toBeNull()
    expect(h.api.count('init')).toBe(2)
    expect(h.api.count('complete')).toBe(0)
  })

  it('re-signs first when the link is about to expire (slow response), once', async () => {
    const h = harness()
    h.api.expiresInMs = 5_000
    await h.engine.start()
    const r = await h.engine.enqueue({ jobId: 'job-1', file: photo() }) as { id: string }
    await until(async () => (await stateOf(h, r.id)) === 'done')
    expect(h.api.count('init')).toBe(2)
  })

  it('a wrong phone clock cannot use up the one re-sign meant for a real 403', async () => {
    const h = harness({ putOutcomes: [status(403), OK] })
    h.api.expiresInMs = 5_000                      // looks about to expire (as it would with a skewed clock)
    await h.engine.start()
    const r = await h.engine.enqueue({ jobId: 'job-1', file: photo() }) as { id: string }
    await until(async () => (await stateOf(h, r.id)) === 'done')
    expect(h.api.count('init')).toBe(3)            // one for the apparent expiry, one for the real 403
  })

  it('"upload not found" from complete sends the photo back to upload, then gives up', async () => {
    const h = harness()
    h.api.nextComplete = [apiErr(409, 'Upload not found; it may not have finished or its link has expired')]
    await h.engine.start()
    const r = await h.engine.enqueue({ jobId: 'job-1', file: photo() }) as { id: string }
    await until(async () => (await stateOf(h, r.id)) === 'done')
    expect(h.puts).toHaveLength(2)

    const h2 = harness()
    const missing = apiErr(409, 'Upload not found; it may not have finished or its link has expired')
    h2.api.nextComplete = [missing, missing, missing]
    await h2.engine.start()
    const r2 = await h2.engine.enqueue({ jobId: 'job-1', file: photo() }) as { id: string }
    await until(async () => (await stateOf(h2, r2.id)) === 'rejected')
    expect((await h2.store.get(SCOPE, r2.id))!.errorCode).toBe('upload_rejected')
  })

  it('a file the worker rejects ends as rejected', async () => {
    const h = harness()
    h.api.defaultStatus = 'REJECTED'
    await h.engine.start()
    const r = await h.engine.enqueue({ jobId: 'job-1', file: photo() }) as { id: string }
    await until(async () => (await stateOf(h, r.id)) === 'rejected')
    expect((await h.store.get(SCOPE, r.id))!.errorCode).toBe('server_rejected')
  })

  it('processing that outlasts the poll window is not a failure: it keeps checking later without spending attempts', async () => {
    const h = harness()
    h.api.defaultStatus = 'PENDING'
    await h.engine.start()
    const r = await h.engine.enqueue({ jobId: 'job-1', file: photo() }) as { id: string }
    await until(async () => { const i = await h.store.get(SCOPE, r.id); return i?.state === 'processing' && i.nextAttemptAt !== null })
    const it = (await h.store.get(SCOPE, r.id))!
    expect(it.attempts).toBe(0)
    expect(it.errorCode).toBeNull()
    expect(h.puts).toHaveLength(1)
  })
})

describe('final API failures stop retrying', () => {
  it.each([
    [403, 'Assignment revoked', 'forbidden'],
    [409, 'Job is not active', 'job_closed'],
    [409, 'This job has reached its file limit', 'limit_reached'],
    [413, 'File exceeds the maximum upload size', 'too_large'],
    [404, 'Job not found', 'not_found'],
    [409, 'Submission ID already used for a different upload', 'conflict'],
    [400, 'Invalid', 'invalid'],
  ] as const)('%s %s -> rejected (%s)', async (code, message, expected) => {
    const h = harness()
    h.api.nextInit = [apiErr(code, message)]
    await h.engine.start()
    const r = await h.engine.enqueue({ jobId: 'job-1', file: photo() }) as { id: string }
    await until(async () => (await stateOf(h, r.id)) === 'rejected')
    const it = (await h.store.get(SCOPE, r.id))!
    expect(it.errorCode).toBe(expected)
    expect(it.blob).toBeNull()
    expect(h.api.count('init')).toBe(1)
    expect(h.puts).toHaveLength(0)
    expect(h.engine.getSnapshot().items[0].errorText).toBeTruthy()
  })
})

describe('sessions, authorization and tenant isolation', () => {
  it('a 401 keeps the photo queued; nothing runs while signed out; resumes after sign-in as the same user', async () => {
    const h = harness()
    h.api.nextInit = [apiErr(401, 'Session expired. Please log in again.')]
    await h.engine.start()
    const r = await h.engine.enqueue({ jobId: 'job-1', file: photo() }) as { id: string }
    await until(async () => (await h.store.get(SCOPE, r.id))?.errorCode === 'auth_required')
    h.state.user = null
    h.engine.kick(); await wait(30)
    expect(h.engine.getSnapshot().paused).toBe('session')
    const calls = h.api.calls.length
    h.engine.kick(); await wait(30)
    expect(h.api.calls.length).toBe(calls)
    expect((await h.store.get(SCOPE, r.id))!.blob).not.toBeNull()
    h.state.user = SCOPE.userId
    h.engine.kick()
    await until(async () => (await stateOf(h, r.id)) === 'done')
  })

  it("never uploads under a different account: with another user signed in, no API call or PUT is made for the queue's photos", async () => {
    const store = new MemoryQueueStore()
    await store.add(SCOPE, storeItem(SCOPE, 'orphan'), { limits: LIMITS })
    const h = harness({ store })
    h.state.user = 'user-b'
    await h.engine.start()
    h.engine.kick(); await wait(40)
    expect(h.api.calls).toHaveLength(0)
    expect(h.puts).toHaveLength(0)
    expect((await store.get(SCOPE, 'orphan'))!.state).toBe('queued')
    const e = await h.engine.enqueue({ jobId: 'job-1', file: photo() })
    expect(e).toMatchObject({ ok: false, reason: 'wrong_session' })
  })

  it('two workspaces and two users share one store without seeing or touching each other', async () => {
    const store = new MemoryQueueStore()
    const A: Scope = { userId: 'user-a', workspaceId: 'ws-1' }
    const B: Scope = { userId: 'user-a', workspaceId: 'ws-2' }
    const C: Scope = { userId: 'user-b', workspaceId: 'ws-1' }
    const ha = harness({ store, scope: A }), hb = harness({ store, scope: B }), hc = harness({ store, scope: C })
    for (const h of [ha, hb, hc]) h.state.online = false
    await Promise.all([ha, hb, hc].map((h) => h.engine.start()))
    const ra = await ha.engine.enqueue({ jobId: 'job-1', file: photo() }) as { id: string }
    await hb.engine.enqueue({ jobId: 'job-1', file: photo() })
    expect((await store.list(A))).toHaveLength(1)
    expect((await store.list(B))).toHaveLength(1)
    expect((await store.list(C))).toHaveLength(0)
    // user-b/ws-1 cannot cancel, retry, preview or dismiss user-a/ws-1's photo by id
    await hc.engine.cancel(ra.id); await hc.engine.dismiss(ra.id)
    expect(await hc.engine.retry(ra.id)).toBe(false)
    expect(await hc.engine.preview(ra.id)).toBeNull()
    expect((await store.get(A, ra.id))!.state).toBe('queued')
    // and only A's workspace id is ever sent for A's photos
    ha.state.online = true; ha.engine.kick()
    await until(async () => (await store.get(A, ra.id))?.state === 'done')
    for (const c of ha.api.calls.filter((x) => x.op === 'init')) expect((c.body as { workspaceId: string }).workspaceId).toBe('ws-1')
    expect(hb.api.calls).toHaveLength(0)
    expect(hc.api.calls).toHaveLength(0)
  })

  it('unsent() reports what exists only on this phone, for the sign-out warning', async () => {
    const h = harness()
    h.state.online = false
    await h.engine.start()
    await h.engine.enqueue({ jobId: 'job-1', file: photo() })
    await h.engine.enqueue({ jobId: 'job-1', file: photo() })
    const u = await h.engine.unsent()
    expect(u.count).toBe(2)
    expect(u.bytes).toBeGreaterThan(1000)
  })
})

describe('concurrency, tabs and resume', () => {
  it('runs at most `concurrency` uploads at once and finishes them all', async () => {
    const h = harness({ putOutcomes: Array.from({ length: 6 }, () => async () => { await wait(15); return OK }) })
    await h.engine.start()
    const ids: string[] = []
    for (let i = 0; i < 6; i++) ids.push(((await h.engine.enqueue({ jobId: 'job-1', file: photo() })) as { id: string }).id)
    await until(async () => (await items(h)).every((i) => i.state === 'done'))
    expect(h.maxPuts()).toBeLessThanOrEqual(LIMITS.concurrency)
    expect(h.maxPuts()).toBeGreaterThan(1)
    expect(h.api.files.size).toBe(6)
  })

  it('another tab holding the lock means this tab does not touch the photo', async () => {
    const taken = new Set<string>()
    const lock: LockFn = async (name, fn) => { if (taken.has(name)) return { ran: false }; taken.add(name); try { return { ran: true, value: await fn() } } finally { taken.delete(name) } }
    const store = new MemoryQueueStore()
    const h = harness({ store, lock })
    h.state.online = false
    await h.engine.start()
    const r = await h.engine.enqueue({ jobId: 'job-1', file: photo() }) as { id: string }
    taken.add(`acaos-evidence:${SCOPE.userId}\u0000${SCOPE.workspaceId}:${r.id}`)
    h.state.online = true
    h.engine.kick(); await wait(40)
    expect(h.api.calls).toHaveLength(0)
    taken.clear()
  })

  it('two engines on one queue (two tabs) never create two files for one photo', async () => {
    const owner = new Map<string, boolean>()
    const lock: LockFn = async (name, fn) => { if (owner.get(name)) return { ran: false }; owner.set(name, true); try { return { ran: true, value: await fn() } } finally { owner.delete(name) } }
    const store = new MemoryQueueStore(), api = new FakeApi()
    const t1 = harness({ store, api, lock }), t2 = harness({ store, api, lock })
    t1.state.online = false; t2.state.online = false
    await t1.engine.start(); await t2.engine.start()
    const ids: string[] = []
    for (let i = 0; i < 4; i++) ids.push(((await t1.engine.enqueue({ jobId: 'job-1', file: photo() })) as { id: string }).id)
    t1.state.online = true; t2.state.online = true
    t1.engine.kick(); t2.engine.kick()
    await until(async () => (await store.list(SCOPE)).every((i) => i.state === 'done'), 5000)
    expect(api.files.size).toBe(4)
  })

  it('resumes after a reload: an item caught mid-upload re-inits idempotently; a processing item skips the PUT', async () => {
    const store = new MemoryQueueStore(), api = new FakeApi()
    await store.add(SCOPE, storeItem(SCOPE, 'mid-upload', { state: 'uploading', fileId: 'file-1', sha256: 'a'.repeat(64) }), { limits: LIMITS })
    await store.add(SCOPE, storeItem(SCOPE, 'processing', { state: 'processing', fileId: 'file-2', sha256: 'b'.repeat(64), blob: null }), { limits: LIMITS })
    api.files.set('file-1', { id: 'file-1', status: 'PENDING', sizeBytes: 100 }); api.bySubmission.set('mid-upload', 'file-1')
    api.files.set('file-2', { id: 'file-2', status: 'PENDING', sizeBytes: 100 })
    const h = harness({ store, api })
    await h.engine.start()
    await until(async () => (await store.list(SCOPE)).every((i) => i.state === 'done'))
    expect(h.puts).toHaveLength(1) // only the mid-upload photo is sent again; the processing one is not
    expect(api.files.size).toBe(2)
  })

  it('dispose aborts in-flight uploads and leaves the photo queued for the next session', async () => {
    let started!: () => void
    const startedP = new Promise<void>((r) => { started = r })
    const h = harness({ putOutcomes: [async () => { started(); await wait(2000); return { ...OK, aborted: true, status: 0 } }] })
    await h.engine.start()
    const r = await h.engine.enqueue({ jobId: 'job-1', file: photo() }) as { id: string }
    await startedP
    h.engine.dispose()
    expect(h.puts[0].signal.aborted).toBe(true)
    const it = (await h.store.get(SCOPE, r.id))!
    expect(it.blob).not.toBeNull()
    expect(['queued', 'uploading']).toContain(it.state)
  })
})

describe('cancellation', () => {
  it('cancelling a queued photo that the server has never seen just removes it', async () => {
    const h = harness()
    h.state.online = false
    await h.engine.start()
    const r = await h.engine.enqueue({ jobId: 'job-1', file: photo() }) as { id: string }
    await h.engine.cancel(r.id)
    expect(await items(h)).toHaveLength(0)
    expect(h.api.calls).toHaveLength(0)
  })

  it('cancelling mid-upload aborts the PUT, cancels the pending file on the server, and removes the record', async () => {
    let started!: () => void
    const startedP = new Promise<void>((r) => { started = r })
    const h = harness({ putOutcomes: [async () => { started(); await wait(2000); return OK }] })
    await h.engine.start()
    const r = await h.engine.enqueue({ jobId: 'job-1', file: photo() }) as { id: string }
    await startedP
    const cancelP = h.engine.cancel(r.id)
    expect(h.puts[0].signal.aborted).toBe(true)
    await cancelP
    await until(async () => (await items(h)).length === 0)
    expect(h.api.count('cancel')).toBe(1)
    expect(h.api.calls.find((c) => c.op === 'cancel')!.fileId).toBe('file-1')
    expect(h.api.count('complete')).toBe(0)
  })

  it('cancelling while init is in flight cancels the file the server then returns', async () => {
    const h = harness()
    h.api.initDelayMs = 40
    await h.engine.start()
    const r = await h.engine.enqueue({ jobId: 'job-1', file: photo() }) as { id: string }
    await until(() => h.api.count('init') === 1)
    await h.engine.cancel(r.id)
    await until(async () => (await items(h)).length === 0)
    expect(h.api.count('cancel')).toBe(1)
    expect(h.puts).toHaveLength(0)
  })

  it('a cancel that arrives after the file became evidence leaves it as done, never deleting evidence', async () => {
    const h = harness({ putOutcomes: [async () => { await wait(30); return OK }] })
    h.api.nextCancel = [apiErr(409, 'Uploaded evidence cannot be removed here')]
    await h.engine.start()
    const r = await h.engine.enqueue({ jobId: 'job-1', file: photo() }) as { id: string }
    await until(() => h.puts.length === 1)
    await h.engine.cancel(r.id)
    await until(async () => (await stateOf(h, r.id)) === 'done')
  })

  it('a cancel that cannot reach the server is remembered and retried', async () => {
    const h = harness()
    h.api.nextCancel = [apiErr(undefined, 'Failed to fetch'), 'ok']
    await h.engine.start()
    h.state.online = false
    const r = await h.engine.enqueue({ jobId: 'job-1', file: photo() }) as { id: string }
    await h.store.update(SCOPE, r.id, { fileId: 'file-1' })
    h.state.online = true
    await h.engine.cancel(r.id)
    await until(async () => (await items(h)).length === 0)
    expect(h.api.count('cancel')).toBe(2)
  })

  it('a result that arrives after the cancel cannot resurrect the photo: the cancel still goes to the server', async () => {
    const h = harness()
    h.api.statusDelayMs = 60
    h.api.nextCancel = [apiErr(409, 'Uploaded evidence cannot be removed here')]
    await h.engine.start()
    const r = await h.engine.enqueue({ jobId: 'job-1', file: photo() }) as { id: string }
    await until(() => h.api.count('status') === 1)          // the status poll is in flight
    await h.engine.cancel(r.id)
    await until(() => h.api.count('cancel') === 1)
    await until(async () => (await h.store.get(SCOPE, r.id))?.state === 'done')
    expect(h.api.count('cancel')).toBe(1)                     // it was not silently marked done by the late status result
    expect((await h.store.get(SCOPE, r.id))!.blob).toBeNull()
  })

  it('a cancel that lands between the queue listing and the upload starting cannot upload the photo anyway', async () => {
    const store = new MemoryQueueStore()
    const h = harness({ store })
    h.state.online = false
    await h.engine.start()
    const r = await h.engine.enqueue({ jobId: 'job-1', file: photo() }) as { id: string }
    // The pump reads its listing, then the person cancels before the upload begins: the listing is stale.
    const realList = store.list.bind(store)
    let listings = 0
    store.list = async (s) => {
      const snapshot = await realList(s)
      // 1st listing = snapshot refresh, 2nd = the pump choosing what to start
      if (++listings === 2 && snapshot.length) await h.engine.cancel(r.id)
      return snapshot
    }
    h.state.online = true
    h.engine.kick()
    await wait(80)
    expect(h.api.calls).toHaveLength(0)
    expect(h.puts).toHaveLength(0)
    expect(await items(h)).toHaveLength(0)
  })

  it('removing a finished or rejected record never calls the server', async () => {
    const h = harness()
    h.api.defaultStatus = 'REJECTED'
    await h.engine.start()
    const r = await h.engine.enqueue({ jobId: 'job-1', file: photo() }) as { id: string }
    await until(async () => (await stateOf(h, r.id)) === 'rejected')
    await h.engine.dismiss(r.id)
    expect(await items(h)).toHaveLength(0)
    expect(h.api.count('cancel')).toBe(0)
  })
})

describe('enqueue limits and image errors', () => {
  it('surfaces image problems (HEIC, size, type) without creating anything', async () => {
    const h = harness({ prepare: async () => { throw new ImageError('heic_unsupported') } })
    await h.engine.start()
    const r = await h.engine.enqueue({ jobId: 'job-1', file: photo() })
    expect(r).toMatchObject({ ok: false, reason: 'heic_unsupported' })
    expect((r as { message: string }).message).toMatch(/HEIC\/HEIF/)
    expect(await items(h)).toHaveLength(0)
    expect(h.api.calls).toHaveLength(0)
  })

  it('enforces the queue item and byte caps', async () => {
    const h = harness({ limits: { ...LIMITS, maxQueueItems: 2, maxQueueBytes: 100_000 } })
    h.state.online = false
    await h.engine.start()
    expect((await h.engine.enqueue({ jobId: 'job-1', file: photo() })).ok).toBe(true)
    expect((await h.engine.enqueue({ jobId: 'job-1', file: photo() })).ok).toBe(true)
    expect(await h.engine.enqueue({ jobId: 'job-1', file: photo() })).toMatchObject({ ok: false, reason: 'queue_full' })

    const h2 = harness({ limits: { ...LIMITS, maxQueueItems: 10, maxQueueBytes: 1000 }, prepare: async () => ({ blob: new Blob([new Uint8Array(700)]), contentType: 'image/jpeg' as const, sizeBytes: 700, width: 1, height: 1, sha256: Math.random().toString(16).slice(2).padEnd(64, '0') }) })
    h2.state.online = false
    await h2.engine.start()
    expect((await h2.engine.enqueue({ jobId: 'job-1', file: photo() })).ok).toBe(true)
    expect(await h2.engine.enqueue({ jobId: 'job-1', file: photo() })).toMatchObject({ ok: false, reason: 'storage_full' })
  })

  it('a database that rejects the write reports storage_full instead of throwing', async () => {
    const store = new MemoryQueueStore()
    store.add = async () => { throw new Error('QuotaExceededError') }
    const h = harness({ store })
    await h.engine.start()
    expect(await h.engine.enqueue({ jobId: 'job-1', file: photo() })).toMatchObject({ ok: false, reason: 'storage_full' })
  })

  it('processes one photo at a time when many are added together', async () => {
    let active = 0, peak = 0
    const h = harness({ prepare: async (f) => { active++; peak = Math.max(peak, active); await wait(5); active--; return preparedFor(f) } })
    h.state.online = false
    await h.engine.start()
    await Promise.all(Array.from({ length: 5 }, () => h.engine.enqueue({ jobId: 'job-1', file: photo() })))
    expect(peak).toBe(1)
    expect(await items(h)).toHaveLength(5)
  })
})

describe('session changes while a photo is being processed', () => {
  it('a photo prepared for one account is not queued if another account signed in meanwhile', async () => {
    const h = harness({ prepare: async (f) => { await wait(20); h.state.user = 'user-b'; return preparedFor(f) } })
    await h.engine.start()
    expect(await h.engine.enqueue({ jobId: 'job-1', file: photo() })).toMatchObject({ ok: false, reason: 'wrong_session' })
    expect(await items(h)).toHaveLength(0)
  })
})

describe('housekeeping', () => {
  it('prunes finished records after the retention period on start', async () => {
    const store = new MemoryQueueStore()
    await store.add(SCOPE, storeItem(SCOPE, 'old', { state: 'done', blob: null, doneAt: Date.now() - EVIDENCE_LIMITS.doneRetentionMs - 1000 }), { limits: LIMITS })
    await store.add(SCOPE, storeItem(SCOPE, 'recent', { state: 'done', blob: null, doneAt: Date.now() - 1000, sha256: 'r'.repeat(64) }), { limits: LIMITS })
    const h = harness({ store })
    await h.engine.start()
    expect((await store.list(SCOPE)).map((i) => i.id)).toEqual(['recent'])
  })

  it('a storage error while processing does not wedge the photo or spin', async () => {
    const store = new MemoryQueueStore()
    const h = harness({ store })
    await h.engine.start()
    const real = store.update.bind(store)
    let broke = 0
    store.update = async (s, id, p) => { if (p.state === 'uploading' && broke++ === 0) throw new Error('db closed'); return real(s, id, p) }
    const r = await h.engine.enqueue({ jobId: 'job-1', file: photo() }) as { id: string }
    await until(async () => (await store.get(SCOPE, r.id))?.nextAttemptAt != null)
    const it = (await store.get(SCOPE, r.id))!
    expect(it.nextAttemptAt! - Date.now()).toBeGreaterThan(5_000)
    expect(h.logs.some((l) => l.startsWith('engine_error'))).toBe(true)
  })
})

export type { QueueItem }
