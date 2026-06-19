import jwt, { type SignOptions } from 'jsonwebtoken'
import crypto from 'crypto'

const PLACEHOLDER_SECRET = 'change-me'
const MIN_SECRET_LENGTH = 16

export type JwtPayload = { userId: string }

function isProduction() {
  return process.env.NODE_ENV === 'production'
}

// A strong, per-process random secret used only when JWT_SECRET is unset
// outside production. This replaces the old hardcoded 'change-me' fallback so a
// misconfigured non-prod deploy can never sign tokens with a publicly known
// secret. Stored on globalThis so every module instance shares one value —
// important under runtimes (e.g. tsx) that can load this module more than once
// via dynamic import. Tokens do not survive a restart.
function getEphemeralDevSecret(): string {
  const g = globalThis as { __acaosJwtDevSecret__?: string }
  if (!g.__acaosJwtDevSecret__) {
    g.__acaosJwtDevSecret__ = crypto.randomBytes(32).toString('hex')
    console.warn('[jwt] JWT_SECRET is not set — using a random ephemeral dev secret. Set JWT_SECRET for stable tokens.')
  }
  return g.__acaosJwtDevSecret__
}

export function getJwtSecret() {
  const secret = process.env.JWT_SECRET?.trim()

  if (secret) {
    if (secret === PLACEHOLDER_SECRET) {
      throw new Error('JWT_SECRET must not be the default placeholder value')
    }
    if (secret.length < MIN_SECRET_LENGTH) {
      throw new Error(`JWT_SECRET must be at least ${MIN_SECRET_LENGTH} characters`)
    }
    return secret
  }

  if (isProduction()) {
    throw new Error('JWT_SECRET is required in production')
  }

  return getEphemeralDevSecret()
}

export function signJwt(payload: JwtPayload): string {
  const expiresIn = (process.env.JWT_EXPIRES_IN || '15m') as SignOptions['expiresIn']
  return jwt.sign(payload, getJwtSecret(), { expiresIn })
}

export function verifyJwt(token: string): JwtPayload {
  const decoded = jwt.verify(token, getJwtSecret()) as JwtPayload & { typ?: string }
  // A scoped token (e.g. the MFA-pending token below) must NEVER authenticate a
  // request. Access tokens carry no `typ`; reject anything that does.
  if (decoded.typ) throw new Error('Not an access token')
  return { userId: decoded.userId }
}

// ── Scoped MFA-pending token ────────────────────────────────────────────────────
// Issued after a correct password when the account has TOTP enabled, in place of
// an access token. It only authorizes the /verify-totp step (short-lived, carries
// `typ: 'mfa'`), and verifyJwt above rejects it as a Bearer — so possessing it
// grants no API access until the second factor is provided.
export function signMfaToken(userId: string): string {
  return jwt.sign({ userId, typ: 'mfa' }, getJwtSecret(), { expiresIn: '5m' })
}

export function verifyMfaToken(token: string): JwtPayload {
  const decoded = jwt.verify(token, getJwtSecret()) as JwtPayload & { typ?: string }
  if (decoded.typ !== 'mfa') throw new Error('Not an MFA token')
  return { userId: decoded.userId }
}

export function generateRefreshToken(): string {
  return crypto.randomBytes(40).toString('hex')
}

export function hashRefreshToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

export function refreshTokenExpiresAt(): Date {
  const days = Number(process.env.REFRESH_TOKEN_DAYS || 30)
  const d = new Date()
  d.setDate(d.getDate() + days)
  return d
}
