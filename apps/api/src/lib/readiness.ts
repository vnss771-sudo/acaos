import { createHash, timingSafeEqual } from 'node:crypto'
import { isProduction } from '@acaos/backend-core/lib/config.js'

// Constant-time bearer-token check. Hashing both sides to a fixed-length digest
// before comparing means timingSafeEqual never sees a length mismatch (it throws
// on unequal lengths) and the comparison leaks neither the token's length nor a
// matching prefix via timing. Matches the timingSafeEqual style used for TOTP.
export function timingSafeBearerMatch(authorization: string | undefined, token: string): boolean {
  const presented = createHash('sha256').update(authorization ?? '').digest()
  const expected = createHash('sha256').update(`Bearer ${token}`).digest()
  return timingSafeEqual(presented, expected)
}

// Public health/readiness payloads stay minimal and orchestrator-safe (boolean
// status + service + release metadata) so they disclose no operational map to the
// internet. Detailed diagnostics — dependency state, config gaps (which env vars
// are unset), feature-provider flags, env, commit — are gated behind a bearer
// token, exactly like /metrics: a configured READINESS_TOKEN (or METRICS_TOKEN as
// a fallback, so ops need not manage two) must be presented. The gate fails CLOSED
// for the detail only — the basic probe always answers — and stays open in
// dev/test for convenience when no token is configured.
export function readinessDetailAllowed(authorization: string | undefined): boolean {
  const token = (process.env.READINESS_TOKEN || process.env.METRICS_TOKEN)?.trim()
  if (!token) return !isProduction()
  return timingSafeBearerMatch(authorization, token)
}
