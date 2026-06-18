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
import { setRefreshCookie, clearRefreshCookie, readCookie, requireCsrfHeader, REFRESH_COOKIE } from '../lib/cookies.js'
import { asyncHandler, ApiError } from '../lib/http.js'
import { buildWorkspaceName, normalizeEmail, validatePassword } from '../lib/validation.js'
import { resolveUniqueWorkspaceSlug, normalizeWorkspaceRole } from '../lib/workspaces.js'
import { isMailConfigured, sendMail } from '../services/mail.js'
import { validate, emailField, passwordField } from '../lib/validate.js'
import { z } from 'zod'
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

const signupSchema = z.object({
  email: emailField,
  password: passwordField,
  name: z.string().trim().max(100).optional(),
})

authRouter.post(
  '/signup',
  authRateLimit,
  validate(signupSchema),
  asyncHandler(async (req, res) => {
    const { password, name } = req.body as z.infer<typeof signupSchema>
    const email = normalizeEmail(req.body.email)

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

    // Send verification email (non-blocking — don't fail signup if SMTP is down)
    sendVerificationEmail(result.user.id, result.user.email).catch(() => {})

    // Refresh token goes in an HttpOnly cookie, never the response body, so it
    // cannot be read by JavaScript. The access token stays in the body (memory).
    setRefreshCookie(res, refreshToken)
    res.status(201).json({ token, user: result.user, workspace: result.workspace })
  })
)

const loginSchema = z.object({
  email: emailField,
  password: z.string().min(1, 'Password required').max(128),
})

authRouter.post(
  '/login',
  authRateLimit,
  validate(loginSchema),
  asyncHandler(async (req, res) => {
    const email = normalizeEmail(req.body.email)
    const { password } = req.body as z.infer<typeof loginSchema>

    const user = await prisma.user.findUnique({ where: { email } })
    if (!user?.passwordHash) throw new ApiError(401, 'Invalid credentials')

    const ok = await bcrypt.compare(password, user.passwordHash)
    if (!ok) throw new ApiError(401, 'Invalid credentials')

    const { token, refreshToken } = issueTokens(user.id)
    await persistRefreshToken(user.id, refreshToken)

    setRefreshCookie(res, refreshToken)
    res.json({
      token,
      user: { id: user.id, email: user.email, name: user.name }
    })
  })
)

authRouter.post(
  '/refresh',
  authRateLimit,
  requireCsrfHeader,
  asyncHandler(async (req, res) => {
    // The refresh token is read from the HttpOnly cookie, never the body.
    const rawToken = (readCookie(req, REFRESH_COOKIE) || '').trim()
    if (!rawToken) throw new ApiError(401, 'Refresh token invalid or expired')

    const tokenHash = hashRefreshToken(rawToken)

    // Atomic conditional update — only one concurrent request can win (count === 1)
    const now = new Date()
    const result = await prisma.refreshToken.updateMany({
      where: { tokenHash, revokedAt: null, expiresAt: { gt: now } },
      data: { revokedAt: now },
    })
    if (result.count === 0) {
      throw new ApiError(401, 'Refresh token invalid or expired')
    }
    // Fetch token record to obtain userId (already atomically revoked above)
    const stored = await prisma.refreshToken.findUnique({ where: { tokenHash } })
    if (!stored) throw new ApiError(401, 'Refresh token invalid or expired')

    // Rotate: issue new token
    const { token, refreshToken: newRefreshToken } = issueTokens(stored.userId)
    await persistRefreshToken(stored.userId, newRefreshToken)

    const user = await prisma.user.findUnique({
      where: { id: stored.userId },
      select: { id: true, email: true, name: true }
    })

    // Rotate the cookie to the new refresh token; only the access token is
    // returned in the body.
    setRefreshCookie(res, newRefreshToken)
    res.json({ token, user })
  })
)

