import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { prisma } from '../lib/prisma.js'
import {
  signJwt,
  generateRefreshToken,
  hashRefreshToken,
  refreshTokenExpiresAt,
  signMfaToken,
  verifyMfaToken
} from '../lib/jwt.js'
import { requireAuth, requireFreshAuth, requireVerifiedEmail } from '../middleware/auth.js'
import { recordAudit } from '../lib/audit.js'
import { encryptSecret, decryptSecret } from '../lib/encrypt.js'
import { generateTotpSecret, verifyTotpStep, buildOtpauthUri } from '@acaos/backend-core/lib/totp.js'
import { isDisposableEmail, disposableBlockingEnabled } from '@acaos/backend-core/lib/disposableEmail.js'
import { authRateLimit } from '../middleware/rateLimit.js'
import { setRefreshCookie, clearRefreshCookie, readCookie, requireCsrfHeader, REFRESH_COOKIE } from '../lib/cookies.js'
import { asyncHandler, ApiError } from '../lib/http.js'
import { buildWorkspaceName, normalizeEmail, validatePassword } from '../lib/validation.js'
import { resolveUniqueWorkspaceSlug, normalizeWorkspaceRole } from '../lib/workspaces.js'
import { isMailConfigured, sendMail } from '../services/mail.js'
import { validate, emailField, passwordField } from '../lib/validate.js'
import { z } from 'zod'

export const authRouter = Router()

// bcrypt work factor. 12 is the current OWASP-recommended floor (cost ~250ms on
// modern hardware) — high enough to slow offline cracking, low enough not to
// add meaningful latency to login/signup. Existing hashes at older costs still
// verify correctly (the cost is encoded in the stored hash).
const BCRYPT_COST = 12

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

// Record a fresh password/MFA proof for step-up auth. Called whenever the user
// has just proven a credential (signup, login, MFA verify, explicit re-auth).
async function markReauth(userId: string) {
  await prisma.user.update({ where: { id: userId }, data: { lastReauthAt: new Date() } })
}

// Verify a TOTP code AND atomically consume its time-step so it cannot be replayed
// within its ±1-step (≈90s) validity window. Returns true only when the code matches
// and its step is strictly newer than the last step this user consumed — the
// conditional updateMany makes the check-and-consume race-safe across concurrent
// requests (NIST SP 800-63B §5.1.4.2 / RFC 6238 §5.2 single-use requirement).
async function consumeTotpCode(userId: string, secret: string, code: string): Promise<boolean> {
  const step = verifyTotpStep(secret, code)
  if (step === null) return false
  const res = await prisma.user.updateMany({
    where: { id: userId, OR: [{ totpLastUsedStep: null }, { totpLastUsedStep: { lt: step } }] },
    data: { totpLastUsedStep: step },
  })
  return res.count === 1
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

    // Reject known throwaway/disposable mailbox providers — the cheapest way to
    // mass-register abusive accounts. Checked before the existence lookup so a
    // disposable address is rejected outright. Enabled by default; operator-
    // disableable via BLOCK_DISPOSABLE_EMAILS=false.
    if (disposableBlockingEnabled() && isDisposableEmail(email)) {
      throw new ApiError(400, 'Please sign up with a permanent email address')
    }

    const existing = await prisma.user.findUnique({ where: { email } })
    if (existing) throw new ApiError(409, 'Email already registered')

    const slug = await resolveUniqueWorkspaceSlug(name, email)
    const workspaceName = buildWorkspaceName(name, email)
    const passwordHash = await bcrypt.hash(password, BCRYPT_COST)

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
    await markReauth(result.user.id)

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

    // Second factor: if TOTP is enabled, the password alone yields only a scoped,
    // short-lived MFA token (not an access token). The client must POST it back
    // to /verify-totp with a valid code to complete the login.
    if (user.totpEnabled) {
      return res.json({ mfaRequired: true, mfaToken: signMfaToken(user.id) })
    }

    const { token, refreshToken } = issueTokens(user.id)
    await persistRefreshToken(user.id, refreshToken)
    await markReauth(user.id)

    setRefreshCookie(res, refreshToken)
    res.json({
      token,
      user: { id: user.id, email: user.email, name: user.name }
    })
  })
)

