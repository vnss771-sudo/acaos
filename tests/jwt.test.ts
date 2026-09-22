// Unit tests for the JWT / refresh-token primitives. These are pure crypto/auth
// helpers and warrant direct coverage (they're otherwise only exercised through
// DB-backed route tests, which the fast coverage gate doesn't run).

import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import jwt from 'jsonwebtoken'
import {
  signJwt, verifyJwt, generateRefreshToken, hashRefreshToken, refreshTokenExpiresAt, getJwtSecret,
  allowsInsecureJwtFallback,
} from '../packages/backend-core/src/lib/jwt.ts'

const SAVED_ENV = { ...process.env }
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in SAVED_ENV)) delete process.env[k]
  Object.assign(process.env, SAVED_ENV)
})
function setEnv(env: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

test('signJwt / verifyJwt round-trips the payload', () => {
  const token = signJwt({ userId: 'user-123' })
  assert.equal(verifyJwt(token).userId, 'user-123')
})

test('verifyJwt rejects a malformed token', () => {
  assert.throws(() => verifyJwt('not.a.valid.jwt'))
})

// Algorithm-confusion: verifyJwt pins `algorithms: ['HS256']`, so a token whose
// header claims a different algorithm must be rejected even if the payload and
// secret would otherwise be "valid" — jsonwebtoken enforces this once the
// caller passes an explicit allow-list, but silently trusts the header's `alg`
// when the caller doesn't (the exact gap S3 closes).
test('verifyJwt rejects a token signed with `alg: none`', () => {
  const none = jwt.sign({ userId: 'user-123' }, '', { algorithm: 'none' })
  assert.throws(() => verifyJwt(none))
})

test('verifyJwt rejects a token signed with a different algorithm (HS384)', () => {
  const secret = getJwtSecret()
  const wrongAlg = jwt.sign({ userId: 'user-123' }, secret, { algorithm: 'HS384' })
  assert.throws(() => verifyJwt(wrongAlg))
})

test('generateRefreshToken returns 80 hex chars and is unique per call', () => {
  const a = generateRefreshToken()
  const b = generateRefreshToken()
  assert.match(a, /^[a-f0-9]{80}$/)
  assert.notEqual(a, b)
})

test('hashRefreshToken is a deterministic sha256 hex digest', () => {
  assert.equal(hashRefreshToken('secret'), hashRefreshToken('secret'))
  assert.notEqual(hashRefreshToken('a'), hashRefreshToken('b'))
  assert.match(hashRefreshToken('secret'), /^[a-f0-9]{64}$/)
})

test('refreshTokenExpiresAt is in the future', () => {
  assert.ok(refreshTokenExpiresAt().getTime() > Date.now())
})

test('getJwtSecret returns a usable secret outside production', () => {
  assert.ok(getJwtSecret().length >= 16)
})

// allowsInsecureJwtFallback / getJwtSecret's NODE_ENV gating must match
// encrypt.ts's getLegacyKey() exactly: an explicit non-dev/test NODE_ENV
// (staging, "prod", a typo — not just literal "production") is a deployed
// environment that must never silently sign tokens with a per-process
// ephemeral secret. This was previously gated on a bare `NODE_ENV ===
// 'production'` check, which let "staging" (or anything else) through.
test('allowsInsecureJwtFallback: true only for unset/development/test NODE_ENV', () => {
  setEnv({ NODE_ENV: undefined })
  assert.equal(allowsInsecureJwtFallback(), true)
  setEnv({ NODE_ENV: 'development' })
  assert.equal(allowsInsecureJwtFallback(), true)
  setEnv({ NODE_ENV: 'test' })
  assert.equal(allowsInsecureJwtFallback(), true)

  setEnv({ NODE_ENV: 'production' })
  assert.equal(allowsInsecureJwtFallback(), false)
  setEnv({ NODE_ENV: 'staging' })
  assert.equal(allowsInsecureJwtFallback(), false)
  setEnv({ NODE_ENV: 'preview' })
  assert.equal(allowsInsecureJwtFallback(), false)
})

test('getJwtSecret throws for a deployed (staging) NODE_ENV with no JWT_SECRET set — the exact gap this closes', () => {
  setEnv({ NODE_ENV: 'staging', JWT_SECRET: undefined })
  assert.throws(() => getJwtSecret(), /JWT_SECRET is required when NODE_ENV="staging"/)
})

test('getJwtSecret still throws for literal production with no JWT_SECRET (unchanged behavior)', () => {
  setEnv({ NODE_ENV: 'production', JWT_SECRET: undefined })
  assert.throws(() => getJwtSecret(), /JWT_SECRET is required/)
})

test('getJwtSecret still falls back to an ephemeral secret for unset/development/test NODE_ENV', () => {
  setEnv({ NODE_ENV: undefined, JWT_SECRET: undefined })
  assert.ok(getJwtSecret().length >= 16)
  setEnv({ NODE_ENV: 'test', JWT_SECRET: undefined })
  assert.ok(getJwtSecret().length >= 16)
})

test('getJwtSecret respects an explicitly-set JWT_SECRET regardless of NODE_ENV', () => {
  setEnv({ NODE_ENV: 'staging', JWT_SECRET: 'a'.repeat(32) })
  assert.equal(getJwtSecret(), 'a'.repeat(32))
})