authRouter.post(
  '/logout',
  requireCsrfHeader,
  asyncHandler(async (req, res) => {
    const rawToken = (readCookie(req, REFRESH_COOKIE) || '').trim()
    if (rawToken) {
      const tokenHash = hashRefreshToken(rawToken)
      await prisma.refreshToken.updateMany({
        where: { tokenHash, revokedAt: null },
        data: { revokedAt: new Date() }
      })
    }
    clearRefreshCookie(res)
    res.json({ ok: true })
  })
)

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const authedUser = (req as AuthedRequest).user
    const [dbUser, workspaces] = await Promise.all([
      prisma.user.findUnique({
        where: { id: authedUser.id },
        select: { id: true, email: true, name: true, emailVerified: true }
      }),
      prisma.workspace.findMany({
        where: { memberships: { some: { userId: authedUser.id } } },
        select: {
          id: true, name: true, slug: true, plan: true,
          subscriptionStatus: true, createdAt: true, onboardingCompleted: true,
          _count: { select: { leads: true, campaigns: true } },
          // The caller's own membership row — surfaces their role so the client
          // can make role-aware UI decisions without a second request.
          memberships: { where: { userId: authedUser.id }, select: { role: true }, take: 1 },
        },
        orderBy: { createdAt: 'asc' }
      })
    ])
    const withRole = workspaces.map((w) => {
      const { memberships, ...rest } = w as typeof w & { memberships?: Array<{ role: string }> }
      return { ...rest, role: normalizeWorkspaceRole(memberships?.[0]?.role) }
    })
    res.json({ user: dbUser ?? authedUser, workspaces: withRole })
  })
)

const forgotPasswordSchema = z.object({ email: emailField })

authRouter.post(
  '/forgot-password',
  authRateLimit,
  validate(forgotPasswordSchema),
  asyncHandler(async (req, res) => {
    const email = normalizeEmail(req.body.email)

    const user = await prisma.user.findUnique({ where: { email } })
    // Always 200 — prevents email enumeration
    if (!user?.passwordHash) return res.json({ ok: true })

    const rawToken = generateRefreshToken()
    const tokenHash = hashRefreshToken(rawToken)
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000) // 1 hour

    await prisma.passwordResetToken.create({ data: { userId: user.id, tokenHash, expiresAt } })

    const appUrl = (process.env.APP_URL || 'http://localhost:5173').replace(/\/$/, '')
    const resetUrl = `${appUrl}?reset=${rawToken}`

    if (isMailConfigured()) {
      await sendMail(email, 'Reset your ACAOS password',
        `<p>Click the link below to reset your password. This link expires in 1 hour.</p>` +
        `<p><a href="${resetUrl}">${resetUrl}</a></p>` +
        `<p>If you didn't request this, you can safely ignore this email.</p>`
      )
    } else if (process.env.NODE_ENV === 'production') {
      // Never log a URL containing the raw reset token in production.
      console.warn('[auth] SMTP not configured; password reset email was not sent')
    } else {
      console.log(`[auth] Reset URL (SMTP not configured): ${resetUrl}`)
    }

    res.json({ ok: true })
  })
)

const resetPasswordSchema = z.object({
  token: z.string().min(1, 'Token required'),
  password: passwordField,
})

