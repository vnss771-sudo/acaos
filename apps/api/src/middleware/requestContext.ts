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
  const requestId = (Array.isArray(inbound) ? inbound[0] : inbound)?.trim() || randomUUID()

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
