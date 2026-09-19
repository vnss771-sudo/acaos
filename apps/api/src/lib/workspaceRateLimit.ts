import { getRedis } from './redis.js'
import { ApiError } from './http.js'
import { checkForRateLimitSpike } from './abuseDetection.js'

// Per-workspace rate limits at the HTTP edge, keyed by workspaceId instead of
// (or in addition to) the caller's IP. The per-IP limiters in middleware/rateLimit.ts
// and the per-month plan meters in lib/limits.ts are both necessary but neither
// stops a single compromised/abusive WORKSPACE from bursting a shared platform
// resource (the OpenAI key, the SMTP relay) by racing many requests across
// rotating source IPs or member accounts — which per-IP limiting cannot see, and
// which a monthly quota (coarse, resets once a month) does not bound on a
// per-minute/hour basis. Fixed-window Redis counter (INCR + EXPIRE) with an
// in-process fallback so a Redis outage never fails the request, mirroring
// createRateLimiter's stance in middleware/rateLimit.ts.

type WorkspaceRateLimitOptions = {
  // Redis key / in-process Map namespace, so AI and mail buckets never collide.
  name: string
  windowMs: number
  // Env var name operators can tune the ceiling with; set to 0 to disable.
  envVar: string
  defaultMax: number
  message: string
}

// Kept internal: every call site should go through the two enforce* wrappers
// below, which pin `envVar`/`message`/window per resource so callers can't
// accidentally cross-wire the AI and mail buckets.
function createWorkspaceRateLimit(opts: WorkspaceRateLimitOptions) {
  const { name, windowMs, envVar, defaultMax, message } = opts

  // Per-pod fallback used only when Redis is unavailable. Pruned lazily on access.
  const fallback = new Map<string, { count: number; resetAt: number }>()

  function maxPerWindow(): number {
    const v = Number(process.env[envVar])
    return Number.isFinite(v) && v >= 0 ? Math.floor(v) : defaultMax
  }

  /**
   * Throw ApiError(429) when the workspace has exceeded its requests for the
   * current fixed window; otherwise record this request and return.
   */
  async function enforce(workspaceId: string): Promise<void> {
    if (process.env.RATE_LIMIT_DISABLED === 'true') return
    const max = maxPerWindow()
    if (max <= 0) return // disabled

    const windowStart = Math.floor(Date.now() / windowMs)
    const redisKey = `rl:${name}:${workspaceId}:${windowStart}`

    let count: number
    try {
      const redis = getRedis()
      if (redis.status !== 'ready') throw new Error('Redis not ready')
      count = await redis.incr(redisKey)
      if (count === 1) await redis.expire(redisKey, Math.ceil(windowMs / 1000))
    } catch {
      const now = Date.now()
      let entry = fallback.get(workspaceId)
      if (!entry || entry.resetAt <= now) {
        entry = { count: 0, resetAt: now + windowMs }
        fallback.set(workspaceId, entry)
      }
      entry.count += 1
      count = entry.count
    }

    if (count > max) {
      // Phase 4.1: Record abuse signal when rate limits are hit
      void checkForRateLimitSpike(workspaceId).catch(() => {})
      throw new ApiError(429, message)
    }
  }

  return { enforce, _resetForTest: () => fallback.clear() }
}

// Phase 4.1: AI rate limiting per workspace per hour. The monthly quota via
// PLAN_LIMITS is the true ceiling; this hourly window is a burst limiter that
// prevents a single workspace from monopolizing shared infrastructure (OpenAI key,
// token budget) in the time window between quota checks. Tuned for realistic
// concurrent use (5 concurrent users * 20 AI calls/hour each).
const aiLimiter = createWorkspaceRateLimit({
  name: 'ws_ai',
  windowMs: 60 * 60 * 1000,
  envVar: 'WORKSPACE_AI_RATE_MAX',
  defaultMax: 500,
  message: 'Workspace AI rate limit reached (500/hour). Check monthly quota or contact support.',
})

/**
 * Throw ApiError(429) when the workspace has exceeded its AI requests for the
 * current fixed window; otherwise record this request and return.
 * Tunable via WORKSPACE_AI_RATE_MAX (default 500/hour); set 0 to disable.
 * Note: this is a burst limiter — the monthly quota (PLAN_LIMITS) is the
 * billing-relevant ceiling.
 */
export const enforceWorkspaceAiRate = aiLimiter.enforce

/** Test-only: clear the in-process fallback counters. */
export const _resetWorkspaceAiRateForTest = aiLimiter._resetForTest

// Phase 4.1: Outbound mail rate limiting per workspace per minute. Email is a
// high-abuse-cost resource (SMTP relay reputation, bounce handling) — a leaked
// workspace credential or abuse pattern must not take down the shared mail
// infrastructure. 100 emails/min = 6000 emails/hour, which allows legitimate
// sales teams to send while preventing runaway loops.
const mailLimiter = createWorkspaceRateLimit({
  name: 'ws_mail',
  windowMs: 60 * 1000,
  envVar: 'WORKSPACE_MAIL_RATE_MAX',
  defaultMax: 100,
  message: 'Workspace mail rate limit reached (100/min). Please wait before sending more email.',
})

/**
 * Throw ApiError(429) when the workspace has exceeded its outbound mail sends
 * for the current fixed window; otherwise record this request and return.
 * Tunable via WORKSPACE_MAIL_RATE_MAX (default 100/min); set 0 to disable.
 */
export const enforceWorkspaceMailRate = mailLimiter.enforce

/** Test-only: clear the in-process fallback counters. */
export const _resetWorkspaceMailRateForTest = mailLimiter._resetForTest
