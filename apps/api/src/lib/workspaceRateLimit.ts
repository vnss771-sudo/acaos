import { getRedis } from './redis.js'
import { ApiError } from './http.js'

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
  // Tighter ceiling enforced ONLY while Redis is unavailable AND NODE_ENV is
  // 'production' — same "tighten on degrade" stance as createRateLimiter in
  // middleware/rateLimit.ts. The in-process fallback below is per-pod, so a
  // multi-pod deployment's real aggregate ceiling during an outage is
  // (pod count × max) instead of the intended global max; dropping to
  // degradedMax keeps a compromised workspace's burst capacity bounded
  // instead of silently multiplying by fleet size. Defaults to `max` (no
  // change) and never applies in dev/test.
  degradedMax?: number
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
    // Effective ceiling for this request: the normal max while Redis is
    // serving, or the tighter degradedMax while on the in-process fallback
    // in production.
    let effectiveMax = max
    try {
      const redis = getRedis()
      if (redis.status !== 'ready') throw new Error('Redis not ready')
      count = await redis.incr(redisKey)
      if (count === 1) await redis.expire(redisKey, Math.ceil(windowMs / 1000))
    } catch {
      if (process.env.NODE_ENV === 'production') effectiveMax = Math.min(max, opts.degradedMax ?? max)
      const now = Date.now()
      let entry = fallback.get(workspaceId)
      if (!entry || entry.resetAt <= now) {
        entry = { count: 0, resetAt: now + windowMs }
        fallback.set(workspaceId, entry)
      }
      entry.count += 1
      count = entry.count
    }

    if (count > effectiveMax) {
      throw new ApiError(429, message)
    }
  }

  return { enforce, _resetForTest: () => fallback.clear() }
}

const aiLimiter = createWorkspaceRateLimit({
  name: 'ws_ai',
  windowMs: 60 * 60 * 1000,
  envVar: 'WORKSPACE_AI_RATE_MAX',
  defaultMax: 120,
  degradedMax: 30,
  message: 'Workspace AI rate limit reached. Please wait before making more AI requests.',
})

/**
 * Throw ApiError(429) when the workspace has exceeded its AI requests for the
 * current fixed window; otherwise record this request and return.
 * Tunable via WORKSPACE_AI_RATE_MAX (default 120/hour); set 0 to disable.
 */
export const enforceWorkspaceAiRate = aiLimiter.enforce

/** Test-only: clear the in-process fallback counters. */
export const _resetWorkspaceAiRateForTest = aiLimiter._resetForTest

// Outbound mail (send-test, and any future workspace-scoped send path) is a
// lower-volume, higher-abuse-cost resource than AI generation — a leaked
// workspace credential spraying test/relay sends is a deliverability and SMTP
// reputation risk regardless of how many source IPs it rotates through.
const mailLimiter = createWorkspaceRateLimit({
  name: 'ws_mail',
  windowMs: 60 * 60 * 1000,
  envVar: 'WORKSPACE_MAIL_RATE_MAX',
  defaultMax: 30,
  degradedMax: 10,
  message: 'Workspace mail rate limit reached. Please wait before sending more email.',
})

/**
 * Throw ApiError(429) when the workspace has exceeded its outbound mail sends
 * for the current fixed window; otherwise record this request and return.
 * Tunable via WORKSPACE_MAIL_RATE_MAX (default 30/hour); set 0 to disable.
 */
export const enforceWorkspaceMailRate = mailLimiter.enforce

/** Test-only: clear the in-process fallback counters. */
export const _resetWorkspaceMailRateForTest = mailLimiter._resetForTest
