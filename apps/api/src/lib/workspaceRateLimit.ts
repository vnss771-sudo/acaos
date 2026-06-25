import { getRedis } from './redis.js'
import { ApiError } from './http.js'

// Per-workspace AI rate limit at the HTTP edge. The per-month plan meter
// (checkAndIncrementAiUsage) bounds total spend, but it's coarse and monthly; this
// stops a single workspace from BURSTING the shared platform OpenAI key by racing
// many requests across rotating source IPs — which the per-IP aiRateLimit cannot
// see. Fixed-window Redis counter (INCR + EXPIRE) with an in-process fallback so a
// Redis outage never fails the request, mirroring createRateLimiter's stance.
//
// Tunable via WORKSPACE_AI_RATE_MAX (default 120/hour); set 0 to disable.

const WINDOW_MS = 60 * 60 * 1000

// Per-pod fallback used only when Redis is unavailable. Pruned lazily on access.
const fallback = new Map<string, { count: number; resetAt: number }>()

function maxPerWindow(): number {
  const v = Number(process.env.WORKSPACE_AI_RATE_MAX)
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 120
}

/**
 * Throw ApiError(429) when the workspace has exceeded its AI requests for the
 * current fixed window; otherwise record this request and return.
 */
export async function enforceWorkspaceAiRate(workspaceId: string): Promise<void> {
  if (process.env.RATE_LIMIT_DISABLED === 'true') return
  const max = maxPerWindow()
  if (max <= 0) return // disabled

  const windowStart = Math.floor(Date.now() / WINDOW_MS)
  const redisKey = `rl:ws_ai:${workspaceId}:${windowStart}`

  let count: number
  try {
    const redis = getRedis()
    if (redis.status !== 'ready') throw new Error('Redis not ready')
    count = await redis.incr(redisKey)
    if (count === 1) await redis.expire(redisKey, Math.ceil(WINDOW_MS / 1000))
  } catch {
    const now = Date.now()
    let entry = fallback.get(workspaceId)
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + WINDOW_MS }
      fallback.set(workspaceId, entry)
    }
    entry.count += 1
    count = entry.count
  }

  if (count > max) {
    throw new ApiError(429, 'Workspace AI rate limit reached. Please wait before making more AI requests.')
  }
}

/** Test-only: clear the in-process fallback counters. */
export function _resetWorkspaceAiRateForTest(): void {
  fallback.clear()
}
