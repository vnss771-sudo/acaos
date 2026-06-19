// Unit tests for scoped JWTs: the MFA-pending token must authorize ONLY the
// /verify-totp step and must never function as an access token (Bearer), and
// vice-versa. This separation is what makes the password→MFA handoff safe.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { signJwt, verifyJwt, signMfaToken, verifyMfaToken } from '../packages/backend-core/src/lib/jwt.ts'

test('an access token verifies as an access token', () => {
  assert.equal(verifyJwt(signJwt({ userId: 'u1' })).userId, 'u1')
})

test('verifyJwt REJECTS an MFA-scoped token (cannot be used as a Bearer)', () => {
  const mfa = signMfaToken('u1')
  assert.throws(() => verifyJwt(mfa), /Not an access token/)
})

test('verifyMfaToken accepts the MFA token and rejects an access token', () => {
  assert.equal(verifyMfaToken(signMfaToken('u1')).userId, 'u1')
  assert.throws(() => verifyMfaToken(signJwt({ userId: 'u1' })), /Not an MFA token/)
})

test('a garbage token is rejected by both verifiers', () => {
  assert.throws(() => verifyJwt('not-a-jwt'))
  assert.throws(() => verifyMfaToken('not-a-jwt'))
})
