/** Exponential backoff with full jitter: a random delay in [0, min(cap, base * 2^attempt)). */
export function backoffMs(attempt: number, o: { baseMs: number; capMs: number; random?: () => number }): number {
  const ceiling = Math.min(o.capMs, o.baseMs * 2 ** Math.max(0, attempt))
  const r = (o.random ?? Math.random)()
  // Never retry instantly: at least a quarter of the ceiling.
  return Math.round(ceiling * 0.25 + r * ceiling * 0.75)
}
