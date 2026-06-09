import type { Request, Response, NextFunction, RequestHandler } from 'express'
import IORedis from 'ioredis'

// ── Redis client (lazy, graceful fallback) ────────────────────────────────────

let _redis: IORedis | null = null
let _redisFailed = false

function getRedis(): IORedis | null {
  if (_redisFailed) return null
  if (!_redis && process.env.REDIS_URL) {
    _redis = new IORedis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 1,
      enableReadyCheck: false,
      lazyConnect: true,
      connectTimeout: 2000,
    })
    _redis.on('error', () => {
      _redisFailed = true
      _redis = null
    })
  }
  return _redis
}

// ── In-memory fallback (single-instance only) ─────────────────────────────────

interface WindowEntry { count: number; resetAt: number }
const memStore = new Map<string, WindowEntry>()
const pruneInterval = setInterval(() => {
  const now = Date.now()
  for (const [k, e] of memStore) { if (e.resetAt <= now) memStore.delete(k) }
}, 5 * 60 * 1000)
if (pruneInterval.unref) pruneInterval.unref()

async function increment(key: string, windowMs: number): Promise<{ count: number; resetAt: number }> {
  const redis = getRedis()
  if (redis) {
    try {
      // Fixed-window with atomic INCR — safe across multiple instances
      const windowKey = `rl:${key}:${Math.floor(Date.now() / windowMs)}`
      const count = await redis.incr(windowKey)
      if (count === 1) await redis.pexpire(windowKey, windowMs)
      const ttl = await redis.pttl(windowKey)
      const resetAt = Date.now() + Math.max(0, ttl)
      return { count, resetAt }
    } catch {
      // Redis error mid-flight — fall through to memory
    }
  }

  // Memory fallback
  const now = Date.now()
  let entry = memStore.get(key)
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + windowMs }
    memStore.set(key, entry)
  }
  entry.count += 1
  return { count: entry.count, resetAt: entry.resetAt }
}

// ── Factory ───────────────────────────────────────────────────────────────────

interface RateLimitOptions {
  windowMs: number
  max: number
  message?: string
  keyFn?: (req: Request) => string
}

function defaultKey(req: Request): string {
  const fwd = req.headers['x-forwarded-for']
  const ip = Array.isArray(fwd) ? fwd[0] : fwd?.split(',')[0]?.trim()
  return ip || req.socket?.remoteAddress || 'unknown'
}

export function createRateLimiter(opts: RateLimitOptions): RequestHandler {
  const { windowMs, max, message = 'Too many requests, please try again later.', keyFn } = opts
  const getKey = keyFn ?? defaultKey

  return async (req: Request, res: Response, next: NextFunction) => {
    const key = getKey(req)
    const { count, resetAt } = await increment(key, windowMs)

    res.setHeader('X-RateLimit-Limit', max)
    res.setHeader('X-RateLimit-Remaining', Math.max(0, max - count))
    res.setHeader('X-RateLimit-Reset', Math.ceil(resetAt / 1000))

    if (count > max) {
      const retryAfter = Math.ceil((resetAt - Date.now()) / 1000)
      res.setHeader('Retry-After', retryAfter)
      return res.status(429).json({ error: message })
    }
    return next()
  }
}

// ── Named limiters ────────────────────────────────────────────────────────────

// 10 auth attempts per 15 minutes per IP
export const authRateLimit = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many authentication attempts. Please wait before trying again.'
})

// 60 AI requests per hour per IP
export const aiRateLimit = createRateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 60,
  message: 'AI rate limit reached. Please wait before making more AI requests.'
})

// 200 general API requests per minute per IP
export const generalRateLimit = createRateLimiter({
  windowMs: 60 * 1000,
  max: 200,
  message: 'Request limit reached. Please slow down.'
})

// 5 outbound mail sends per hour per IP
export const mailRateLimit = createRateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: 'Too many emails sent. Please wait before sending more.'
})

// 10 IMAP sync triggers per hour per IP
export const syncRateLimit = createRateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: 'Too many sync requests. Please wait before syncing again.'
})
