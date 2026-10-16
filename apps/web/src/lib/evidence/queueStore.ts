// The on-device upload queue. Unsent photos live here so a reload, a killed tab or a dead zone
// loses nothing. Two implementations share one interface: IndexedDbQueueStore (the real one, one
// database for the whole origin) and MemoryQueueStore (tests).
//
// Isolation. Every record belongs to one (userId, workspaceId) scope and every method takes the
// scope: a record can only be read, changed or removed through its own scope, so one account (or
// workspace) on a shared phone cannot see, upload or delete another's photos. clearAll() wipes the
// whole database for logout. The caps are enforced inside the same transaction that inserts, so
// two tabs cannot together exceed them.
//
// What is stored: the processed JPEG, its size/hash and the queue state. What is NEVER stored:
// signed URLs, upload headers, tokens or credentials. Those exist only in memory for the duration
// of one attempt (see uploadEngine.ts). Error details are short codes, never raw error text.
import type { EvidenceLimits } from './limits'

export type Scope = { userId: string; workspaceId: string }
export const scopeKey = (s: Scope) => `${s.userId}\u0000${s.workspaceId}`

export type QueueState = 'queued' | 'uploading' | 'processing' | 'failed' | 'rejected' | 'cancelling' | 'done'

export type QueueItem = {
  /** The idempotency key sent to the server as `submissionId`. Generated once, when the photo is added. */
  id: string
  userId: string
  workspaceId: string
  jobId: string
  state: QueueState
  /** The processed JPEG. Dropped (null) once the item is done or cancelling. */
  blob: Blob | null
  sizeBytes: number
  contentType: 'image/jpeg'
  width: number
  height: number
  sha256: string
  /** A tiny `data:` preview for lists (about 5 to 15 KB), or null. Never the full photo. */
  preview?: string | null
  createdAt: number
  updatedAt: number
  /** Automatic attempts used since the last manual retry. */
  attempts: number
  /** Times a storage 403 forced a fresh `init` (limited to one). */
  reinits: number
  /** Do not try again before this time (ms since epoch). */
  nextAttemptAt: number | null
  /** The server's file id, once `init` has succeeded. */
  fileId: string | null
  /** A short machine code (see uploadErrors.ts), never free text. */
  errorCode: string | null
  errorStatus: number | null
  doneAt: number | null
}

export type AddResult =
  | { ok: true }
  | { ok: false; reason: 'queue_full' | 'storage_full' | 'duplicate' | 'exists' }

export interface QueueStore {
  list(scope: Scope): Promise<QueueItem[]>
  get(scope: Scope, id: string): Promise<QueueItem | null>
  /** Insert a new item if the caps allow (atomic). `allowDuplicate` skips only the same-photo-same-job check. */
  add(scope: Scope, item: QueueItem, o: { limits: Pick<EvidenceLimits, 'maxQueueItems' | 'maxQueueBytes'>; allowDuplicate?: boolean }): Promise<AddResult>
  /** Shallow-merge a patch into an existing item. Returns false if it no longer exists (e.g. cancelled meanwhile). */
  update(scope: Scope, id: string, patch: Partial<QueueItem>): Promise<boolean>
  remove(scope: Scope, id: string): Promise<void>
  totals(scope: Scope): Promise<{ count: number; bytes: number }>
  /**
   * What photos exist per (user, workspace) across the whole browser: counts and sizes only, never photos.
   * Used for the sign-out / workspace-switch warnings and the "photos from another account" notice.
   */
  summary(): Promise<ScopeSummary[]>
  clearScope(scope: Scope): Promise<void>
  /** Delete every photo and record that belongs to one user (all workspaces). */
  clearUser(userId: string): Promise<void>
  clearAll(): Promise<void>
}

/** `attention` = photos in the failed state (they need a person); `active` = being sent right now. Both are subsets of `count`. */
export type ScopeSummary = { userId: string; workspaceId: string; count: number; bytes: number; attention: number; active: number }

/** Unsent = still holding a photo that has not reached the server as evidence. */
const UNSENT_STATES: ReadonlySet<QueueState> = new Set(['queued', 'uploading', 'processing', 'failed'])
export function summarize(items: QueueItem[]): ScopeSummary[] {
  const m = new Map<string, ScopeSummary>()
  for (const i of items) {
    if (!UNSENT_STATES.has(i.state) || !i.blob) continue
    const k = scopeKey(i)
    const cur = m.get(k) ?? { userId: i.userId, workspaceId: i.workspaceId, count: 0, bytes: 0, attention: 0, active: 0 }
    cur.count++; cur.bytes += i.sizeBytes
    if (i.state === 'failed') cur.attention++
    else if (i.state === 'uploading' || i.state === 'processing') cur.active++
    m.set(k, cur)
  }
  return [...m.values()]
}

