import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { prisma } from '../lib/prisma.js'
import {
  signJwt,
  verifyJwt,
  generateRefreshToken,
  hashRefreshToken,
  refreshTokenExpiresAt
} from '../lib/jwt.js'
import { requireAuth } from '../middleware/auth.js'
import { authRateLimit } from '../middleware/rateLimit.js'
import { asyncHandler, ApiError } from '../lib/http.js'
import { buildWorkspaceName, isValidEmail, normalizeEmail, validatePassword } from '../lib/validation.js'
import { resolveUniqueWorkspaceSlug } from '../lib/workspaces.js'
import { logSecurityEvent } from '../lib/securityLog.js'
import type { AuthedRequest } from '../types/auth.js'

export const authRouter = Router()

function issueTokens(userId: string) {
  const token = signJwt({ userId })
  const refreshToken = generateRefreshToken()
  return { token, refreshToken }
}

async function persistRefreshToken(userId: string, refreshToken: string) {
  await prisma.refreshToken.create({
    data: {
      userId,
      tokenHash: hashRefreshToken(refreshToken),
      expiresAt: refreshTokenExpiresAt()
    }
  })
}

authRouter.post(
  '/signup',
  authRateLimit,
  asyncHandler(async (req, res) => {
    const rawEmail = String(req.body?.email || '')
    const password = String(req.body?.password || '')
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : undefined

    if (!rawEmail || !password) throw new ApiError(400, 'Email and password are required')

    const email = normalizeEmail(rawEmail)
    if (!isValidEmail(email)) throw new ApiError(400, 'Valid email is required')

    const passwordError = validatePassword(password)
    if (passwordError) throw new ApiError(400, passwordError)

    const existing = await prisma.user.findUnique({ where: { email } })
    if (existing) throw new ApiError(409, 'Email already registered')

    const slug = await resolveUniqueWorkspaceSlug(name, email)
    const workspaceName = buildWorkspaceName(name, email)
    const passwordHash = await bcrypt.hash(password, 10)

    const result = await prisma.$transaction(async (tx: any) => {
      const user = await tx.user.create({
        data: { email, name, passwordHash },
        select: { id: true, email: true, name: true }
      })
      const workspace = await tx.workspace.create({
        data: { name: workspaceName, slug },
        select: { id: true, name: true, slug: true, plan: true }
      })
      await tx.membership.create({
        data: { userId: user.id, workspaceId: workspace.id, role: 'owner' }
      })
      return { user, workspace }
    })

    const { token, refreshToken } = issueTokens(result.user.id)
    await persistRefreshToken(result.user.id, refreshToken)

    logSecurityEvent({ eventType: 'AUTH_SIGNUP', userId: result.user.id, workspaceId: result.workspace.id, req })
    res.status(201).json({ token, refreshToken, user: result.user, workspace: result.workspace })
  })
)

authRouter.post(
  '/login',
  authRateLimit,
  asyncHandler(async (req, res) => {
    const email = normalizeEmail(String(req.body?.email || ''))
    const password = String(req.body?.password || '')

    if (!email || !password) throw new ApiError(400, 'Email and password are required')

    const user = await prisma.user.findUnique({ where: { email } })
    if (!user?.passwordHash) {
      logSecurityEvent({ eventType: 'AUTH_LOGIN_FAILURE', severity: 'WARN', meta: { email }, req })
      throw new ApiError(401, 'Invalid credentials')
    }

    const ok = await bcrypt.compare(password, user.passwordHash)
    if (!ok) {
      logSecurityEvent({ eventType: 'AUTH_LOGIN_FAILURE', severity: 'WARN', userId: user.id, meta: { email }, req })
      throw new ApiError(401, 'Invalid credentials')
    }

    const { token, refreshToken } = issueTokens(user.id)
    await persistRefreshToken(user.id, refreshToken)

    logSecurityEvent({ eventType: 'AUTH_LOGIN_SUCCESS', userId: user.id, req })
    res.json({
      token,
      refreshToken,
      user: { id: user.id, email: user.email, name: user.name }
    })
  })
)

authRouter.post(
  '/refresh',
  authRateLimit,
  asyncHandler(async (req, res) => {
    const rawToken = String(req.body?.refreshToken || '').trim()
    if (!rawToken) throw new ApiError(400, 'refreshToken required')

    const tokenHash = hashRefreshToken(rawToken)
    const stored = await prisma.refreshToken.findUnique({ where: { tokenHash } })

    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
      logSecurityEvent({ eventType: 'AUTH_TOKEN_INVALID', severity: 'WARN', req })
      throw new ApiError(401, 'Refresh token invalid or expired')
    }

    // Rotate: revoke old, issue new
    await prisma.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } })

    const { token, refreshToken: newRefreshToken } = issueTokens(stored.userId)
    await persistRefreshToken(stored.userId, newRefreshToken)

    const user = await prisma.user.findUnique({
      where: { id: stored.userId },
      select: { id: true, email: true, name: true }
    })

    logSecurityEvent({ eventType: 'AUTH_TOKEN_REFRESH', userId: stored.userId, req })
    res.json({ token, refreshToken: newRefreshToken, user })
  })
)

authRouter.post(
  '/logout',
  asyncHandler(async (req, res) => {
    const rawToken = String(req.body?.refreshToken || '').trim()
    if (rawToken) {
      const tokenHash = hashRefreshToken(rawToken)
      const stored = await prisma.refreshToken.findUnique({ where: { tokenHash }, select: { userId: true } })
      await prisma.refreshToken.updateMany({
        where: { tokenHash, revokedAt: null },
        data: { revokedAt: new Date() }
      })
      if (stored) logSecurityEvent({ eventType: 'AUTH_LOGOUT', userId: stored.userId, req })
    }
    res.json({ ok: true })
  })
)

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const workspaces = await prisma.workspace.findMany({
      where: { memberships: { some: { userId: user.id } } },
      select: {
        id: true, name: true, slug: true, plan: true,
        subscriptionStatus: true, createdAt: true
      },
      orderBy: { createdAt: 'asc' }
    })
    res.json({ user, workspaces })
  })
)

authRouter.patch(
  '/profile',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const updates: { name?: string | null; passwordHash?: string } = {}

    if (typeof req.body?.name === 'string') {
      updates.name = req.body.name.trim() || null
    }

    if (typeof req.body?.currentPassword === 'string' && typeof req.body?.newPassword === 'string') {
      const dbUser = await prisma.user.findUnique({ where: { id: user.id } })
      if (!dbUser?.passwordHash) throw new ApiError(400, 'Cannot change password for this account')
      const ok = await bcrypt.compare(req.body.currentPassword, dbUser.passwordHash)
      if (!ok) throw new ApiError(401, 'Current password is incorrect')
      const err = validatePassword(req.body.newPassword)
      if (err) throw new ApiError(400, err)
      updates.passwordHash = await bcrypt.hash(req.body.newPassword, 10)
    }

    if (Object.keys(updates).length === 0) throw new ApiError(400, 'No updates provided')

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: updates,
      select: { id: true, email: true, name: true }
    })

    res.json({ user: updated })
  })
)
