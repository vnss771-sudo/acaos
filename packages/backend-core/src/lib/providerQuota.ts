// Platform-wide (cross-workspace) rate limit on calls to a shared discovery
// provider (Apollo, Hunter, Google Places, ...). Every workspace's discovery
// runs share the SAME platform API key/contract with each provider — the
// per-workspace monthly quota (limits.ts's checkAndIncrementDiscoveryUsage)
// bounds any single tenant, but many workspaces each staying under their own
// cap can still collectively exceed what the platform is actually allowed to
// call. This is the backstop for that: one fixed-window counter per provider,
// shared across every workspace AND every process (API + worker) via an
// injected Redis client, with an in-process fallback so a Redis outage
// degrades to per-process enforcement rather than disabling the check.
//
// Mirrors apps/api/src/lib/workspaceRateLimit.ts's fixed-window INCR+EXPIRE
// pattern; kept here (not there) because prospectSources.ts, the actual call
// site, is used by both the API and the worker, and backend-core cannot
// import apps/api's Redis client (see check:boundaries).
import { ApiError } from './errors.js'

// Structural — kept minimal (just the two commands actually used) so tests can
// pass a fake without pulling in ioredis, and any real ioredis client already
// satisfies this without a wrapper.
export interface RedisLike {
  incr(key: string): Promise<number>
  expire(key: string, seconds: number): Promise<number>
  // Present on a real ioredis client; absent on a minimal test fake. Checked
  // (when present) before issuing a command — see the comment on its use below.
  status?: string
}

const WINDOW_MS = 60 * 60 * 1000 // 1 hour — matches workspaceRateLimit.ts's granularity

const DEFAULT_MAX_PER_HOUR: Record<string, number> = {
  apollo: 1_000,
  google_places: 500,
  hunter: 500,
}

let redis: RedisLike | undefined
const fallback = new Map<string, { count: number; resetAt: number }>()

/**
 * Attach (or detach) the shared Redis client. Called once at startup (api and
 * worker) when a Redis connection is available; omit/pass undefined to fall
 * back to per-process enforcement.
 */
export function attachProviderQuotaStore(client: RedisLike | undefined): void {
  redis = client
}

function maxPerHour(provider: string): number {
  const envVar = `PROVIDER_QUOTA_${provider.toUpperCase()}_PER_HOUR`
  const v = Number(process.env[envVar])
  if (Number.isFinite(v) && v >= 0) return Math.floor(v)
  return DEFAULT_MAX_PER_HOUR[provider] ?? Infinity
}

/**
 * Throw ApiError(429) when the platform-wide call volume to `provider` has
 * exceeded its hourly ceiling; otherwise record this call and return. An
 * unrecognized provider with no configured default is treated as unlimited
 * (nothing to enforce against). Tunable per provider via
 * PROVIDER_QUOTA_<PROVIDER>_PER_HOUR; set 0 to disable that provider's check.
 */
export async function checkProviderQuota(provider: string): Promise<void> {
  if (process.env.RATE_LIMIT_DISABLED === 'true') return
  const max = maxPerHour(provider)
  if (!Number.isFinite(max) || max <= 0) return

  const windowStart = Math.floor(Date.now() / WINDOW_MS)
  const key = `provq:${provider}:${windowStart}`

  let count: number
  try {
    if (!redis) throw new Error('no shared store attached')
    // Both server.ts's getRedis() and worker.ts's queue connection set
    // maxRetriesPerRequest: null with a retryStrategy that never gives up (required
    // by BullMQ) — ioredis queues commands issued while disconnected/reconnecting
    // rather than rejecting them, so a plain `await redis.incr(key)` during a Redis
    // outage would hang for the outage's duration instead of hitting this catch
    // block's fallback. Checking readiness first (mirroring
    // workspaceRateLimit.ts's identical guard) makes the fallback actually
    // reachable. Skipped for a test fake with no `status` at all.
    if (redis.status !== undefined && redis.status !== 'ready') throw new Error('Redis not ready')
    count = await redis.incr(key)
    if (count === 1) await redis.expire(key, Math.ceil(WINDOW_MS / 1000))
  } catch {
    const now = Date.now()
    let entry = fallback.get(provider)
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + WINDOW_MS }
      fallback.set(provider, entry)
    }
    entry.count += 1
    count = entry.count
  }

  if (count > max) {
    throw new ApiError(
      429,
      `Platform-wide hourly quota for ${provider} reached (${max} calls/hour across all workspaces). Try again shortly.`,
    )
  }
}

/** Test-only: clear the in-process fallback counters. */
export function _resetProviderQuotaForTest(): void {
  fallback.clear()
}
