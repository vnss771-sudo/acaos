// In-memory TTL cache for ingest API key → workspace lookups.
// Prevents a DB round-trip on every ingest request. Keys are SHA-256 hashes
// (already computed before lookup) so the raw API key never touches this cache.
// Rotation calls evictCachedWorkspace() to immediately invalidate the old hash.

type Entry = { id: string; plan: string; expiresAt: number }

const CACHE = new Map<string, Entry>()
const TTL_MS = 5 * 60 * 1_000  // 5 minutes

export function getCachedWorkspace(hash: string): { id: string; plan: string } | null {
  const entry = CACHE.get(hash)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) { CACHE.delete(hash); return null }
  return { id: entry.id, plan: entry.plan }
}

export function setCachedWorkspace(hash: string, workspace: { id: string; plan: string }): void {
  CACHE.set(hash, { ...workspace, expiresAt: Date.now() + TTL_MS })
}

export function evictCachedWorkspace(hash: string): void {
  CACHE.delete(hash)
}
