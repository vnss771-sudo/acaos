// Single-flight TTL memo for ONE expensive async producer (a single keyless value).
//
// Distinct from apps/api/src/lib/ttlCache.ts, which is a *keyed*, per-workspace cache
// for read-hot endpoints — and which the worker can't import anyway (the boundary
// gate forbids worker → apps/api). This is the keyless variant the worker needs.
//
// Built for the worker /metrics domain snapshot: that collection runs up to N
// sequential DB reputation evaluations, and Prometheus may scrape every 15s — so
// without a memo the DB load scales with scrape frequency. Wrapping the producer here
// makes it run at most once per `ttlMs`, and coalesces concurrent callers onto a
// single in-flight computation (no thundering herd when scrapes race).
//
// The clock is injectable so behaviour is deterministic in unit tests. On error
// nothing is cached — the next call retries — so a transient failure can't pin a bad
// (or empty) value for the whole TTL.

export type CachedValue<T> = {
  /** Return the cached value if fresh, else (re)compute once and cache it. */
  get(): Promise<T>
  /** Drop the cached value so the next get() recomputes. */
  invalidate(): void
}

export function createCachedValue<T>(
  compute: () => Promise<T>,
  ttlMs: number,
  now: () => number = Date.now,
): CachedValue<T> {
  let cached: { value: T; at: number } | null = null
  let inflight: Promise<T> | null = null

  return {
    async get(): Promise<T> {
      const t = now()
      if (cached && t - cached.at < ttlMs) return cached.value
      // Coalesce concurrent recomputes onto one in-flight promise.
      if (inflight) return inflight
      inflight = compute().then(
        (value) => {
          cached = { value, at: now() }
          inflight = null
          return value
        },
        (err) => {
          inflight = null // don't cache failures — retry next call
          throw err
        },
      )
      return inflight
    },
    invalidate(): void {
      cached = null
    },
  }
}
