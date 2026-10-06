import cors from 'cors'
import type { RequestHandler } from 'express'
import { isOriginAllowed, corsAllowsAnyOrigin } from '@acaos/backend-core/lib/config.js'

// How long a browser may reuse a preflight answer for the same URL. Every API
// call carries Authorization or a JSON body, so without this the browser sent
// an OPTIONS before each one: 98 of 201 requests in the live test. Ten minutes
// keeps an allowlist change from lingering in browsers.
export const CORS_PREFLIGHT_MAX_AGE_SECONDS = 600

export function corsMiddleware(): RequestHandler {
  return cors({
    // Reflecting any origin with credentials:true is only safe in the two explicit
    // local envs — gating this on isProduction() instead would leave staging,
    // preview, and an unset/typo'd NODE_ENV wide open to credentialed cross-origin
    // requests from any site.
    origin: corsAllowsAnyOrigin()
      ? true
      : (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => cb(null, isOriginAllowed(origin)),
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Protection'],
    maxAge: CORS_PREFLIGHT_MAX_AGE_SECONDS,
  })
}
