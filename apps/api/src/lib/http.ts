import type { NextFunction, Request, Response, RequestHandler } from 'express'
import { verboseErrors } from './config.js'
import { logger } from './logger.js'

export class ApiError extends Error {
  statusCode: number

  constructor(statusCode: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.statusCode = statusCode
  }
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
  if (error instanceof ApiError) {
    return res.status(error.statusCode).json({ error: error.message })
  }

  // Log the full error (with request id for correlation); never leak it to the
  // client unless explicitly in development.
  const log = req.log ?? logger
  log.error('unhandled error', { err: error, path: req.originalUrl })

  const message =
    verboseErrors() && error instanceof Error && error.message
      ? error.message
      : 'Internal server error'

  return res.status(500).json({ error: message })
}
