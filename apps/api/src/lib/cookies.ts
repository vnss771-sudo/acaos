// HttpOnly refresh-token cookie helpers + CSRF guard for the cookie-authenticated
// auth endpoints.
//
// The refresh token is stored in an HttpOnly cookie so it is never readable by
// JavaScript (defeating token theft via XSS or a malicious dependency). The
// short-lived access token continues to travel in the response body and is held
// in memory by the SPA, and is sent on the Authorization header — so the main
// API stays immune to CSRF (cookies are not used to authenticate it).
//
// Deployment note: the cookie is first-party `SameSite=Lax` by default, which
// requires the web app and API to be served from the SAME SITE in production
// (e.g. acaos.app + api.acaos.app). Cross-site (third-party) cookies are blocked
// by Safari and being phased out by Chrome, so a cross-origin API is not a
// supported topology. SameSite/secure are overridable via env for flexibility.

import type { Request, Response, NextFunction } from 'express'

export const REFRESH_COOKIE = 'acaos_refresh'
const COOKIE_PATH = '/api/auth'

function sameSite(): 'lax' | 'strict' | 'none' {
  const v = (process.env.COOKIE_SAMESITE || 'lax').toLowerCase()
  return v === 'strict' || v === 'none' ? v : 'lax'
}

function secure(): boolean {
  // Explicit override wins; otherwise Secure in production, and always required
  // when SameSite=None (browsers reject SameSite=None without Secure).
  if (process.env.COOKIE_SECURE != null) return process.env.COOKIE_SECURE === 'true'
  return process.env.NODE_ENV === 'production' || sameSite() === 'none'
}

function refreshMaxAgeMs(): number {
  const days = Number(process.env.REFRESH_TOKEN_DAYS || 30)
  return days * 24 * 60 * 60 * 1000
}

export function setRefreshCookie(res: Response, token: string): void {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: secure(),
    sameSite: sameSite(),
    path: COOKIE_PATH,
    maxAge: refreshMaxAgeMs(),
  })
}

export function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, {
    httpOnly: true,
    secure: secure(),
    sameSite: sameSite(),
    path: COOKIE_PATH,
  })
}

/** Read a single cookie value from the request without a cookie-parser dep. */
export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie
  if (!header) return null
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim())
    }
  }
  return null
}

/**
 * CSRF guard for cookie-authenticated endpoints (/refresh, /logout). Requires a
 * custom request header that a cross-site attacker cannot set on a credentialed
 * request without a CORS preflight grant — which the origin allowlist denies.
 * Combined with the SameSite cookie attribute this gives layered CSRF defense.
 */
export function requireCsrfHeader(req: Request, res: Response, next: NextFunction): void {
  if (req.headers['x-csrf-protection'] !== '1') {
    res.status(403).json({ error: 'CSRF protection header required' })
    return
  }
  next()
}