// Complete an MFA login: verify the scoped mfaToken + a TOTP code, then issue the
// real session. Rate-limited like login (anti brute-force on the 6-digit code).
const verifyTotpSchema = z.object({
  mfaToken: z.string().min(1),
  code: z.string().min(6).max(10),
})

authRouter.post(
  '/verify-totp',
  authRateLimit,
  validate(verifyTotpSchema),
  asyncHandler(async (req, res) => {
    const { mfaToken, code } = req.body as z.infer<typeof verifyTotpSchema>

    let userId: string
    try {
      userId = verifyMfaToken(mfaToken).userId
    } catch {
      throw new ApiError(401, 'MFA session expired — please sign in again')
    }

    const user = await prisma.user.findUnique({ where: { id: userId } })
    if (!user?.totpEnabled || !user.totpSecret) throw new ApiError(401, 'MFA is not enabled')

    if (!(await consumeTotpCode(user.id, decryptSecret(user.totpSecret), code))) {
      throw new ApiError(401, 'Invalid authentication code')
    }

    const { token, refreshToken } = issueTokens(user.id)
    await persistRefreshToken(user.id, refreshToken)
    await markReauth(user.id)

    setRefreshCookie(res, refreshToken)
    res.json({ token, user: { id: user.id, email: user.email, name: user.name } })
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
      // Reuse detection: if the presented token EXISTS but is already revoked, it's
      // a replay of a rotated/revoked refresh token — a theft signal. Revoke the
      // user's entire refresh-token set (the long-lived credential) and audit it.
      // (Trade-off: a rare benign simultaneous-refresh race can also trip this and
      // force re-login; bounded by the shared-cookie + single-flight client model.)
      const replayed = await prisma.refreshToken.findUnique({
        where: { tokenHash },
        select: { userId: true, revokedAt: true },
      })
      if (replayed?.revokedAt) {
        await prisma.refreshToken.updateMany({
          where: { userId: replayed.userId, revokedAt: null },
          data: { revokedAt: new Date() },
        })
        void recordAudit({
          actorUserId: replayed.userId,
          type: 'refresh_token.reuse_detected',
          entityType: 'user',
          entityId: replayed.userId,
        })
      }
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
    const authedUser = req.user!
    const [dbUser, workspaces] = await Promise.all([
      prisma.user.findUnique({
        where: { id: authedUser.id },
        // isPlatformAdmin is the authoritative cross-tenant admin claim. Surface
        // it so the web client gates the admin UI on the backend's source of
        // truth instead of a mutable VITE_ADMIN_EMAIL build-time guess.
        select: { id: true, email: true, name: true, emailVerified: true, isPlatformAdmin: true, totpEnabled: true }
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
    const withRole = workspaces.map((w: (typeof workspaces)[number]) => {
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
    const resetUrl = `${appUrl}/#reset=${rawToken}`

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

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_COST)

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

// All fields optional and only loosely typed as strings — the handler keeps its
// `typeof === 'string'` branching and the empty-update 400, and validatePassword()
// still enforces the password policy on newPassword. The schema just rejects
// non-string junk for these fields before the handler runs. currentPassword is
// intentionally unconstrained in length so a wrong (short) password still reaches
// the bcrypt comparison and yields 401, not a schema 400.
const updateProfileSchema = z.object({
  name: z.string().trim().max(100).optional(),
  currentPassword: z.string().optional(),
  newPassword: z.string().optional(),
})

authRouter.patch(
  '/profile',
  requireAuth,
  validate(updateProfileSchema),
  asyncHandler(async (req, res) => {
    const user = req.user!
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
      updates.passwordHash = await bcrypt.hash(req.body.newPassword, BCRYPT_COST)
    }

    if (Object.keys(updates).length === 0) throw new ApiError(400, 'No updates provided')

    const passwordChanged = updates.passwordHash !== undefined

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: updates,
      select: { id: true, email: true, name: true }
    })

    // Credential change: revoke all refresh tokens so any other session must
    // re-authenticate (mirrors the password-reset handler). Only after the new
    // hash is committed, and only when the password actually changed.
    if (passwordChanged) {
      await prisma.refreshToken.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() }
      })
      void recordAudit({ actorUserId: user.id, type: 'password.change', entityType: 'User', entityId: user.id })
    }

    res.json({ user: updated })
  })
)

// ── MFA (TOTP) management ───────────────────────────────────────────────────────

// Step 1 of enrollment: mint a secret, store it encrypted (NOT yet enabled), and
// return it + the otpauth URI for the user's authenticator app. Enabling waits
// for /mfa/activate so a half-finished setup never locks anyone out.
authRouter.post(
  '/mfa/setup',
  requireAuth,
  // Enrolling a second factor is account-takeover-grade sensitive: a stolen
  // access token must not be able to attach MFA to an account that has none.
  // Require a recent credential proof (step-up), like /mfa/disable.
  requireFreshAuth,
  asyncHandler(async (req, res) => {
    const user = req.user!
    const existing = await prisma.user.findUnique({ where: { id: user.id }, select: { totpEnabled: true } })
    if (existing?.totpEnabled) throw new ApiError(409, 'MFA is already enabled')

    const secret = generateTotpSecret()
    await prisma.user.update({ where: { id: user.id }, data: { totpSecret: encryptSecret(secret) } })
    void recordAudit({ actorUserId: user.id, type: 'mfa.setup', entityType: 'User', entityId: user.id })
    res.json({ secret, otpauthUri: buildOtpauthUri(secret, user.email) })
  })
)

const mfaCodeSchema = z.object({ code: z.string().min(6).max(10) })

// Step 2: prove a code from the pending secret to flip MFA on.
authRouter.post(
  '/mfa/activate',
  requireAuth,
  // Same step-up requirement as setup — flipping MFA on is a credential change.
  requireFreshAuth,
  validate(mfaCodeSchema),
  asyncHandler(async (req, res) => {
    const user = req.user!
    const { code } = req.body as z.infer<typeof mfaCodeSchema>
    const dbUser = await prisma.user.findUnique({ where: { id: user.id }, select: { totpSecret: true, totpEnabled: true } })
    if (dbUser?.totpEnabled) throw new ApiError(409, 'MFA is already enabled')
    if (!dbUser?.totpSecret) throw new ApiError(400, 'Start MFA setup first')
    // Activation runs inside an already step-up-authenticated session (it proves the
    // user provisioned the secret), so verify WITHOUT consuming the step — consuming
    // here would make the very first login with the same-window code fail as a replay.
    if (verifyTotpStep(decryptSecret(dbUser.totpSecret), code) === null) throw new ApiError(400, 'Invalid authentication code')

    await prisma.user.update({ where: { id: user.id }, data: { totpEnabled: true } })
    // A credential factor changed — revoke all refresh tokens so any other
    // session must re-authenticate (mirrors the password-reset handler).
    await prisma.refreshToken.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() }
    })
    await markReauth(user.id) // proving a code is a fresh credential
    void recordAudit({ actorUserId: user.id, type: 'mfa.activate', entityType: 'User', entityId: user.id })
    res.json({ ok: true })
  })
)

