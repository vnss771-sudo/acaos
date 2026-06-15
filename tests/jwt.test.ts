// Unit tests for the JWT / refresh-token primitives. These are pure crypto/auth
// helpers and warrant direct coverage (they're otherwise only exercised through
// DB-backed route tests, which the fast coverage gate doesn't run).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  signJwt, verifyJwt, generateRefreshToken, hashRefreshToken, refreshTokenExpiresAt, getJwtSecret,
} from '../apps/api/src/lib/jwt.ts'

test('signJwt / verifyJwt round-trips the payload', () => {
  const token = signJwt({ userId: 'user-123' })
  assert.equal(verifyJwt(token).userId, 'user-123')
})

test('verifyJwt rejects a malformed token', () => {
  assert.throws(() => verifyJwt('not.a.valid.jwt'))
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
