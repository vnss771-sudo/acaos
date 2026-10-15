// Ask the browser to keep this site's storage (IndexedDB) when the phone is short of space. This is a
// request, not a guarantee: the browser may refuse, and storage can still be cleared by the person,
// by the browser (some iOS versions after a week of no use) or by a full disk. The interface says so;
// nothing here lets the app claim photos are safe.
export type PersistenceState = 'granted' | 'not_granted' | 'unsupported'

type StorageLike = { persist?: () => Promise<boolean>; persisted?: () => Promise<boolean> }

const storageOf = (s?: StorageLike) => s ?? (typeof navigator !== 'undefined' ? (navigator as { storage?: StorageLike }).storage : undefined)

export async function readPersistence(storage?: StorageLike): Promise<PersistenceState> {
  const st = storageOf(storage)
  if (!st?.persisted) return 'unsupported'
  try { return (await st.persisted()) ? 'granted' : 'not_granted' } catch { return 'unsupported' }
}

export async function requestPersistentStorage(storage?: StorageLike): Promise<PersistenceState> {
  const st = storageOf(storage)
  if (!st?.persist) return 'unsupported'
  try { return (await st.persist()) ? 'granted' : 'not_granted' } catch { return 'unsupported' }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}
