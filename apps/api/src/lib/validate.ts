import { z } from 'zod'
import type { Request, Response, NextFunction, RequestHandler } from 'express'
import { ApiError } from './http.js'

// Thin Zod middleware: parse req.body against schema, replace with typed value.
// Returns a RequestHandler that throws 400 with a human-readable message on failure.
export function validate<T extends z.ZodTypeAny>(schema: T): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body)
    if (!result.success) {
      const msg = result.error.issues.map((e: z.ZodIssue) => `${e.path.join('.')}: ${e.message}`).join('; ')
      return next(new ApiError(400, msg))
    }
    req.body = result.data
    return next()
  }
}

// Common field schemas reused across routes
export const emailField = z.string().trim().email('Valid email required').max(254)
export const passwordField = z.string().min(8, 'Password must be at least 8 characters').max(128)
export const workspaceIdField = z.string().min(1, 'workspaceId required')
export const nonEmptyString = z.string().trim().min(1)
