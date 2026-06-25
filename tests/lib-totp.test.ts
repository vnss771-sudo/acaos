// Unit tests for the TOTP MFA primitive. Correctness is pinned to the official
// RFC 6238 Appendix B test vectors (SHA-1 profile) so the implementation is
// verifiably interoperable with standard authenticator apps.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  base32Encode,
  base32Decode,
  generateTotpSecret,
  generateTotp,
  verifyTotp,
  verifyTotpStep,
  buildOtpauthUri,
} from '../packages/backend-core/src/lib/totp.ts'

// RFC 6238 seed: ASCII "12345678901234567890" (20 bytes), base32-encoded.
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'))

test('base32 round-trips arbitrary bytes', () => {
  for (const s of ['', 'a', 'hello world', '12345678901234567890']) {
    assert.equal(base32Decode(base32Encode(Buffer.from(s))).toString(), s)
  }
})

test('RFC 6238 test vectors (SHA-1, 6 digits)', () => {
  // [unix seconds, expected 6-digit code] — the trailing 6 of the RFC's 8-digit
  // values (94287082 → 287082, etc.).
  const vectors: Array<[number, string]> = [
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
    [20000000000, '353130'],
  ]
  for (const [secs, expected] of vectors) {
    assert.equal(generateTotp(RFC_SECRET, secs * 1000), expected, `T=${secs}`)
  }
})

test('verifyTotp accepts the current code and rejects a wrong one', () => {
  const now = 1111111111 * 1000
  assert.equal(verifyTotp(RFC_SECRET, '050471', now), true)
  assert.equal(verifyTotp(RFC_SECRET, '000000', now), false)
})

test('verifyTotpStep returns the matched step (for single-use enforcement)', () => {
  const now = 1111111111 * 1000
  const step = Math.floor(1111111111 / 30)
  assert.equal(verifyTotpStep(RFC_SECRET, '050471', now), step)        // current step
  assert.equal(verifyTotpStep(RFC_SECRET, '000000', now), null)        // wrong code
  // The ±1-skew matches report the neighbouring step, so a caller can tell that a
  // replay of the previous code maps to a strictly-lower step and reject it.
  const prev = generateTotp(RFC_SECRET, now - 30_000)
  assert.equal(verifyTotpStep(RFC_SECRET, prev, now), step - 1)
})

test('verifyTotp tolerates ±1 step of clock skew but not more', () => {
  const t = 1111111111 * 1000
  const prev = generateTotp(RFC_SECRET, t - 30_000)
  const next = generateTotp(RFC_SECRET, t + 30_000)
  const farPast = generateTotp(RFC_SECRET, t - 90_000)
  assert.equal(verifyTotp(RFC_SECRET, prev, t), true, 'one step back ok')
  assert.equal(verifyTotp(RFC_SECRET, next, t), true, 'one step forward ok')
  assert.equal(verifyTotp(RFC_SECRET, farPast, t), false, 'three steps back rejected')
})

test('verifyTotp rejects malformed input', () => {
  const now = Date.now()
  for (const bad of ['', '12345', '1234567', 'abcdef', '12 34 56']) {
    assert.equal(verifyTotp(RFC_SECRET, bad, now), false, `"${bad}"`)
  }
})

test('a generated secret produces a code that verifies', () => {
  const secret = generateTotpSecret()
  const now = Date.now()
  assert.equal(verifyTotp(secret, generateTotp(secret, now), now), true)
})

test('buildOtpauthUri encodes the standard fields', () => {
  const uri = buildOtpauthUri('JBSWY3DPEHPK3PXP', 'user@x.test', 'ACAOS')
  assert.match(uri, /^otpauth:\/\/totp\/ACAOS:user%40x\.test\?/)
  assert.match(uri, /secret=JBSWY3DPEHPK3PXP/)
  assert.match(uri, /issuer=ACAOS/)
  assert.match(uri, /digits=6/)
  assert.match(uri, /period=30/)
})