authRouter.post(
  '/reset-password',
  authRateLimit,
  validate(resetPasswordSchema),
  asyncHandler(async (req, res) => {
    const { token: rawToken, password: newPassword } = req.body as z.infer<typeof resetPasswordSchema>

    const passwordError = validatePassword(newPassword)
    if (passwordError) throw new ApiError(400, passwordError)

    const tokenHash = hashRefreshToken(rawToken)

    // Atomic conditional update — only one concurrent request can win (count === 1)
    const now = new Date()
    const updateResult = await prisma.passwordResetToken.updateMany({
      where: { tokenHash, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    })
    if (updateResult.count === 0) {
      throw new ApiError(400, 'Reset link is invalid or has expired')
    }
    const record = await prisma.passwordResetToken.findUnique({ where: { tokenHash } })
    if (!record) throw new ApiError(400, 'Reset link is invalid or has expired')

    const passwordHash = await bcrypt.hash(newPassword, 10)

    await prisma.$transaction([
      prisma.user.update({ where: { id: record.userId }, data: { passwordHash } }),
      // Invalidate all active sessions for security
      prisma.refreshToken.updateMany({
        where: { userId: record.userId, revokedAt: null },
        data: { revokedAt: new Date() }
      }),
    ])

    res.json({ ok: true })
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

// ── Email verification ────────────────────────────────────────────────────────

async function sendVerificationEmail(userId: string, email: string) {
  const rawToken = generateRefreshToken()
  const tokenHash = hashRefreshToken(rawToken)
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000) // 24 hours

  await prisma.emailVerificationToken.create({ data: { userId, tokenHash, expiresAt } })

  const appUrl = (process.env.APP_URL || 'http://localhost:5173').replace(/\/$/, '')
  const verifyUrl = `${appUrl}?verify=${rawToken}`

  if (isMailConfigured()) {
    await sendMail(email, 'Verify your ACAOS email address',
      `<p>Please verify your email address by clicking the link below. This link expires in 24 hours.</p>` +
      `<p><a href="${verifyUrl}">Verify email address</a></p>` +
      `<p>If you didn't sign up for ACAOS, you can ignore this email.</p>`
    )
  } else if (process.env.NODE_ENV === 'production') {
    // Never log a URL containing the raw verification token in production.
    console.warn('[auth] SMTP not configured; verification email was not sent')
  } else {
    console.log(`[auth] Verification URL (SMTP not configured): ${verifyUrl}`)
  }
}

authRouter.get(
  '/verify-email/:token',
  asyncHandler(async (req, res) => {
    const rawToken = String(req.params.token || '').trim()
    const tokenHash = hashRefreshToken(rawToken)

    // Atomic conditional update — only one concurrent request can win (count === 1)
    const now = new Date()
    const updateResult = await prisma.emailVerificationToken.updateMany({
      where: { tokenHash, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    })
    if (updateResult.count === 0) {
      throw new ApiError(400, 'Verification link is invalid or has expired')
    }
    const record = await prisma.emailVerificationToken.findUnique({ where: { tokenHash } })
    if (!record) throw new ApiError(400, 'Verification link is invalid or has expired')

    await prisma.$transaction([
      prisma.user.update({ where: { id: record.userId }, data: { emailVerified: true } }),
    ])

    res.json({ ok: true })
  })
)

authRouter.post(
  '/resend-verification',
  authRateLimit,
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const dbUser = await prisma.user.findUnique({ where: { id: user.id }, select: { emailVerified: true, email: true } })
    if (dbUser?.emailVerified) return res.json({ ok: true }) // already verified

    await sendVerificationEmail(user.id, user.email)
    res.json({ ok: true })
  })
)

// ── Invite verification (public) ──────────────────────────────────────────────

authRouter.get(
  '/invite/:token',
  asyncHandler(async (req, res) => {
    const rawToken = String(req.params.token || '').trim()
    const tokenHash = hashRefreshToken(rawToken)
    const invite = await prisma.workspaceInvite.findUnique({
      where: { tokenHash },
      include: { workspace: { select: { id: true, name: true } } }
    })
    if (!invite || invite.acceptedAt || invite.expiresAt < new Date()) {
      throw new ApiError(400, 'Invite link is invalid or has expired')
    }
    res.json({ invite: { email: invite.email, role: invite.role, workspaceName: invite.workspace.name, workspaceId: invite.workspaceId } })
  })
)

authRouter.post(
  '/invite/:token/accept',
  requireAuth,
  asyncHandler(async (req, res) => {
    const authedUser = (req as AuthedRequest).user
    const rawToken = String(req.params.token || '').trim()
    const tokenHash = hashRefreshToken(rawToken)

    const invite = await prisma.workspaceInvite.findUnique({ where: { tokenHash } })
    if (!invite || invite.acceptedAt || invite.expiresAt < new Date()) {
      throw new ApiError(400, 'Invite link is invalid or has expired')
    }

    // Email must match the invited address
    if (normalizeEmail(authedUser.email) !== normalizeEmail(invite.email)) {
      throw new ApiError(403, `This invite was sent to ${invite.email} — please sign in with that account`)
    }

    const alreadyMember = await prisma.membership.findFirst({
      where: { userId: authedUser.id, workspaceId: invite.workspaceId }
    })

    await prisma.$transaction([
      ...(alreadyMember ? [] : [
        prisma.membership.create({
          data: { userId: authedUser.id, workspaceId: invite.workspaceId, role: invite.role }
        })
      ]),
      prisma.workspaceInvite.update({ where: { id: invite.id }, data: { acceptedAt: new Date() } }),
    ])

    res.json({ workspaceId: invite.workspaceId, role: invite.role })
  })
)
