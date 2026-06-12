import type { NextFunction, Request, Response, RequestHandler } from 'express'
import { cfg } from './env.js'
import { logger } from './logger.js'

export class ApiError extends Error {
  statusCode: number

  constructor(statusCode: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.statusCode = statusCode
  }
}

function isProduction() {
  return cfg.nodeEnv === 'production'
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

export function errorHandler(error: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (error instanceof ApiError) {
    return res.status(error.statusCode).json({ error: error.message })
  }

  logger.error({ err: error }, 'Unhandled error')

  const message =
    !isProduction() && error instanceof Error && error.message
      ? error.message
      : 'Internal server error'

  return res.status(500).json({ error: message })
}