// Turn MFA off — a sensitive action, so it requires step-up (recent re-auth).
authRouter.post(
  '/mfa/disable',
  requireAuth,
  requireFreshAuth,
  asyncHandler(async (req, res) => {
    const user = req.user!
    await prisma.user.update({ where: { id: user.id }, data: { totpEnabled: false, totpSecret: null } })
    // A credential factor changed — revoke all refresh tokens so any other
    // session must re-authenticate (mirrors the password-reset handler).
    await prisma.refreshToken.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() }
    })
    void recordAudit({ actorUserId: user.id, type: 'mfa.disable', entityType: 'User', entityId: user.id })
    res.json({ ok: true })
  })
)

// ── Step-up re-authentication ────────────────────────────────────────────────────
// Refresh the step-up clock by re-proving credentials (password, plus a TOTP code
// when MFA is on). Sensitive routes behind requireFreshAuth call this when they
// return REAUTH_REQUIRED.
const reauthSchema = z.object({
  password: z.string().min(1).max(128),
  code: z.string().min(6).max(10).optional(),
})

authRouter.post(
  '/reauth',
  authRateLimit,
  requireAuth,
  validate(reauthSchema),
  asyncHandler(async (req, res) => {
    const authed = req.user!
    const { password, code } = req.body as z.infer<typeof reauthSchema>
    const user = await prisma.user.findUnique({ where: { id: authed.id } })
    if (!user?.passwordHash) throw new ApiError(400, 'Cannot re-authenticate this account')

    if (!(await bcrypt.compare(password, user.passwordHash))) {
      throw new ApiError(401, 'Incorrect password')
    }
    if (user.totpEnabled) {
      if (!code || !user.totpSecret || !(await consumeTotpCode(user.id, decryptSecret(user.totpSecret), code))) {
        throw new ApiError(401, 'Invalid authentication code')
      }
    }

    await markReauth(user.id)
    res.json({ ok: true })
  })
)

