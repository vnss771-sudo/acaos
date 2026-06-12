import type { Request, Response, NextFunction } from 'express'
import { isProduction } from '../lib/config.js'

// Conservative security headers appropriate for a JSON API. Hand-rolled to
// avoid an extra dependency; covers the same ground as a default `helmet()`
// for a non-HTML service.
export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
  res.setHeader('X-DNS-Prefetch-Control', 'off')
  // The API only ever returns JSON, so the strictest CSP is safe and blocks
  // any accidental HTML/script from being interpreted.
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")

  // HSTS only over real TLS — sending it on plain-HTTP localhost would wrongly
  // pin browsers to https for the dev host.
  if (isProduction()) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  }
  next()
}
