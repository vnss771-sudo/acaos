// A behavioural contract every QueueStore must satisfy. It is plain code (no test framework) so the
// same checks run against MemoryQueueStore under Vitest and against the real IndexedDbQueueStore
// inside Chromium (e2e/evidence-queue-browser.spec.ts). Not imported by application code.
import type { QueueItem, QueueStore, Scope } from './queueStore'

const LIMITS = { maxQueueItems: 3, maxQueueBytes: 1000 }
const A1: Scope = { userId: 'user-a', workspaceId: 'ws-1' }
const A2: Scope = { userId: 'user-a', workspaceId: 'ws-2' }
const B1: Scope = { userId: 'user-b', workspaceId: 'ws-1' }

export function item(scope: Scope, id: string, over: Partial<QueueItem> = {}): QueueItem {
  return {
    id, userId: scope.userId, workspaceId: scope.workspaceId, jobId: 'job-1', state: 'queued',
    blob: new Blob([new Uint8Array(100)], { type: 'image/jpeg' }), sizeBytes: 100, contentType: 'image/jpeg', width: 10, height: 10,
    sha256: id.padEnd(64, '0'), preview: null, createdAt: 1, updatedAt: 1, attempts: 0, reinits: 0, nextAttemptAt: null, fileId: null, errorCode: null, errorStatus: null, doneAt: null,
    ...over,
  }
}

function check(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(`queue store contract: ${msg}`) }

