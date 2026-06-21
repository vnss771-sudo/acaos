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

// Read-only HTTP methods an unverified user may still use to look around. Every
// state-changing method must clear email verification first.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

// Gate every mutating request (POST/PUT/PATCH/DELETE) behind a verified email
// while leaving reads open, so an unverified account can authenticate and browse
// but cannot write, spend, send, or change billing. Apply at the router level
// AFTER requireAuth (it reads req.user). Reads fall straight through; mutations
// route through requireVerifiedEmail and 403 until the email is confirmed.
export function requireVerifiedForMutation(req: Request, res: Response, next: NextFunction) {
  if (SAFE_METHODS.has(req.method)) return next()
  return requireVerifiedEmail(req, res, next)
}

// Same as requireVerifiedForMutation but exempts a small allowlist of paths so a
// brand-new, not-yet-verified user can still finish the setup wizard before
// confirming their email (decided policy: onboarding self-config is low-risk and
// must stay open). Patterns match the router-relative `req.path` (Express strips
// the mount prefix inside a sub-router, e.g. `/:id/icp` arrives as `/<id>/icp`).
// Every other mutation still routes through requireVerifiedEmail.
export function requireVerifiedForMutationExcept(...exempt: RegExp[]) {
  return function (req: Request, res: Response, next: NextFunction) {
    if (SAFE_METHODS.has(req.method)) return next()
    if (exempt.some((re) => re.test(req.path))) return next()
    return requireVerifiedEmail(req, res, next)
  }
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
