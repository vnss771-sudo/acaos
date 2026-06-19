import type { Redis } from 'ioredis'
import type { BreakerStore } from './circuit.js'

// Redis-backed shared state for the circuit breakers. Lets one process broadcast
// that a provider's circuit is open so siblings (api ↔ worker, replicas) stop
// hammering it too.
//
// Every operation is fail-open: any Redis error resolves to "not shared-open"
// (reads) or is swallowed (writes). A degraded/absent Redis must never block a
// real external call — the breaker simply falls back to per-process behaviour.
export function createRedisBreakerStore(redis: Redis, opts: { prefix?: string } = {}): BreakerStore {
  const prefix = opts.prefix ?? 'cb:open:'
  return {
    async getOpenUntil(label) {
      try {
        const v = await redis.get(prefix + label)
        if (!v) return 0
        const n = Number(v)
        return Number.isFinite(n) ? n : 0
      } catch {
        return 0
      }
    },
    async setOpenUntil(label, untilMs) {
      try {
        // Expire the key when the open window ends so it self-heals even if no
        // process ever explicitly clears it.
        const ttlSec = Math.max(1, Math.ceil((untilMs - Date.now()) / 1000))
        await redis.set(prefix + label, String(untilMs), 'EX', ttlSec)
      } catch {
        // fail-open: a write failure just means siblings won't learn of this trip
      }
    },
  }
}
