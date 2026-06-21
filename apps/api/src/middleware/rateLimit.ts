import type { Request, Response, NextFunction, RequestHandler } from 'express'
import { getRedis } from '../lib/redis.js'
import { hashApiKey } from '../lib/apiKeys.js'
import { normalizeEmail } from '../lib/validation.js'

interface RateLimitOptions {
  windowMs: number
  max: number
  message?: string
  // Return the bucket key, or null/'' to skip limiting this request entirely
  // (e.g. a per-account limiter when the request carries no account identifier).
  keyFn?: (req: Request) => string | null
  name?: string
  // Tighter ceiling enforced ONLY while Redis is unavailable AND NODE_ENV is
  // 'production' — the "tighten on degrade" stance (review finding #9). In a real
  // outage the limiter falls back to a per-pod in-process counter, so global
  // enforcement weakens; dropping to degradedMax keeps brute-force HARDER, not
  // easier, without the self-DoS of failing fully closed. Defaults to `max`
  // (no change) and never applies in dev/test, so unit tests see the real limit.
  degradedMax?: number
}

// Fixed-window counter backed by Redis INCR + EXPIRE.
// Falls back to a per-process Map if Redis is unavailable so a cache outage
// never takes down the API — it just weakens the per-pod limit until recovery.
export function createRateLimiter(opts: RateLimitOptions): RequestHandler {
  const { windowMs, max, name = 'rl', message = 'Too many requests, please try again later.' } = opts
  const degradedMax = opts.degradedMax ?? max
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
    // No bucket key (e.g. per-account limiter on a request with no account) —
    // nothing to limit; let it through to the next limiter / handler.
    if (!clientKey) return next()
    const windowStart = Math.floor(Date.now() / windowMs)
    const redisKey = `rl:${name}:${clientKey}:${windowStart}`

    let count: number
    let resetAt: number
    // Effective ceiling for THIS request: the normal max when Redis is serving,
    // or the tighter degradedMax while we're on the in-process fallback in prod.
    let effectiveMax = max

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
      // Redis unavailable — degrade to in-process fallback. In production, tighten
      // the ceiling to degradedMax so losing the shared counter doesn't loosen
      // protection (review finding #9). Never tighten in dev/test.
      if (process.env.NODE_ENV === 'production') effectiveMax = Math.min(max, degradedMax)
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

    res.setHeader('X-RateLimit-Limit', effectiveMax)
    res.setHeader('X-RateLimit-Remaining', Math.max(0, effectiveMax - count))
    res.setHeader('X-RateLimit-Reset', Math.ceil(resetAt / 1000))

    if (count > effectiveMax) {
      res.setHeader('Retry-After', Math.ceil((resetAt - Date.now()) / 1000))
      return res.status(429).json({ error: message })
    }

    return next()
  }
}

const AUTH_WINDOW_MS = 15 * 60 * 1000
const AUTH_MESSAGE = 'Too many authentication attempts. Please wait before trying again.'

// Per-IP: 10 auth attempts / 15 min (3 while Redis is degraded in prod).
const authIpRateLimit = createRateLimiter({
  name: 'auth',
  windowMs: AUTH_WINDOW_MS,
  max: 10,
  degradedMax: 3,
  message: AUTH_MESSAGE,
})

// Per-account: 10 attempts / 15 min against a single email, independent of source
// IP (review finding #9 — per-account limits). Stops a distributed/rotating-IP
// brute force against one account that the per-IP window alone can't see. Skips
// requests with no email in the body (e.g. /refresh, /verify-totp), which the
// per-IP limiter still covers.
const authAccountRateLimit = createRateLimiter({
  name: 'auth_acct',
  windowMs: AUTH_WINDOW_MS,
  max: 10,
  degradedMax: 3,
  message: AUTH_MESSAGE,
  keyFn: (req) => {
    const raw = (req.body as { email?: unknown } | undefined)?.email
    if (typeof raw !== 'string' || !raw.trim()) return null
    return `acct:${normalizeEmail(raw)}`
  },
})

// Auth limiter = per-IP AND per-account. The account check only runs if the per-IP
// check passes (createRateLimiter calls next() only when under the limit), so a
// 429 from either short-circuits with its own headers/message.
export const authRateLimit: RequestHandler = (req, res, next) => {
  authIpRateLimit(req, res, (err?: unknown) => {
    if (err) return next(err)
    authAccountRateLimit(req, res, next)
  })
}

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
    // Key by the SHA-256 of the API key (same hash the ingest lookup stores), so
    // the raw secret never lands in the Redis keyspace, MONITOR output, metrics,
    // or backups. The key is a 256-bit random token (randomBytes(32)), so a fast
    // hash is correct here — and required, since this runs per request.
    if (k) return `k:${hashApiKey(k)}`
    return `ip:${req.ip || req.socket?.remoteAddress || 'unknown'}`
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