const OPEN_STATES: ReadonlySet<QueueState> = new Set(['queued', 'uploading', 'processing', 'failed'])
/** Counts toward the caps and the duplicate check: it still holds (or may hold) a photo. */
export const holdsPhoto = (i: QueueItem) => i.blob !== null

function checkScope(scope: Scope, item: Pick<QueueItem, 'userId' | 'workspaceId'>) {
  if (item.userId !== scope.userId || item.workspaceId !== scope.workspaceId) throw new Error('queue item does not belong to this scope')
}

function decideAdd(existing: QueueItem[], item: QueueItem, o: { limits: Pick<EvidenceLimits, 'maxQueueItems' | 'maxQueueBytes'>; allowDuplicate?: boolean }): AddResult {
  if (existing.some((i) => i.id === item.id)) return { ok: false, reason: 'exists' }
  const held = existing.filter(holdsPhoto)
  if (held.length >= o.limits.maxQueueItems) return { ok: false, reason: 'queue_full' }
  if (held.reduce((n, i) => n + i.sizeBytes, 0) + item.sizeBytes > o.limits.maxQueueBytes) return { ok: false, reason: 'storage_full' }
  if (!o.allowDuplicate && existing.some((i) => OPEN_STATES.has(i.state) && i.jobId === item.jobId && i.sha256 === item.sha256)) return { ok: false, reason: 'duplicate' }
  return { ok: true }
}

// ── in-memory (tests) ───────────────────────────────────────────────────────

export class MemoryQueueStore implements QueueStore {
  /** Everything stored, keyed by scope then id. Exposed so tests can inspect what would be persisted. */
  readonly data = new Map<string, Map<string, QueueItem>>()
  private bucket(s: Scope) {
    const k = scopeKey(s)
    let m = this.data.get(k)
    if (!m) { m = new Map(); this.data.set(k, m) }
    return m
  }
  async list(scope: Scope) { return [...this.bucket(scope).values()].map((i) => ({ ...i })).sort((a, b) => a.createdAt - b.createdAt) }
  async get(scope: Scope, id: string) { const i = this.bucket(scope).get(id); return i ? { ...i } : null }
  async add(scope: Scope, item: QueueItem, o: Parameters<QueueStore['add']>[2]) {
    checkScope(scope, item)
    const m = this.bucket(scope)
    const r = decideAdd([...m.values()], item, o)
    if (r.ok) m.set(item.id, { ...item })
    return r
  }
  async update(scope: Scope, id: string, patch: Partial<QueueItem>) {
    const m = this.bucket(scope)
    const cur = m.get(id)
    if (!cur) return false
    m.set(id, { ...cur, ...patch, id: cur.id, userId: cur.userId, workspaceId: cur.workspaceId })
    return true
  }
  async remove(scope: Scope, id: string) { this.bucket(scope).delete(id) }
  async totals(scope: Scope) {
    const held = [...this.bucket(scope).values()].filter(holdsPhoto)
    return { count: held.length, bytes: held.reduce((n, i) => n + i.sizeBytes, 0) }
  }
  async summary() { return summarize([...this.data.values()].flatMap((m) => [...m.values()])) }
  async clearScope(scope: Scope) { this.data.delete(scopeKey(scope)) }
  async clearUser(userId: string) { for (const k of [...this.data.keys()]) if (k.startsWith(`${userId}\u0000`)) this.data.delete(k) }
  async clearAll() { this.data.clear() }
}

// ── IndexedDB (browser) ─────────────────────────────────────────────────────

const DB_NAME = 'acaos-evidence-queue'
const STORE = 'items'
type Row = QueueItem & { key: string; scopeKey: string }