// ── Email verification ────────────────────────────────────────────────────────

async function sendVerificationEmail(userId: string, email: string) {
  const rawToken = generateRefreshToken()
  const tokenHash = hashRefreshToken(rawToken)
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000) // 24 hours

  await prisma.emailVerificationToken.create({ data: { userId, tokenHash, expiresAt } })

  const appUrl = (process.env.APP_URL || 'http://localhost:5173').replace(/\/$/, '')
  const verifyUrl = `${appUrl}/#verify=${rawToken}`

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

// Single-use credential tokens are carried in the POST body, not the URL path,
// so they can't leak via API access logs / reverse-proxy logs / APM traces.
const tokenBodySchema = z.object({ token: z.string().trim().min(1, 'Token required').max(512) })

authRouter.post(
  '/verify-email',
  validate(tokenBodySchema),
  asyncHandler(async (req, res) => {
    const rawToken = (req.body as z.infer<typeof tokenBodySchema>).token
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
    const user = req.user!
    const dbUser = await prisma.user.findUnique({ where: { id: user.id }, select: { emailVerified: true, email: true } })
    if (dbUser?.emailVerified) return res.json({ ok: true }) // already verified

    await sendVerificationEmail(user.id, user.email)
    res.json({ ok: true })
  })
)

// ── Invite verification (public) ──────────────────────────────────────────────

// Token goes in the POST body, never the URL path — a path/query token leaks via
// proxy/access logs, browser history, referrers, and APM traces. Mirrors the
// reset-password / verify-email token handling.
authRouter.post(
  '/invite/lookup',
  validate(tokenBodySchema),
  asyncHandler(async (req, res) => {
    const rawToken = (req.body as z.infer<typeof tokenBodySchema>).token
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
  '/invite/accept',
  requireAuth,
  // Don't grant workspace access to an account that hasn't proven control of
  // its mailbox — a verified email is a precondition for joining a workspace.
  requireVerifiedEmail,
  validate(tokenBodySchema),
  asyncHandler(async (req, res) => {
    const authedUser = req.user!
    const rawToken = (req.body as z.infer<typeof tokenBodySchema>).token
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

    void recordAudit({
      workspaceId: invite.workspaceId, actorUserId: authedUser.id, type: 'invite.accept',
      entityType: 'workspaceInvite', entityId: invite.id, metadata: { role: invite.role },
    })

    res.json({ workspaceId: invite.workspaceId, role: invite.role })
  })
)
