// Tests for lib/config.ts (env-driven behavior flags + boot validation) and the
// securityHeaders middleware.

import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { isProduction, verboseErrors, getAllowedOrigins, isOriginAllowed, validateConfig } from '../packages/backend-core/src/lib/config.ts'
import { securityHeaders } from '../apps/api/src/middleware/securityHeaders.ts'
import type { Request, Response } from 'express'

const SAVED = { ...process.env }
afterEach(() => {
  // Restore env to its original state after each test.
  for (const k of Object.keys(process.env)) if (!(k in SAVED)) delete process.env[k]
  Object.assign(process.env, SAVED)
})

function setEnv(env: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

// --- behavior flags ---

test('isProduction / verboseErrors are exact-match (staging is treated as non-dev)', () => {
  setEnv({ NODE_ENV: 'production' })
  assert.equal(isProduction(), true)
  assert.equal(verboseErrors(), false)

  setEnv({ NODE_ENV: 'staging' })
  assert.equal(isProduction(), false)
  assert.equal(verboseErrors(), false) // NOT verbose — the SEC-7 fix

  setEnv({ NODE_ENV: 'development' })
  assert.equal(verboseErrors(), true)
})

test('origin allowlist is exact and ignores provider wildcards', () => {
  setEnv({ ALLOWED_ORIGINS: 'https://app.acme.com, https://admin.acme.com', WEB_URL: undefined })
  assert.deepEqual(getAllowedOrigins(), ['https://app.acme.com', 'https://admin.acme.com'])
  assert.equal(isOriginAllowed('https://app.acme.com'), true)
  assert.equal(isOriginAllowed('https://evil.vercel.app'), false)
  assert.equal(isOriginAllowed(undefined), false)
})

test('origin allowlist falls back to WEB_URL', () => {
  setEnv({ ALLOWED_ORIGINS: undefined, WEB_URL: 'https://only.acme.com' })
  assert.deepEqual(getAllowedOrigins(), ['https://only.acme.com'])
})

// --- boot validation ---

test('validateConfig passes in development with no special config', () => {
  setEnv({ NODE_ENV: 'development', JWT_SECRET: undefined })
  assert.doesNotThrow(() => validateConfig())
})

test('validateConfig fails fast in production when required vars are missing', () => {
  setEnv({ NODE_ENV: 'production', DATABASE_URL: undefined, JWT_SECRET: undefined, ALLOWED_ORIGINS: undefined, WEB_URL: undefined })
  assert.throws(() => validateConfig(), (e: Error) => {
    assert.match(e.message, /DATABASE_URL is required/)
    assert.match(e.message, /JWT_SECRET is required/)
    // ALLOWED_ORIGINS is now a warning (not fatal) so it must not appear here
    assert.doesNotMatch(e.message, /ALLOWED_ORIGINS/)
    return true
  })
})

test('validateConfig rejects a weak JWT secret even in development', () => {
  setEnv({ NODE_ENV: 'development', JWT_SECRET: 'change-me' })
  assert.throws(() => validateConfig(), /placeholder/)
})

test('validateConfig passes in production when fully configured', () => {
  setEnv({
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://x',
    JWT_SECRET: 'a-strong-production-secret-value',
    EMAIL_ENCRYPTION_KEY: 'a-valid-encryption-key-for-testing',
    REDIS_URL: 'redis://localhost:6379',
    ALLOWED_ORIGINS: 'https://app.acme.com',
  })
  assert.doesNotThrow(() => validateConfig())
})

const PROD_OK = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://x',
  JWT_SECRET: 'a-strong-production-secret-value',
  EMAIL_ENCRYPTION_KEY: 'a-valid-encryption-key-for-testing',
  REDIS_URL: 'redis://localhost:6379',
  ALLOWED_ORIGINS: 'https://app.acme.com',
}

test('validateConfig refuses to boot in production when rate limiting is disabled', () => {
  setEnv({ ...PROD_OK, RATE_LIMIT_DISABLED: 'true' })
  assert.throws(() => validateConfig(), /RATE_LIMIT_DISABLED must not be "true" in production/)
})

test('RATE_LIMIT_DISABLED is allowed outside production', () => {
  setEnv({ NODE_ENV: 'development', JWT_SECRET: 'a-strong-production-secret-value', RATE_LIMIT_DISABLED: 'true' })
  assert.doesNotThrow(() => validateConfig())
})

// --- security headers ---

function runHeaders(production: boolean) {
  setEnv({ NODE_ENV: production ? 'production' : 'development' })
  const headers: Record<string, string> = {}
  const res = { setHeader: (k: string, v: string) => { headers[k] = v } } as unknown as Response
  let nextCalled = false
  securityHeaders({} as Request, res, () => { nextCalled = true })
  return { headers, nextCalled }
}

test('securityHeaders sets the standard hardening headers and calls next', () => {
  const { headers, nextCalled } = runHeaders(false)
  assert.equal(nextCalled, true)
  assert.equal(headers['X-Content-Type-Options'], 'nosniff')
  assert.equal(headers['X-Frame-Options'], 'DENY')
  assert.equal(headers['Referrer-Policy'], 'no-referrer')
  assert.match(headers['Content-Security-Policy'], /default-src 'none'/)
})

test('securityHeaders sends HSTS only in production', () => {
  assert.equal(runHeaders(false).headers['Strict-Transport-Security'], undefined)
  assert.match(runHeaders(true).headers['Strict-Transport-Security'], /max-age=/)
})