const reqP = <T>(r: IDBRequest<T>) => new Promise<T>((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
const txDone = (t: IDBTransaction) => new Promise<void>((res, rej) => {
  t.oncomplete = () => res()
  t.onerror = () => rej(t.error)
  t.onabort = () => rej(t.error ?? new Error('transaction aborted'))
})
const rowKey = (s: Scope, id: string) => `${scopeKey(s)}\u0000${id}`
const strip = ({ key: _k, scopeKey: _s, ...item }: Row): QueueItem => item

export class IndexedDbQueueStore implements QueueStore {
  private dbp: Promise<IDBDatabase> | null = null
  constructor(private readonly idb: IDBFactory = indexedDB) {}

  private db(): Promise<IDBDatabase> {
    this.dbp ??= new Promise<IDBDatabase>((resolve, reject) => {
      const open = this.idb.open(DB_NAME, 1)
      open.onupgradeneeded = () => {
        const store = open.result.createObjectStore(STORE, { keyPath: 'key' })
        store.createIndex('scopeKey', 'scopeKey', { unique: false })
      }
      open.onsuccess = () => {
        const db = open.result
        db.onversionchange = () => { db.close(); this.dbp = null }
        resolve(db)
      }
      open.onerror = () => { this.dbp = null; reject(open.error) }
      open.onblocked = () => { this.dbp = null; reject(new Error('indexeddb blocked')) }
    })
    return this.dbp
  }
  private async rows(scope: Scope, t?: IDBTransaction): Promise<Row[]> {
    const tx = t ?? (await this.db()).transaction(STORE, 'readonly')
    return reqP<Row[]>(tx.objectStore(STORE).index('scopeKey').getAll(IDBKeyRange.only(scopeKey(scope))))
  }

  async list(scope: Scope) { return (await this.rows(scope)).map(strip).sort((a, b) => a.createdAt - b.createdAt) }
  async get(scope: Scope, id: string) {
    const tx = (await this.db()).transaction(STORE, 'readonly')
    const row = await reqP<Row | undefined>(tx.objectStore(STORE).get(rowKey(scope, id)))
    return row && row.scopeKey === scopeKey(scope) ? strip(row) : null
  }
  async add(scope: Scope, item: QueueItem, o: Parameters<QueueStore['add']>[2]): Promise<AddResult> {
    checkScope(scope, item)
    const db = await this.db()
    const tx = db.transaction(STORE, 'readwrite')
    const done = txDone(tx)
    let result: AddResult
    try {
      const existing = (await this.rows(scope, tx)).map(strip)
      result = decideAdd(existing, item, o)
      if (result.ok) tx.objectStore(STORE).add({ ...item, key: rowKey(scope, item.id), scopeKey: scopeKey(scope) } satisfies Row)
    } catch (e) {
      try { tx.abort() } catch { /* already finished */ }
      await done.catch(() => {})
      throw e
    }
    try { await done } catch (e) {
      if ((e as DOMException)?.name === 'QuotaExceededError') return { ok: false, reason: 'storage_full' }
      throw e
    }
    return result
  }
  async update(scope: Scope, id: string, patch: Partial<QueueItem>) {
    const db = await this.db()
    const tx = db.transaction(STORE, 'readwrite')
    const done = txDone(tx)
    const store = tx.objectStore(STORE)
    const row = await reqP<Row | undefined>(store.get(rowKey(scope, id)))
    if (!row || row.scopeKey !== scopeKey(scope)) { await done; return false }
    store.put({ ...row, ...patch, key: row.key, scopeKey: row.scopeKey, id: row.id, userId: row.userId, workspaceId: row.workspaceId } satisfies Row)
    await done
    return true
  }
  async remove(scope: Scope, id: string) {
    const tx = (await this.db()).transaction(STORE, 'readwrite')
    tx.objectStore(STORE).delete(rowKey(scope, id))
    await txDone(tx)
  }
  async totals(scope: Scope) {
    const held = (await this.rows(scope)).filter(holdsPhoto)
    return { count: held.length, bytes: held.reduce((n, i) => n + i.sizeBytes, 0) }
  }
  async summary() {
    const tx = (await this.db()).transaction(STORE, 'readonly')
    return summarize((await reqP<Row[]>(tx.objectStore(STORE).getAll())).map(strip))
  }
  async clearUser(userId: string) {
    const tx = (await this.db()).transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    const rows = await reqP<Row[]>(store.getAll())
    for (const r of rows) if (r.userId === userId) store.delete(r.key)
    await txDone(tx)
  }
  async clearScope(scope: Scope) {
    const tx = (await this.db()).transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    const keys = await reqP<IDBValidKey[]>(store.index('scopeKey').getAllKeys(IDBKeyRange.only(scopeKey(scope))))
    for (const k of keys) store.delete(k)
    await txDone(tx)
  }
  async clearAll() {
    const tx = (await this.db()).transaction(STORE, 'readwrite')
    tx.objectStore(STORE).clear()
    await txDone(tx)
  }
}
