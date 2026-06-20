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

function formatZodError(error: z.ZodError): string {
  return error.issues.map((e: z.ZodIssue) => `${e.path.join('.') || '<root>'}: ${e.message}`).join('; ')
}

// Inline parsers — the function form of `validate`, for routes that need to
// validate params/query (Express 5 makes req.query/req.params read-only getters,
// so they can't be reassigned by middleware) or that prefer an explicit call at
// the top of the handler. Each throws a deterministic 400 with a bounded message
// and returns the typed, parsed value. Use these so no handler touches a raw
// req.body / req.query / req.params before validation.
export function parseBody<T extends z.ZodTypeAny>(schema: T, req: { body: unknown }): z.infer<T> {
  const result = schema.safeParse(req.body)
  if (!result.success) throw new ApiError(400, formatZodError(result.error))
  return result.data
}

export function parseQuery<T extends z.ZodTypeAny>(schema: T, req: { query: unknown }): z.infer<T> {
  const result = schema.safeParse(req.query)
  if (!result.success) throw new ApiError(400, formatZodError(result.error))
  return result.data
}

export function parseParams<T extends z.ZodTypeAny>(schema: T, req: { params: unknown }): z.infer<T> {
  const result = schema.safeParse(req.params)
  if (!result.success) throw new ApiError(400, formatZodError(result.error))
  return result.data
}

// Common field schemas reused across routes
export const emailField = z.string().trim().email('Valid email required').max(254)
// Mirrors the 12-char floor enforced by validatePassword() so the schema-layer
// rejection and the explicit policy check agree (no "8 here, 12 there" drift).
export const passwordField = z.string().min(12, 'Password must be at least 12 characters').max(128)
export const workspaceIdField = z.string().min(1, 'workspaceId required')
export const nonEmptyString = z.string().trim().min(1)
