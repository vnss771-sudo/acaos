import jwt, { type SignOptions } from 'jsonwebtoken'
import crypto from 'crypto'
import { cfg } from './env.js'

const defaultSecret = 'change-me'

export type JwtPayload = { userId: string }

function isProduction() {
  return cfg.nodeEnv === 'production'
}

export function getJwtSecret() {
  const secret = cfg.jwtSecret?.trim()

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
  return jwt.sign(payload, getJwtSecret(), { expiresIn: cfg.jwtExpiresIn as SignOptions['expiresIn'] })
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
  const d = new Date()
  d.setDate(d.getDate() + cfg.refreshTokenDays)
  return d
}
