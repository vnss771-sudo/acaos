import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ApiHook } from '../../hooks/useApi.js'
import { makeRouteApi } from '../../lib/routeApi.js'
import { createUploader } from '../../lib/evidence/createUploader.js'
import { makeEvidenceApi } from '../../lib/evidence/evidenceApi.js'
import { IndexedDbQueueStore, type QueueStore, type ScopeSummary } from '../../lib/evidence/queueStore.js'
import type { EnqueueResult, Snapshot, UploadEngine } from '../../lib/evidence/uploadEngine.js'
import { readPersistence, requestPersistentStorage, type PersistenceState } from '../../lib/evidence/persistence.js'
import { UnsentPhotosDialog, type DialogKind } from './UnsentPhotosDialog.js'

// App-level owner of the photo upload engine. It lives above every view so uploads keep running when
// someone navigates away from the Photos tab, and it is the single place that decides:
//   * when an engine exists (only for a signed-in user and workspace, and only once photos are
//     wanted: the Photos tab opened, or photos already waiting on this phone),
//   * what happens to unsent photos on sign-out, workspace switch and account change.
// Photos are never deleted silently: sign-out asks first, a workspace switch keeps them (they upload
// when the person returns), and photos left by a different account are only ever deleted on request.

export type PhotoFileResult = { name: string; result: EnqueueResult }

export type PhotoUploads = {
  snapshot: Snapshot
  /** Start the engine for this user and workspace (idempotent). */
  activate: () => void
  /** Process and queue photos one at a time. Never throws. */
  addPhotos: (jobId: string, files: File[]) => Promise<PhotoFileResult[]>
  retry: (id: string) => Promise<void>
  cancel: (id: string) => Promise<void>
  dismiss: (id: string) => Promise<void>
  persistence: PersistenceState | 'unknown'
  /** Photos on this phone that belong to a different account (counts only). */
  foreign: { count: number; bytes: number } | null
  confirmDeleteForeign: () => void
}

/** Wired into App's sign-out and workspace switcher (App itself renders the provider, so it uses a ref). */
export type PhotoGuards = {
  guardLogout: (proceed: () => void) => void
  guardWorkspaceSwitch: (proceed: () => void) => void
}

const Ctx = createContext<PhotoUploads | null>(null)
export const usePhotoUploads = () => useContext(Ctx)

const EMPTY: Snapshot = { items: [], online: true, paused: null }

type Props = {
  user: { id: string } | null
  workspaceId: string | null
  workspaceName?: string
  api: ApiHook
  /** False in demo mode, where there is no backend to upload to. */
  enabled?: boolean
  guardsRef?: React.MutableRefObject<PhotoGuards | null>
  /** Tests: use another store or engine factory. */
  store?: QueueStore
  makeEngine?: (o: { scope: { userId: string; workspaceId: string }; api: ApiHook; sessionUserId: () => string | null; store: QueueStore }) => UploadEngine
  children: React.ReactNode
}

type DialogState = { kind: DialogKind; count: number; bytes: number; confirm: () => void | Promise<void> } | null

