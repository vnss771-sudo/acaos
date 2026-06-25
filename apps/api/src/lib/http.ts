import type { NextFunction, Request, Response, RequestHandler } from 'express'
import { verboseErrors } from './config.js'
import { logger } from './logger.js'
import { CircuitOpenError } from './circuit.js'
import { captureError } from './observability.js'
import { ApiError } from '@acaos/backend-core/lib/errors.js'
import type { AuthUser } from '../types/auth.js'

// ApiError is defined framework-agnostically in backend-core so shared services
// can throw it; re-exported here so the rest of the API keeps importing it from
// '../lib/http.js'.
export { ApiError }

// Resolve the authenticated user, or throw a clean 401. Replaces the repeated
// `req.user!` non-null assertion: that assertion is only safe because requireAuth
// runs first, so a route accidentally mounted WITHOUT requireAuth would dereference
// undefined at runtime with no compile-time signal. requireUser turns that latent
// NPE into an explicit, typed 401 and returns a non-optional AuthUser.
export function requireUser(req: Request): AuthUser {
  const user = req.user
  if (!user) throw new ApiError(401, 'Authentication required')
  return user
}

export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
): RequestHandler {
  return (req, res, next) => {
    void handler(req, res, next).catch(next)
  }
}

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ error: 'Not found' })
}

export function errorHandler(error: unknown, req: Request, res: Response, _next: NextFunction) {
  // When headers have already been sent (e.g. a streaming export mid-flight),
  // attempting to set status/headers again throws ERR_HTTP_HEADERS_SENT.
  // Destroy the socket so the client sees a network error rather than a
  // silently truncated file.
  if (res.headersSent) {
    res.destroy()
    return
  }

  if (error instanceof ApiError) {
    return res.status(error.statusCode).json({ error: error.message })
  }

  if (error instanceof CircuitOpenError) {
    res.set('Retry-After', String(Math.ceil(error.retryAfterMs / 1000)))
    return res.status(503).json({ error: error.message })
  }

  // Log the full error (with request id for correlation); never leak it to the
  // client unless explicitly in development. Only unexpected errors reach here
  // (ApiError / CircuitOpenError returned above), so this is the right place to
  // forward to an error-reporting transport.
  const log = req.log ?? logger
  log.error('unhandled error', { err: error, path: req.originalUrl })
  captureError(error, { path: req.originalUrl, method: req.method, requestId: req.id })

  const message =
    verboseErrors() && error instanceof Error && error.message
      ? error.message
      : 'Internal server error'

  return res.status(500).json({ error: message })
}
