// Sliding-window rejection tracker for the worker's crash policy.
//
// A single unhandledRejection is often benign (a stray promise, a transient blip)
// and shouldn't bounce the process. But a *storm* of them means the worker is wedged
// in an inconsistent state — staying "ready" while silently dropping throughput is
// worse than a clean restart. This counts rejections within a rolling window and
// signals when the threshold is breached, so the worker can drain + exit non-zero and
// let the platform restart a fresh process.
//
// Pure aside from the injectable clock — fully unit-testable.

export type RejectionTracker = {
  /** Record one rejection; returns true once `threshold` have occurred within `windowMs`. */
  record(now?: number): boolean
  /** Current count within the window (for diagnostics). */
  count(now?: number): number
}

export function createRejectionTracker(
  opts: { threshold?: number; windowMs?: number; now?: () => number } = {},
): RejectionTracker {
  const threshold = Math.max(1, opts.threshold ?? 5)
  const windowMs = opts.windowMs ?? 60_000
  const clock = opts.now ?? Date.now
  const times: number[] = []

  const prune = (t: number) => {
    while (times.length && t - times[0] > windowMs) times.shift()
  }

  return {
    record(now: number = clock()): boolean {
      times.push(now)
      prune(now)
      return times.length >= threshold
    },
    count(now: number = clock()): number {
      prune(now)
      return times.length
    },
  }
}
