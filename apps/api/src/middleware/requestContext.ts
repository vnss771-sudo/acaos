import type { Request, Response, NextFunction } from 'express'
import { randomUUID } from 'node:crypto'
import { logger } from '../lib/logger.js'

// Augment Express's Request with our per-request fields.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      id?: string
      log?: ReturnType<typeof logger.child>
    }
  }
}

/**
 * Assigns each request a correlation id (honoring an inbound `X-Request-Id`),
 * echoes it back on the response, attaches a child logger, and emits one
 * structured access-log line per completed request.
 */
export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const inbound = req.headers['x-request-id']
  const raw = (Array.isArray(inbound) ? inbound[0] : inbound)?.trim()
  // Allow alphanumeric + hyphens/underscores only (≤128 chars) to prevent
  // header-injection and log-injection via CRLF or JSON-breaking characters.
  const SAFE_ID_RE = /^[a-z0-9_-]{1,128}$/i
  const requestId = raw && SAFE_ID_RE.test(raw) ? raw : randomUUID()

  req.id = requestId
  req.log = logger.child({ requestId })
  res.setHeader('X-Request-Id', requestId)

  const start = process.hrtime.bigint()
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'
    req.log?.[level]('request', {
      method: req.method,
      path: req.originalUrl.split('?')[0],
      status: res.statusCode,
      durationMs: Math.round(durationMs),
    })
  })

  next()
}
