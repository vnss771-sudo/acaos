// In-memory TTL cache for ingest API key → workspace lookups.
// Prevents a DB round-trip on every ingest request. Keys are SHA-256 hashes
// (already computed before lookup) so the raw API key never touches this cache.
// Rotation/revocation calls evictCachedWorkspace() to invalidate the old hash
// immediately on THIS pod, and (when attachIngestCacheInvalidator() has wired
// up Redis pub/sub — see server.ts) broadcasts the eviction so every sibling
// pod drops it too, instead of waiting out its own TTL. Without Redis
// configured this degrades gracefully to the original per-pod-only behaviour.

import type { IngestCacheInvalidator } from './ingestCacheInvalidation.js'

type Entry = { id: string; plan: string; expiresAt: number }

const CACHE = new Map<string, Entry>()
const TTL_MS = 5 * 60 * 1_000  // 5 minutes

let invalidator: IngestCacheInvalidator | undefined

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
  void invalidator?.publish(hash)
}

// Wires this process into the cross-pod invalidation broadcast — call once at
// startup when Redis is configured (see server.ts). Idempotent no-op if
// called again with the process already attached.
export function attachIngestCacheInvalidator(inv: IngestCacheInvalidator): void {
  if (invalidator) return
  invalidator = inv
  void inv.subscribe((hash) => { CACHE.delete(hash) })
}
