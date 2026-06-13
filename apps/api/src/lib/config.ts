// Centralized runtime configuration and boot-time validation.
//
// Two goals:
//  1. Replace scattered `process.env.NODE_ENV === 'production'` checks (which
//     silently misbehave for any other value such as "staging") with explicit,
//     auditable helpers.
//  2. Fail fast at startup when required configuration is missing or weak,
//     rather than surfacing it as a deep runtime 503 on the first request.

import { getJwtSecret } from './jwt.js'

export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production'
}

/**
 * Whether internal error details may be returned to clients. Opaque by default
 * — only the explicit `development` environment is verbose, so a misconfigured
 * staging deploy never leaks stack-adjacent error text.
 */
export function verboseErrors(): boolean {
  return process.env.NODE_ENV === 'development'
}

/**
 * Exact CORS origin allowlist. Driven by `ALLOWED_ORIGINS` (comma-separated),
 * falling back to `WEB_URL`. Provider wildcards (e.g. any *.vercel.app) are
 * intentionally NOT honored — they trust every tenant on a shared platform.
 */
export function getAllowedOrigins(): string[] {
  const raw = process.env.ALLOWED_ORIGINS || process.env.WEB_URL || ''
  return raw.split(',').map((s) => s.trim()).filter(Boolean)
}

export function isOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return false
  return getAllowedOrigins().includes(origin)
}

// Variables without which the API cannot function in production.
const REQUIRED_IN_PRODUCTION = ['DATABASE_URL', 'JWT_SECRET'] as const

/**
 * Validate configuration at process start. Throws a single aggregated error
 * listing every problem so a misconfigured deploy fails immediately and loudly.
 */
export function validateConfig(): void {
  const problems: string[] = []

  if (isProduction()) {
    for (const key of REQUIRED_IN_PRODUCTION) {
      if (!process.env[key]?.trim()) problems.push(`${key} is required in production`)
    }
    if (getAllowedOrigins().length === 0) {
      problems.push('ALLOWED_ORIGINS (or WEB_URL) must list at least one allowed origin in production')
    }
  } else if (process.env.NODE_ENV === undefined) {
    console.warn('[config] NODE_ENV is not set — defaulting to non-production behavior. Set NODE_ENV=production for deployments.')
  }

  // Eagerly resolve the JWT secret so a weak/placeholder/missing value fails at
  // boot rather than on the first authenticated request.
  if (process.env.JWT_SECRET || isProduction()) {
    try {
      getJwtSecret()
    } catch (err) {
      problems.push(err instanceof Error ? err.message : 'invalid JWT_SECRET')
    }
  }

  const unique = [...new Set(problems)]
  if (unique.length > 0) {
    throw new Error(`Invalid configuration:\n  - ${unique.join('\n  - ')}`)
  }
}
