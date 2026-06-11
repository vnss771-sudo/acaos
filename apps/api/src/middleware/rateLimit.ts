import type { Request, Response, NextFunction, RequestHandler } from 'express'

interface RateLimitOptions {
  windowMs: number
  max: number
  message?: string
  keyFn?: (req: Request) => string
}

interface WindowEntry {
  count: number
  resetAt: number
}

export function createRateLimiter(opts: RateLimitOptions): RequestHandler {
  const store = new Map<string, WindowEntry>()
  const { windowMs, max, message = 'Too many requests, please try again later.' } = opts

  // Prune stale entries every 5 minutes
  const interval = setInterval(() => {
    const now = Date.now()
    for (const [key, entry] of store) {
      if (entry.resetAt <= now) store.delete(key)
    }
  }, 5 * 60 * 1000)
  if (interval.unref) interval.unref()

  const defaultKey = (req: Request) => {
    const forwarded = req.headers['x-forwarded-for']
    const ip = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0]?.trim()
    return ip || req.socket.remoteAddress || 'unknown'
  }

  const keyFn = opts.keyFn ?? defaultKey

  return (req: Request, res: Response, next: NextFunction) => {
    const key = keyFn(req)
    const now = Date.now()

    let entry = store.get(key)
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs }
      store.set(key, entry)
    }

    entry.count += 1

    res.setHeader('X-RateLimit-Limit', max)
    res.setHeader('X-RateLimit-Remaining', Math.max(0, max - entry.count))
    res.setHeader('X-RateLimit-Reset', Math.ceil(entry.resetAt / 1000))

    if (entry.count > max) {
      res.setHeader('Retry-After', Math.ceil((entry.resetAt - now) / 1000))
      return res.status(429).json({ error: message })
    }

    return next()
  }
}

// 10 auth attempts per 15 minutes per IP
export const authRateLimit = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many authentication attempts. Please wait before trying again.'
})

// 60 AI requests per hour per IP (generous for demos)
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

// 5 outbound mail sends per hour per IP (prevents spam abuse)
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

// 20 ingest batch requests per 5 minutes per API key (prevents runaway scrapers)
export const ingestRateLimit = createRateLimiter({
  windowMs: 5 * 60 * 1000,
  max: 20,
  message: 'Ingest rate limit reached. Please wait before submitting more leads.',
  keyFn: (req) => {
    const key = req.headers['x-api-key']
    return (Array.isArray(key) ? key[0] : key) || req.socket.remoteAddress || 'unknown'
  }
})
