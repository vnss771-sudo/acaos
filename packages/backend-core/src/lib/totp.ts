// RFC 6238 TOTP (time-based one-time passwords) for MFA — dependency-free,
// built on node:crypto. Authenticator apps (Google Authenticator, 1Password,
// Authy, …) implement the same standard, so a secret provisioned via the
// otpauth:// URI below produces codes this module verifies.
//
// Defaults match the universal authenticator profile: HMAC-SHA1, 6 digits, 30s
// period. Verification allows a ±1 step skew so a code entered near a boundary
// (or with minor clock drift) still passes.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const DIGITS = 6
const PERIOD_SECONDS = 30
const ALGORITHM = 'sha1'

// ── RFC 4648 base32 (no padding) — the encoding authenticator apps expect ──────
const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(buf: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/g, '').replace(/\s+/g, '').toUpperCase()
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch)
    if (idx === -1) throw new Error('Invalid base32 character')
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

/** A fresh random base32 secret (160 bits, the RFC-recommended SHA-1 size). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20))
}

/** RFC 4226 HOTP for a specific counter — the building block of TOTP. */
function hotp(secret: string, counter: number): string {
  const key = base32Decode(secret)
  const buf = Buffer.alloc(8)
  // 64-bit big-endian counter (high word first; JS bitops are 32-bit).
  buf.writeUInt32BE(Math.floor(counter / 0x1_0000_0000), 0)
  buf.writeUInt32BE(counter >>> 0, 4)
  const digest = createHmac(ALGORITHM, key).update(buf).digest()
  const offset = digest[digest.length - 1] & 0x0f
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff)
  return (binary % 10 ** DIGITS).toString().padStart(DIGITS, '0')
}

/** The current TOTP code for a secret (mainly for tests/tools). */
export function generateTotp(secret: string, atMs: number = Date.now()): string {
  return hotp(secret, Math.floor(atMs / 1000 / PERIOD_SECONDS))
}

/**
 * Verify a user-supplied code against the secret, tolerating ±`window` steps of
 * clock skew. Constant-time comparison per candidate so a near-miss can't be
 * distinguished by timing. Non-numeric / wrong-length input is rejected up front.
 */
export function verifyTotp(secret: string, code: string, atMs: number = Date.now(), window = 1): boolean {
  const cleaned = (code || '').replace(/\s+/g, '')
  if (!new RegExp(`^\\d{${DIGITS}}$`).test(cleaned)) return false
  const counter = Math.floor(atMs / 1000 / PERIOD_SECONDS)
  const expected = Buffer.from(cleaned)
  for (let i = -window; i <= window; i++) {
    const candidate = Buffer.from(hotp(secret, counter + i))
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) return true
  }
  return false
}

/**
 * Build the otpauth:// provisioning URI the user scans/pastes into their
 * authenticator app. `account` is the user's email; `issuer` labels the entry.
 */
export function buildOtpauthUri(secret: string, account: string, issuer = 'ACAOS'): string {
  // Label is `issuer:account` with a LITERAL separating colon (per the otpauth
  // spec); only the two components are percent-encoded.
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(PERIOD_SECONDS),
  })
  return `otpauth://totp/${label}?${params.toString()}`
}
