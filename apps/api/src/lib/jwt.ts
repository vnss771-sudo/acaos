import jwt, { type SignOptions } from 'jsonwebtoken'
import crypto from 'crypto'

const defaultSecret = 'change-me'

export type JwtPayload = { userId: string }

function isProduction() {
  return process.env.NODE_ENV === 'production'
}

export function getJwtSecret() {
  const secret = process.env.JWT_SECRET?.trim()

  if (!secret) {
    if (isProduction()) throw new Error('JWT_SECRET is required in production')
    return defaultSecret
  }

  if (isProduction() && secret === defaultSecret) {
    throw new Error('JWT_SECRET must be changed in production')
  }

  return secret
}

export function signJwt(payload: JwtPayload): string {
  const expiresIn = (process.env.JWT_EXPIRES_IN || '15m') as SignOptions['expiresIn']
  return jwt.sign(payload, getJwtSecret(), { expiresIn })
}

export function verifyJwt(token: string): JwtPayload {
  return jwt.verify(token, getJwtSecret()) as JwtPayload
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