export function PhotoUploadProvider({ user, workspaceId, workspaceName, api, enabled = true, guardsRef, store: storeProp, makeEngine, children }: Props) {
  const store = useMemo<QueueStore | null>(() => {
    if (storeProp) return storeProp
    try { return typeof indexedDB !== 'undefined' ? new IndexedDbQueueStore() : null } catch { return null }
  }, [storeProp])
  const userId = enabled ? user?.id ?? null : null
  const scopeId = userId && workspaceId ? `${userId}\u0000${workspaceId}` : null

  // The engine and the stores read the latest api/user without being rebuilt when a token refresh changes `api`.
  const apiRef = useRef(api); apiRef.current = api
  const userRef = useRef<string | null>(userId); userRef.current = userId

  const [active, setActive] = useState(false)
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY)
  const [persistence, setPersistence] = useState<PersistenceState | 'unknown'>('unknown')
  const [foreign, setForeign] = useState<{ count: number; bytes: number } | null>(null)
  const [dialog, setDialog] = useState<DialogState>(null)
  const engineRef = useRef<UploadEngine | null>(null)
  const waiters = useRef<Array<(e: UploadEngine | null) => void>>([])

  // A new scope (sign-in, sign-out, workspace switch) starts "not wanted" until photos are waiting or the tab opens.
  useEffect(() => {
    setActive(false)
    setSnapshot(EMPTY)
    if (!scopeId || !store || !userId || !workspaceId) return
    let cancelled = false
    void store.summary().then((rows) => {
      if (!cancelled && rows.some((r) => r.userId === userId && r.workspaceId === workspaceId && r.count > 0)) setActive(true)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [scopeId, store, userId, workspaceId])

  // The engine for the current scope.
  useEffect(() => {
    if (!active || !scopeId || !store || !userId || !workspaceId) return
    const raw = (<T,>(path: string, init?: Record<string, unknown>) => apiRef.current<T>(path, init as never)) as Parameters<typeof makeRouteApi>[0]
    const sessionUserId = () => userRef.current
    const scope = { userId, workspaceId }
    const engine = makeEngine
      ? makeEngine({ scope, api: apiRef.current, sessionUserId, store })
      : createUploader({ scope, api: makeEvidenceApi(makeRouteApi(raw), raw), sessionUserId, store })
    engineRef.current = engine
    const unsub = engine.subscribe(setSnapshot)
    void engine.start().then(() => { for (const w of waiters.current.splice(0)) w(engine) })
    return () => {
      unsub()
      engine.dispose()
      if (engineRef.current === engine) engineRef.current = null
      for (const w of waiters.current.splice(0)) w(null)
    }
  }, [active, scopeId, store, userId, workspaceId, makeEngine])

  // Photos left on this phone by a different account: counts only, never contents.
  const refreshForeign = useCallback(async () => {
    if (!store || !userId) { setForeign(null); return }
    try {
      const rows = (await store.summary()).filter((r) => r.userId !== userId)
      setForeign(rows.length ? { count: rows.reduce((n, r) => n + r.count, 0), bytes: rows.reduce((n, r) => n + r.bytes, 0) } : null)
    } catch { setForeign(null) }
  }, [store, userId])
  useEffect(() => { void refreshForeign() }, [refreshForeign])

  useEffect(() => { void readPersistence().then(setPersistence) }, [])

  const activate = useCallback(() => { if (scopeId) setActive(true) }, [scopeId])

  const engineReady = useCallback((): Promise<UploadEngine | null> => {
    if (engineRef.current) return Promise.resolve(engineRef.current)
    return new Promise((resolve) => { waiters.current.push(resolve) })
  }, [])

  const addPhotos = useCallback(async (jobId: string, files: File[]): Promise<PhotoFileResult[]> => {
    if (!scopeId) return files.map((f) => ({ name: f.name, result: { ok: false as const, reason: 'wrong_session' as const, message: 'Sign in again to add photos.' } }))
    setActive(true)
    // Ask the browser to keep the photos; the answer only changes the wording, never a promise.
    void requestPersistentStorage().then(setPersistence)
    const engine = await engineReady()
    if (!engine) return files.map((f) => ({ name: f.name, result: { ok: false as const, reason: 'wrong_session' as const, message: 'The workspace changed. Add the photo again.' } }))
    const out: PhotoFileResult[] = []
    for (const f of files) out.push({ name: f.name, result: await engine.enqueue({ jobId, file: f }) })
    return out
  }, [scopeId, engineReady])

  const withEngine = useCallback((fn: (e: UploadEngine) => Promise<unknown>) => async () => { const e = engineRef.current; if (e) await fn(e) }, [])
  const retry = useCallback(async (id: string) => withEngine((e) => e.retry(id))(), [withEngine])
  const cancel = useCallback(async (id: string) => withEngine((e) => e.cancel(id))(), [withEngine])
  const dismiss = useCallback(async (id: string) => withEngine((e) => e.dismiss(id))(), [withEngine])

  // ── guards ───────────────────────────────────────────────────────────────
  const unsentFor = useCallback(async (pick: (r: ScopeSummary) => boolean) => {
    if (!store) return { count: 0, bytes: 0 }
    try {
      const rows = (await store.summary()).filter(pick)
      return { count: rows.reduce((n, r) => n + r.count, 0), bytes: rows.reduce((n, r) => n + r.bytes, 0) }
    } catch { return { count: 0, bytes: 0 } }
  }, [store])

  const guardLogout = useCallback((proceed: () => void) => {
    if (!userId || !store) { proceed(); return }
    void unsentFor((r) => r.userId === userId).then((u) => {
      if (u.count === 0) { proceed(); return }
      setDialog({
        kind: 'logout', ...u,
        confirm: async () => {
          engineRef.current?.dispose()
          try { await store.clearUser(userId) } catch { /* sign-out must not be blocked by a storage error */ }
          proceed()
        },
      })
    })
  }, [userId, store, unsentFor])

  const guardWorkspaceSwitch = useCallback((proceed: () => void) => {
    if (!userId || !workspaceId || !store) { proceed(); return }
    void unsentFor((r) => r.userId === userId && r.workspaceId === workspaceId).then((u) => {
      if (u.count === 0) { proceed(); return }
      setDialog({ kind: 'switch', ...u, confirm: () => proceed() })
    })
  }, [userId, workspaceId, store, unsentFor])

  useEffect(() => {
    if (!guardsRef) return
    guardsRef.current = { guardLogout, guardWorkspaceSwitch }
    return () => { guardsRef.current = null }
  }, [guardsRef, guardLogout, guardWorkspaceSwitch])

  const confirmDeleteForeign = useCallback(() => {
    if (!store || !foreign || !userId) return
    setDialog({
      kind: 'foreign', ...foreign,
      confirm: async () => {
        const others = [...new Set((await store.summary()).filter((r) => r.userId !== userId).map((r) => r.userId))]
        for (const u of others) await store.clearUser(u)
        await refreshForeign()
      },
    })
  }, [store, foreign, userId, refreshForeign])

  const value = useMemo<PhotoUploads | null>(() => (scopeId
    ? { snapshot, activate, addPhotos, retry, cancel, dismiss, persistence, foreign, confirmDeleteForeign }
    : null), [scopeId, snapshot, activate, addPhotos, retry, cancel, dismiss, persistence, foreign, confirmDeleteForeign])

  return (
    <Ctx.Provider value={value}>
      {children}
      <UnsentPhotosDialog
        state={dialog && { kind: dialog.kind, count: dialog.count, bytes: dialog.bytes, workspaceName }}
        onCancel={() => setDialog(null)}
        onConfirm={() => { const d = dialog; setDialog(null); if (d) void d.confirm() }}
      />
    </Ctx.Provider>
  )
}
