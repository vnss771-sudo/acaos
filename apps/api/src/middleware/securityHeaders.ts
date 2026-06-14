import type { Request, Response, NextFunction } from 'express'
import { isProduction } from '../lib/config.js'

// Strict CSP for JSON API responses: nothing is loadable or executable, so any
// accidental HTML/script in a response body is inert.
const API_CSP = "default-src 'none'; frame-ancestors 'none'"

// CSP for the co-located web SPA (served from the same origin as the API).
// Everything loads from 'self'; inline styles are allowed because index.html
// ships a small inline <style> block and the UI uses inline style attributes.
// connect-src 'self' covers the same-origin /api calls.
const WEB_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ')

// Conservative security headers. The API serves JSON under /api and the web SPA
// from every other path; the CSP is tailored per request so the JSON surface
// stays maximally locked down while the SPA can load its own assets.
export function securityHeaders(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
  res.setHeader('X-DNS-Prefetch-Control', 'off')
  // Default to the strict API policy; only the co-located SPA's own routes get
  // the relaxed policy. A missing path (defensive) stays strict.
  const isApiPath = !req.path || req.path.startsWith('/api')
  res.setHeader('Content-Security-Policy', isApiPath ? API_CSP : WEB_CSP)

  // HSTS only over real TLS — sending it on plain-HTTP localhost would wrongly
  // pin browsers to https for the dev host.
  if (isProduction()) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  }
  next()
}
