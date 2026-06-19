// Single-flight TTL cache for read-hot, workspace-scoped endpoints.
//
// Two behaviours, both aimed at the load-test finding that aggregation
// endpoints (e.g. /api/stats) grow their p99 under CONCURRENCY, not under
// sequential traffic:
//
//   1. Single-flight (request coalescing): N concurrent `get(key, …)` calls for
//      the same key trigger the loader ONCE; the rest await the same promise.
//      This collapses a 100-concurrent burst on one workspace from 100 DB
//      aggregations to 1 — directly flattening the p99 cliff. Always on.
//   2. TTL caching: a successful result is served for `ttlMs` afterwards. With
//      `ttlMs = 0` the cache is pure single-flight and serves NO stale reads —
//      so sequential (awaited) callers always recompute.
//
// Per-instance and in-memory by design: a few seconds of staleness on a
// dashboard counter is acceptable, and this needs no Redis round-trip on the
// hot path. Failed loads are never cached. Every cache registers itself so tests
// (and any future explicit invalidation) can clear all of them at once.

type CacheEntry<T> = { value: T; expiresAt: number }

export type TtlCache<T> = {
  /** Return the cached value, an in-flight load, or invoke `loader` once. */
  get(key: string, loader: () => Promise<T>): Promise<T>
  /** Drop a single key (both cached value and any in-flight load). */
  delete(key: string): void
  /** Drop everything. */
  clear(): void
}

const registry = new Set<TtlCache<unknown>>()

export function createTtlCache<T>(ttlMs: number): TtlCache<T> {
  const store = new Map<string, CacheEntry<T>>()
  const inflight = new Map<string, Promise<T>>()

  const cache: TtlCache<T> = {
    async get(key, loader) {
      if (ttlMs > 0) {
        const hit = store.get(key)
        if (hit && hit.expiresAt > Date.now()) return hit.value
      }
      const pending = inflight.get(key)
      if (pending) return pending

      const load = loader()
        .then((value) => {
          if (ttlMs > 0) store.set(key, { value, expiresAt: Date.now() + ttlMs })
          return value
        })
        .finally(() => {
          // Clear the in-flight marker whether the load resolved or rejected, so
          // a transient failure never wedges the key into a permanently-failing
          // state and the next caller retries from scratch.
          inflight.delete(key)
        })
      inflight.set(key, load)
      return load
    },
    delete(key) {
      store.delete(key)
      inflight.delete(key)
    },
    clear() {
      store.clear()
      inflight.clear()
    },
  }

  registry.add(cache as TtlCache<unknown>)
  return cache
}

/** Clear every TTL cache — used by tests to guarantee a fresh-state per case. */
export function clearAllTtlCaches(): void {
  for (const c of registry) c.clear()
}
