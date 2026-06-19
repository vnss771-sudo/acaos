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

// Variables without which the API cannot function at all in production.
const REQUIRED_IN_PRODUCTION = [
  'DATABASE_URL',
  'JWT_SECRET',
  'EMAIL_ENCRYPTION_KEY',
  'REDIS_URL',
] as const

// Variables required only when their feature is in use. Missing values produce
// a startup warning rather than a hard crash — the operator may intentionally
// deploy without Stripe or AI configured during initial rollout.
const FEATURE_GATED: Array<{ key: string; feature: string }> = [
  { key: 'OPENAI_API_KEY', feature: 'AI features (research, outreach, classification)' },
  { key: 'STRIPE_SECRET_KEY', feature: 'Billing (Stripe)' },
  { key: 'STRIPE_WEBHOOK_SECRET', feature: 'Stripe webhook validation' },
]

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
    // Rate limiting must never be disabled in production — one stray env var would
    // drop auth/AI/mail/sync throttles. Refuse to boot rather than run wide open.
    if (process.env.RATE_LIMIT_DISABLED === 'true') {
      problems.push('RATE_LIMIT_DISABLED must not be "true" in production')
    }
    // /metrics serves openly when METRICS_TOKEN is unset; the endpoint itself
    // fails closed in production (404), but warn so operators set a token or front
    // it with network ACLs deliberately.
    if (!process.env.METRICS_TOKEN?.trim()) {
      console.warn('[config] METRICS_TOKEN not set — /metrics is disabled in production (returns 404)')
    }
    for (const { key, feature } of FEATURE_GATED) {
      if (!process.env[key]?.trim()) {
        console.warn(`[config] ${key} not set — ${feature} will be unavailable`)
      }
    }
    if (getAllowedOrigins().length === 0) {
      // Warn but don't crash — CORS middleware will reject cross-origin requests
      // regardless. This allows the API to start before the web frontend URL is known.
      console.warn('[config] ALLOWED_ORIGINS and WEB_URL are not set — all cross-origin requests will be rejected')
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

/** Returns a structured readiness report for /api/ready. */
export function getReadinessReport() {
  const missing: string[] = []
  for (const key of REQUIRED_IN_PRODUCTION) {
    if (!process.env[key]?.trim()) missing.push(key)
  }
  const features = FEATURE_GATED.map(({ key, feature }) => ({
    feature,
    configured: Boolean(process.env[key]?.trim()),
  }))
  return { ready: missing.length === 0, missing, features }
}
