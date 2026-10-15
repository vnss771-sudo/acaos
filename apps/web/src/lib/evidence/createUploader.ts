// Wires the engine to the real browser: IndexedDB queue, XHR PUT, Web Locks across tabs, and the
// events that mean "try again now" (back online, app back in the foreground). Nothing here is
// rendered; the technician UI (C5c) calls createUploader once per signed-in user and workspace.
import { createUploadEngine, type EvidenceApi, type EngineDeps, type LockFn, type UploadEngine } from './uploadEngine'
import { IndexedDbQueueStore, type QueueStore, type Scope } from './queueStore'
import { xhrPut } from './uploadTransport'
import { prepareImage } from './imagePipeline'
import { browserImageCodec } from './imageCodec'

type LockManagerLike = { request: <T>(name: string, o: { ifAvailable: boolean }, cb: (lock: unknown) => Promise<T>) => Promise<T> }

/** At most one tab works on a given photo at a time. Without the Locks API, server idempotency still prevents duplicates. */
export const webLock: LockFn = async (name, fn) => {
  const locks = typeof navigator !== 'undefined' ? (navigator as { locks?: LockManagerLike }).locks : undefined
  if (!locks?.request) return { ran: true, value: await fn() }
  const out = await locks.request(name, { ifAvailable: true }, async (lock) => (lock ? { ran: true as const, value: await fn() } : { ran: false as const }))
  return out
}

/** Online, foreground, page-restored and focus events all mean "try again now". */
export function attachBrowserEvents(kick: () => void): () => void {
  const onVisible = () => { if (document.visibilityState === 'visible') kick() }
  window.addEventListener('online', kick)
  window.addEventListener('focus', kick)
  window.addEventListener('pageshow', kick)
  document.addEventListener('visibilitychange', onVisible)
  return () => {
    window.removeEventListener('online', kick)
    window.removeEventListener('focus', kick)
    window.removeEventListener('pageshow', kick)
    document.removeEventListener('visibilitychange', onVisible)
  }
}

export type UploaderOptions = {
  scope: Scope
  api: EvidenceApi
  sessionUserId: () => string | null
  store?: QueueStore
  log?: EngineDeps['log']
}

export function createUploader(o: UploaderOptions): UploadEngine {
  return createUploadEngine({
    scope: o.scope,
    store: o.store ?? new IndexedDbQueueStore(),
    api: o.api,
    put: xhrPut,
    prepare: (file) => prepareImage(file, { codec: browserImageCodec }),
    sessionUserId: o.sessionUserId,
    isOnline: () => navigator.onLine !== false,
    lock: webLock,
    attach: attachBrowserEvents,
    log: o.log,
  })
}

/**
 * Sign-out / account change: wipe every queued photo for every account on this browser. Call
 * `engine.unsent()` first and warn the person if photos have not been sent yet.
 */
export async function purgeAllQueuedPhotos(store: QueueStore = new IndexedDbQueueStore()): Promise<void> {
  await store.clearAll()
}