export async function runQueueStoreContract(make: () => Promise<QueueStore>): Promise<void> {
  const s = await make()
  await s.clearAll()

  // basic life cycle + blob round trip
  check((await s.add(A1, item(A1, 'p1'), { limits: LIMITS })).ok, 'first add succeeds')
  const got = await s.get(A1, 'p1')
  check(got && got.blob && got.blob.size === 100 && got.blob.type === 'image/jpeg', 'blob survives a round trip with its size and type')
  check((await s.list(A1)).length === 1, 'list returns the item')
  check(await s.update(A1, 'p1', { state: 'uploading', attempts: 2 }), 'update an existing item')
  check((await s.get(A1, 'p1'))?.state === 'uploading', 'update is visible')
  check(!(await s.update(A1, 'nope', { state: 'done' })), 'update of a missing item reports false')
  check(await s.update(A1, 'p1', { userId: 'someone-else', workspaceId: 'ws-9', id: 'other' } as Partial<QueueItem>), 'a patch carrying identity fields is applied without them')
  const again = await s.get(A1, 'p1')
  check(again && again.userId === 'user-a' && again.workspaceId === 'ws-1' && again.id === 'p1', 'identity fields cannot be changed by a patch')

  // scope isolation: same ids in other scopes are invisible and untouchable
  check((await s.add(A2, item(A2, 'p1', { sha256: 'x'.repeat(64) }), { limits: LIMITS })).ok, 'the same id may exist in another workspace')
  check((await s.add(B1, item(B1, 'p1', { sha256: 'y'.repeat(64) }), { limits: LIMITS })).ok, 'and for another user')
  check((await s.list(A1)).length === 1 && (await s.list(A2)).length === 1 && (await s.list(B1)).length === 1, 'each scope lists only its own')
  await s.update(B1, 'p1', { state: 'rejected' })
  check((await s.get(A1, 'p1'))?.state === 'uploading' && (await s.get(A2, 'p1'))?.state === 'queued', 'updating in one scope does not touch another')
  await s.remove(A2, 'p1')
  check(!(await s.get(A2, 'p1')) && !!(await s.get(A1, 'p1')) && !!(await s.get(B1, 'p1')), 'removing in one scope does not touch another')
  let threw = false
  try { await s.add(A1, item(B1, 'forged'), { limits: LIMITS }) } catch { threw = true }
  check(threw, 'an item belonging to a different scope is refused')
  check((await s.get(A1, 'forged')) === null && (await s.get(B1, 'forged')) === null, 'and nothing was stored')

  // caps, duplicates and atomicity
  await s.clearAll()
  check((await s.add(A1, item(A1, 'c1', { sizeBytes: 400 }), { limits: LIMITS })).ok, 'cap fixture 1')
  check((await s.add(A1, item(A1, 'c2', { sizeBytes: 400 }), { limits: LIMITS })).ok, 'cap fixture 2')
  const big = await s.add(A1, item(A1, 'c3', { sizeBytes: 400 }), { limits: LIMITS })
  check(!big.ok && big.reason === 'storage_full', 'the byte cap is enforced')
  const dup = await s.add(A1, item(A1, 'c4', { sizeBytes: 100, sha256: 'c1'.padEnd(64, '0') }), { limits: LIMITS })
  check(!dup.ok && dup.reason === 'duplicate', 'the same photo for the same job is a duplicate')
  check((await s.add(A1, item(A1, 'c4', { sizeBytes: 100, sha256: 'c1'.padEnd(64, '0') }), { limits: LIMITS, allowDuplicate: true })).ok, 'unless explicitly allowed')
  const ex = await s.add(A1, item(A1, 'c1', { sha256: 'q'.repeat(64) }), { limits: LIMITS })
  check(!ex.ok && ex.reason === 'exists', 'an existing id is not overwritten')
  const full = await s.add(A1, item(A1, 'c5', { sizeBytes: 10, sha256: 'c5'.padEnd(64, '0') }), { limits: LIMITS })
  check(!full.ok && full.reason === 'queue_full', 'the item cap is enforced')
  check((await s.add(A1, item(A1, 'c6', { jobId: 'job-2', sizeBytes: 10, sha256: 'c6'.padEnd(64, '0') }), { limits: { ...LIMITS, maxQueueItems: 10 } })).ok, 'a different job is not a duplicate')

  await s.clearAll()
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => s.add(A1, item(A1, `r${i}`, { sha256: `r${i}`.padEnd(64, '0') }), { limits: LIMITS })))
  check(results.filter((r) => r.ok).length === 3, 'concurrent adds cannot exceed the item cap')
  check((await s.list(A1)).length === 3, 'exactly the accepted items are stored')

  // items without a photo do not count against the caps; totals reflect photos only
  await s.clearAll()
  await s.add(A1, item(A1, 'd1', { sizeBytes: 900 }), { limits: LIMITS })
  check((await s.totals(A1)).bytes === 900 && (await s.totals(A1)).count === 1, 'totals count stored photos')
  await s.update(A1, 'd1', { state: 'done', blob: null })
  check((await s.totals(A1)).bytes === 0 && (await s.totals(A1)).count === 0, 'a finished item holds no photo')
  check((await s.add(A1, item(A1, 'd2', { sizeBytes: 900, sha256: 'd2'.padEnd(64, '0') }), { limits: LIMITS })).ok, 'and frees its space')

  // summary and per-user wipe: counts only, scoped, and only unsent photos
  await s.clearAll()
  await s.add(A1, item(A1, 's1', { sizeBytes: 100, sha256: 's1'.padEnd(64, '0') }), { limits: LIMITS })
  await s.add(A1, item(A1, 's2', { sizeBytes: 150, state: 'failed', sha256: 's2'.padEnd(64, '0') }), { limits: LIMITS })
  await s.add(A2, item(A2, 's3', { sizeBytes: 50, sha256: 's3'.padEnd(64, '0') }), { limits: LIMITS })
  await s.add(B1, item(B1, 's4', { sizeBytes: 70, sha256: 's4'.padEnd(64, '0') }), { limits: LIMITS })
  await s.add(B1, item(B1, 's5', { state: 'done', blob: null, sha256: 's5'.padEnd(64, '0') }), { limits: LIMITS })
  const sum = await s.summary()
  const byKey = (x: Scope) => sum.find((r) => r.userId === x.userId && r.workspaceId === x.workspaceId)
  check(sum.length === 3 && byKey(A1)?.count === 2 && byKey(A1)?.bytes === 250 && byKey(A2)?.count === 1 && byKey(B1)?.count === 1 && byKey(B1)?.bytes === 70, 'summary counts unsent photos per scope (finished items and photo-less records are not counted)')
  check(byKey(A1)?.attention === 1 && byKey(A1)?.active === 0 && byKey(A2)?.attention === 0 && byKey(B1)?.attention === 0, 'summary separates photos that need attention (failed) from the rest')
  check(!JSON.stringify(sum).includes('blob'), 'summary carries no photo data')
  await s.clearUser('user-a')
  check((await s.list(A1)).length === 0 && (await s.list(A2)).length === 0 && (await s.list(B1)).length === 2, 'clearUser removes that user in every workspace and nobody else')

  // clearing
  await s.clearAll()
  await s.add(A1, item(A1, 'e1'), { limits: LIMITS })
  await s.add(A2, item(A2, 'e1', { sha256: 'z'.repeat(64) }), { limits: LIMITS })
  await s.add(B1, item(B1, 'e1', { sha256: 'w'.repeat(64) }), { limits: LIMITS })
  await s.clearScope(A1)
  check((await s.list(A1)).length === 0 && (await s.list(A2)).length === 1 && (await s.list(B1)).length === 1, 'clearScope removes only that scope')
  await s.clearAll()
  check((await s.list(A2)).length === 0 && (await s.list(B1)).length === 0, 'clearAll removes everything')
}
