import type { Request, Response, NextFunction, RequestHandler } from 'express'
import { getRedis } from '../lib/redis.js'

interface RateLimitOptions {
  windowMs: number
  max: number
  message?: string
  keyFn?: (req: Request) => string
  name?: string
}

// Fixed-window counter backed by Redis INCR + EXPIRE.
// Falls back to a per-process Map if Redis is unavailable so a cache outage
// never takes down the API — it just weakens the per-pod limit until recovery.
export function createRateLimiter(opts: RateLimitOptions): RequestHandler {
  const { windowMs, max, name = 'rl', message = 'Too many requests, please try again later.' } = opts
  const windowSec = Math.ceil(windowMs / 1000)

  const fallback = new Map<string, { count: number; resetAt: number }>()
  const intervalMs = 5 * 60 * 1000
  const pruner = setInterval(() => {
    const now = Date.now()
    for (const [k, v] of fallback) if (v.resetAt <= now) fallback.delete(k)
  }, intervalMs)
  if (pruner.unref) pruner.unref()

  const defaultKey = (req: Request) => req.ip || req.socket?.remoteAddress || 'unknown'
  const keyFn = opts.keyFn ?? defaultKey

  return async (req: Request, res: Response, next: NextFunction) => {
    // Escape hatch for test/E2E environments where many auth requests originate
    // from a single IP and would otherwise exhaust the per-IP window. Never set
    // in production (config validation keeps prod limits on).
    if (process.env.RATE_LIMIT_DISABLED === 'true') return next()

    const clientKey = keyFn(req)
    const windowStart = Math.floor(Date.now() / windowMs)
    const redisKey = `rl:${name}:${clientKey}:${windowStart}`

    let count: number
    let resetAt: number

    try {
      const redis = getRedis()
      // Only issue commands when the client is connected — avoids hanging indefinitely
      // on `maxRetriesPerRequest: null` when Redis is unavailable (e.g. in tests).
      // Redis is connected eagerly at server startup; if it hasn't connected yet, fall back.
      if (redis.status !== 'ready') throw new Error('Redis not ready')
      count = await redis.incr(redisKey)
      if (count === 1) await redis.expire(redisKey, windowSec)
      // TTL may be -1 if expire lost the race; harmless — key expires naturally on next window
      resetAt = (windowStart + 1) * windowMs
    } catch {
      // Redis unavailable — degrade to in-process fallback
      const now = Date.now()
      let entry = fallback.get(clientKey)
      if (!entry || entry.resetAt <= now) {
        entry = { count: 0, resetAt: now + windowMs }
        fallback.set(clientKey, entry)
      }
      entry.count += 1
      count = entry.count
      resetAt = entry.resetAt
    }

    res.setHeader('X-RateLimit-Limit', max)
    res.setHeader('X-RateLimit-Remaining', Math.max(0, max - count))
    res.setHeader('X-RateLimit-Reset', Math.ceil(resetAt / 1000))

    if (count > max) {
      res.setHeader('Retry-After', Math.ceil((resetAt - Date.now()) / 1000))
      return res.status(429).json({ error: message })
    }

    return next()
  }
}

// 10 auth attempts per 15 minutes per IP
export const authRateLimit = createRateLimiter({
  name: 'auth',
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many authentication attempts. Please wait before trying again.'
})

// 60 AI requests per hour per IP (generous for demos)
export const aiRateLimit = createRateLimiter({
  name: 'ai',
  windowMs: 60 * 60 * 1000,
  max: 60,
  message: 'AI rate limit reached. Please wait before making more AI requests.'
})

// 200 general API requests per minute per IP
export const generalRateLimit = createRateLimiter({
  name: 'general',
  windowMs: 60 * 1000,
  max: 200,
  message: 'Request limit reached. Please slow down.'
})

// 5 outbound mail sends per hour per IP (prevents spam abuse)
export const mailRateLimit = createRateLimiter({
  name: 'mail',
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: 'Too many emails sent. Please wait before sending more.'
})

// 10 IMAP sync triggers per hour per IP
export const syncRateLimit = createRateLimiter({
  name: 'sync',
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: 'Too many sync requests. Please wait before syncing again.'
})

// Machine-to-machine ingest/outcomes endpoints authenticate via x-api-key, so a
// leaked key should be throttled by the key itself, not just the shared per-IP
// window (many requests can share one source IP). Falls back to IP when no key
// is present so the limiter still applies before auth rejects the request.
export const apiKeyRateLimit = createRateLimiter({
  name: 'apikey',
  windowMs: 60 * 1000,
  max: 120,
  message: 'API key request limit reached. Please slow down.',
  keyFn: (req) => {
    const key = req.headers['x-api-key']
    const k = Array.isArray(key) ? key[0] : key
    return k ? `k:${k}` : `ip:${req.ip || req.socket?.remoteAddress || 'unknown'}`
  }
})

// The public unsubscribe endpoint is unauthenticated and state-changing; throttle
// it per IP independently of the general window so it can't be hammered.
export const unsubscribeRateLimit = createRateLimiter({
  name: 'unsub',
  windowMs: 60 * 1000,
  max: 20,
  message: 'Too many unsubscribe requests. Please wait a moment.'
})
