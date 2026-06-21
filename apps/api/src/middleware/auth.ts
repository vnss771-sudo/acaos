import type { Request, Response, NextFunction } from 'express'
import { verifyJwt } from '../lib/jwt.js'
import { prisma } from '../lib/prisma.js'

export function requireVerifiedEmail(req: Request, res: Response, next: NextFunction) {
  const user = req.user
  if (!user?.emailVerified) {
    return res.status(403).json({ error: 'Email verification required. Check your inbox for a verification link.' })
  }
  return next()
}

// True when the user has a password/MFA proof within the step-up window. Shared
// by the requireFreshAuth middleware and ad-hoc gates (e.g. admin promotion).
// Window configurable via STEP_UP_MAX_AGE_MIN (default 15 min).
export async function hasFreshAuth(userId: string): Promise<boolean> {
  const maxAgeMs = Number(process.env.STEP_UP_MAX_AGE_MIN || 15) * 60_000
  const row = await prisma.user.findUnique({ where: { id: userId }, select: { lastReauthAt: true } })
  const at = row?.lastReauthAt?.getTime()
  return Boolean(at && Date.now() - at <= maxAgeMs)
}

// Step-up auth: require a RECENT password/MFA proof for sensitive mutations
// (billing, admin, MFA disable). A 403 with `code: 'REAUTH_REQUIRED'` tells the
// client to prompt for re-auth and retry. Must run after requireAuth.
export function requireFreshAuth(req: Request, res: Response, next: NextFunction) {
  const user = req.user
  if (!user) return res.status(401).json({ error: 'Unauthorized' })

  hasFreshAuth(user.id)
    .then((fresh) => {
      if (!fresh) {
        return res.status(403).json({ error: 'Re-authentication required for this action', code: 'REAUTH_REQUIRED' })
      }
      return next()
    })
    .catch(next)
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const auth = req.headers.authorization
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing bearer token' })
  }

  const token = auth.slice('Bearer '.length)

  let payload
  try {
    payload = verifyJwt(token)
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: { id: true, email: true, name: true, emailVerified: true, isPlatformAdmin: true }
    })

    if (!user) {
      return res.status(401).json({ error: 'User not found' })
    }

    req.user = user
    return next()
  } catch (error) {
    return next(error)
  }
}
