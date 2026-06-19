import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { prisma } from '../lib/prisma.js'
import { asyncHandler, ApiError } from '../lib/http.js'
import { ensureWorkspaceSlug, userCanManageWorkspaceBilling, normalizeWorkspaceRole } from '../lib/workspaces.js'
import { normalizeOptionalString } from '../lib/validation.js'
import { validate, nonEmptyString } from '../lib/validate.js'
import { z } from 'zod'
import { createBillingPortalSession } from '../services/stripe.js'
import { generateApiKey, hashApiKey } from '../lib/apiKeys.js'
import { generateRefreshToken, hashRefreshToken } from '../lib/jwt.js'
import { isMailConfigured, sendMail } from '../services/mail.js'
import { escapeHtml } from '../lib/html.js'
import { encryptSecret } from '../lib/encrypt.js'
import { assertPublicMailHost } from '../lib/ssrf.js'
import { normalizeEmail, isValidEmail } from '../lib/validation.js'
import type { AuthedRequest } from '../types/auth.js'
import type { SignalType } from '../lib/signalEngine.js'
import { evictCachedWorkspace } from '../lib/ingestCache.js'

// ── F-04: SSRF protection helpers ────────────────────────────────────────────
// Host validation lives in lib/ssrf.ts (`assertPublicMailHost`), which resolves
// the hostname and rejects every address that points at private/reserved space —
// closing the DNS-resolves-to-private and IPv6/mapped bypasses that a literal
// string-prefix check cannot. Only port allow-listing remains local here.

function validateMailPort(port: number | undefined | null, allowed: number[], field: string): void {
  if (!port) return
  if (!allowed.includes(port)) {
    throw new ApiError(400, `${field}: port ${port} not permitted. Allowed: ${allowed.join(', ')}`)
  }
}

export const workspaceRouter = Router()
workspaceRouter.use(requireAuth)

workspaceRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const rows = await prisma.workspace.findMany({
      where: { memberships: { some: { userId: user.id } } },
      select: {
        id: true, name: true, slug: true, plan: true,
        subscriptionStatus: true, createdAt: true,
        _count: { select: { leads: true, campaigns: true } },
        memberships: { where: { userId: user.id }, select: { role: true }, take: 1 },
      },
      orderBy: { createdAt: 'asc' }
    })
    const workspaces = rows.map((w) => {
      const { memberships, ...rest } = w as typeof w & { memberships?: Array<{ role: string }> }
      return { ...rest, role: normalizeWorkspaceRole(memberships?.[0]?.role) }
    })
    res.json({ workspaces })
  })
)

workspaceRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const name = normalizeOptionalString(req.body?.name)
    const requestedSlug = normalizeOptionalString(req.body?.slug)

    if (!name) throw new ApiError(400, 'Workspace name is required')

    const slug = await ensureWorkspaceSlug(requestedSlug || name)

    const workspace = await prisma.workspace.create({
      data: {
        name,
        slug,
        memberships: { create: { userId: user.id, role: 'owner' } }
      },
      select: { id: true, name: true, slug: true, plan: true }
    })

    res.status(201).json({ workspace })
  })
)

workspaceRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const workspaceId = req.params.id as string
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: {
        id: true, name: true, slug: true, plan: true,
        subscriptionStatus: true, createdAt: true, updatedAt: true,
        _count: { select: { leads: true, campaigns: true } }
      }
    })

    if (!workspace) throw new ApiError(404, 'Workspace not found')

    const membership = await prisma.membership.findFirst({
      where: { userId: user.id, workspaceId: workspaceId },
      select: { role: true }
    })
    if (!membership) throw new ApiError(403, 'Access denied')

    res.json({ workspace: { ...workspace, role: membership.role } })
  })
)

const updateWorkspaceSchema = z.object({
  name: nonEmptyString.max(100).optional(),
  slug: z.string().trim().min(1).max(60).regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens').optional(),
  senderBusinessName: z.string().trim().max(200).nullable().optional(),
  senderPostalAddress: z.string().trim().max(500).nullable().optional(),
}).refine(
  data => data.name !== undefined || data.slug !== undefined || data.senderBusinessName !== undefined || data.senderPostalAddress !== undefined,
  { message: 'At least one field required' }
)

workspaceRouter.patch(
  '/:id',
  validate(updateWorkspaceSchema),
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const workspaceId = req.params.id as string
    const existing = await prisma.workspace.findUnique({ where: { id: workspaceId } })
    if (!existing) throw new ApiError(404, 'Workspace not found')

    const membership = await prisma.membership.findFirst({
      where: { userId: user.id, workspaceId: workspaceId, role: { in: ['owner', 'admin'] } },
      select: { role: true }
    })
    if (!membership) throw new ApiError(403, 'Must be owner or admin to update workspace')

    const updates: { name?: string; slug?: string; senderBusinessName?: string | null; senderPostalAddress?: string | null } = {}

    if (req.body.name) {
      updates.name = req.body.name
    }
    if (req.body.slug) {
      updates.slug = await ensureWorkspaceSlug(req.body.slug, workspaceId)
    }
    if (req.body.senderBusinessName !== undefined) {
      updates.senderBusinessName = req.body.senderBusinessName || null
    }
    if (req.body.senderPostalAddress !== undefined) {
      updates.senderPostalAddress = req.body.senderPostalAddress || null
    }

    if (Object.keys(updates).length === 0) throw new ApiError(400, 'No valid updates provided')

    const workspace = await prisma.workspace.update({
      where: { id: workspaceId },
      data: updates,
      select: { id: true, name: true, slug: true, plan: true, senderBusinessName: true, senderPostalAddress: true }
    })

    res.json({ workspace })
  })
)

workspaceRouter.post(
  '/:id/billing-portal',
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const allowed = await userCanManageWorkspaceBilling(user.id, req.params.id as string)
    if (!allowed) throw new ApiError(403, 'Access denied')

    const workspace = await prisma.workspace.findUnique({
      where: { id: req.params.id as string },
      select: { stripeCustomerId: true }
    })
    if (!workspace?.stripeCustomerId) {
      throw new ApiError(400, 'No billing account found for this workspace')
    }

    const session = await createBillingPortalSession(workspace.stripeCustomerId)
    res.json({ url: session.url })
  })
)

workspaceRouter.get(
  '/:id/members',
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const membersWorkspaceId = req.params.id as string
    const membership = await prisma.membership.findFirst({
      where: { userId: user.id, workspaceId: membersWorkspaceId },
      select: { role: true }
    })
    if (!membership) throw new ApiError(403, 'Access denied')

    const members = await prisma.membership.findMany({
      where: { workspaceId: membersWorkspaceId },
      include: { user: { select: { id: true, email: true, name: true } } },
      orderBy: { createdAt: 'asc' }
    })

    res.json({ members })
  })
)

workspaceRouter.post(
  '/:id/members',
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const workspaceId = req.params.id as string

    const canManage = await prisma.membership.findFirst({
      where: { userId: user.id, workspaceId, role: { in: ['owner', 'admin'] } },
      select: { role: true },
    })
    if (!canManage) throw new ApiError(403, 'Must be owner or admin to add members')

    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : ''
    const role = typeof req.body?.role === 'string' && ['admin', 'member'].includes(req.body.role) ? req.body.role : 'member'
    // Only an owner may grant the admin role; an admin can add members only. This
    // stops an admin from minting a second admin (lateral privilege escalation).
    if (role === 'admin' && canManage.role !== 'owner') {
      throw new ApiError(403, 'Only an owner can grant the admin role')
    }

    if (!email) throw new ApiError(400, 'email required')

    const invitee = await prisma.user.findUnique({ where: { email }, select: { id: true, email: true, name: true } })
    if (!invitee) throw new ApiError(404, 'User not found — ask them to create an account first')

    if (invitee.id === user.id) throw new ApiError(400, 'You are already a member')

    const existing = await prisma.membership.findFirst({ where: { userId: invitee.id, workspaceId } })
    if (existing) throw new ApiError(409, 'User is already a member of this workspace')

    await prisma.membership.create({ data: { userId: invitee.id, workspaceId, role } })

    res.status(201).json({ member: { email: invitee.email, name: invitee.name, role } })
  })
)

// ── Workspace invites ─────────────────────────────────────────────────────────

workspaceRouter.post(
  '/:id/invites',
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const workspaceId = req.params.id as string

    const canManage = await prisma.membership.findFirst({
      where: { userId: user.id, workspaceId, role: { in: ['owner', 'admin'] } },
      select: { role: true },
    })
    if (!canManage) throw new ApiError(403, 'Must be owner or admin to invite members')

    const rawEmail = typeof req.body?.email === 'string' ? req.body.email : ''
    const email = normalizeEmail(rawEmail)
    if (!isValidEmail(email)) throw new ApiError(400, 'Valid email required')

    const role = typeof req.body?.role === 'string' && ['admin', 'member'].includes(req.body.role) ? req.body.role : 'member'
    // Only an owner may grant the admin role (see member-add above).
    if (role === 'admin' && canManage.role !== 'owner') {
      throw new ApiError(403, 'Only an owner can grant the admin role')
    }

    // Check if already a member
    const existingUser = await prisma.user.findUnique({ where: { email } })
    if (existingUser) {
      const isMember = await prisma.membership.findFirst({ where: { userId: existingUser.id, workspaceId } })
      if (isMember) throw new ApiError(409, 'This person is already a member — add them directly using their email')
    }

    const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { name: true } })

    const rawToken = generateRefreshToken()
    const tokenHash = hashRefreshToken(rawToken)
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 days

    await prisma.workspaceInvite.upsert({
      where: { workspaceId_email: { workspaceId, email } },
      create: { workspaceId, email, role, tokenHash, expiresAt },
      update: { role, tokenHash, expiresAt, acceptedAt: null }, // refresh existing invite
    })

    const appUrl = (process.env.APP_URL || 'http://localhost:5173').replace(/\/$/, '')
    const inviteUrl = `${appUrl}?invite=${rawToken}`

    if (isMailConfigured()) {
      // Escape the workspace name — it is user-controlled and must not be able to
      // inject markup into the HTML email body. The subject is plain text.
      const safeName = escapeHtml(workspace?.name ?? 'a workspace')
      // Escape the URL for the attribute context too. The token is hex and APP_URL
      // is operator-set, so this is defence-in-depth: a misconfigured/injected
      // APP_URL cannot break out of the href and inject markup into the email body.
      const safeInviteUrl = escapeHtml(inviteUrl)
      await sendMail(email, `You've been invited to join ${workspace?.name ?? 'a workspace'} on ACAOS`,
        `<p>You've been invited to join <strong>${safeName}</strong> on ACAOS as ${role === 'admin' ? 'an admin' : 'a member'}.</p>` +
        `<p><a href="${safeInviteUrl}">Accept invitation</a></p>` +
        `<p>This link expires in 7 days. If you don't have an ACAOS account yet, you'll be asked to create one first.</p>`
      )
    } else if (process.env.NODE_ENV === 'production') {
      // Never log a URL containing the raw invite token in production.
      console.warn(`[invites] SMTP not configured; invite email was not sent to ${email}`)
    } else {
      console.log(`[invites] Invite URL for ${email}: ${inviteUrl}`)
    }

    res.status(201).json({ ok: true, email })
  })
)

workspaceRouter.get(
  '/:id/invites',
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const workspaceId = req.params.id as string

    const canManage = await prisma.membership.findFirst({
      where: { userId: user.id, workspaceId, role: { in: ['owner', 'admin'] } }
    })
    if (!canManage) throw new ApiError(403, 'Must be owner or admin')

    const invites = await prisma.workspaceInvite.findMany({
      where: { workspaceId, acceptedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
      orderBy: { createdAt: 'desc' }
    })

    res.json({ invites })
  })
)

workspaceRouter.delete(
  '/:id/invites/:inviteId',
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const workspaceId = req.params.id as string

    const canManage = await prisma.membership.findFirst({
      where: { userId: user.id, workspaceId, role: { in: ['owner', 'admin'] } }
    })
    if (!canManage) throw new ApiError(403, 'Must be owner or admin')

    await prisma.workspaceInvite.deleteMany({
      where: { id: req.params.inviteId as string, workspaceId }
    })

    res.json({ ok: true })
  })
)

workspaceRouter.delete(
  '/:id/members/:userId',
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const workspaceId = req.params.id as string
    const targetUserId = req.params.userId as string

    if (targetUserId === user.id) throw new ApiError(400, 'Cannot remove yourself — transfer ownership first')

    const myMembership = await prisma.membership.findFirst({
      where: { userId: user.id, workspaceId, role: 'owner' }
    })
    if (!myMembership) throw new ApiError(403, 'Only owners can remove members')

    const targetMembership = await prisma.membership.findFirst({ where: { userId: targetUserId, workspaceId } })
    if (!targetMembership) throw new ApiError(404, 'Member not found')

    await prisma.membership.delete({ where: { id: targetMembership.id } })
    res.json({ ok: true })
  })
)

workspaceRouter.post(
  '/:id/api-key/rotate',
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const workspaceId = req.params.id as string

    const canManage = await prisma.membership.findFirst({
      where: { userId: user.id, workspaceId, role: { in: ['owner', 'admin'] } }
    })
    if (!canManage) throw new ApiError(403, 'Must be owner or admin')

    // F-05: Evict old hash from cache before rotating so the revoked key stops working immediately
    const beforeRotate = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { ingestApiKey: true } })
    if (beforeRotate?.ingestApiKey) evictCachedWorkspace(beforeRotate.ingestApiKey)

    const rawKey = generateApiKey()
    const hashedKey = hashApiKey(rawKey)

    await prisma.workspace.update({
      where: { id: workspaceId },
      data: { ingestApiKey: hashedKey }
    })

    // Raw key shown ONCE — not stored anywhere
    res.json({ apiKey: rawKey, warning: 'Store this key securely — it will not be shown again' })
  })
)

workspaceRouter.get(
  '/:id/email-config',
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const workspaceId = req.params.id as string

    const canManage = await prisma.membership.findFirst({
      where: { userId: user.id, workspaceId, role: { in: ['owner', 'admin'] } }
    })
    if (!canManage) throw new ApiError(403, 'Must be owner or admin')

    const config = await prisma.workspaceEmailConfig.findUnique({ where: { workspaceId } })
    // Never return smtpPass / imapPass in plaintext — only indicate presence
    res.json({
      config: config ? {
        smtpHost: config.smtpHost,
        smtpPort: config.smtpPort,
        smtpSecure: config.smtpSecure,
        smtpUser: config.smtpUser,
        smtpFrom: config.smtpFrom,
        smtpPassSet: !!config.smtpPass,
        imapHost: config.imapHost,
        imapPort: config.imapPort,
        imapSecure: config.imapSecure,
        imapUser: config.imapUser,
        imapPassSet: !!config.imapPass,
      } : null
    })
  })
)

workspaceRouter.put(
  '/:id/email-config',
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const workspaceId = req.params.id as string

    const canManage = await prisma.membership.findFirst({
      where: { userId: user.id, workspaceId, role: { in: ['owner', 'admin'] } }
    })
    if (!canManage) throw new ApiError(403, 'Must be owner or admin')

    const b = req.body ?? {}
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
    const num = (v: unknown) => (typeof v === 'number' && v > 0 ? v : null)
    const bool = (v: unknown, def: boolean) => (typeof v === 'boolean' ? v : def)

    const rawSmtpPass = str(b.smtpPass)
    const rawImapPass = str(b.imapPass)

    const data = {
      smtpHost:   str(b.smtpHost),
      smtpPort:   num(b.smtpPort),
      smtpSecure: bool(b.smtpSecure, false),
      smtpUser:   str(b.smtpUser),
      smtpPass:   rawSmtpPass ? encryptSecret(rawSmtpPass) : null,
      smtpFrom:   str(b.smtpFrom),
      imapHost:   str(b.imapHost),
      imapPort:   num(b.imapPort),
      imapSecure: bool(b.imapSecure, true),
      imapUser:   str(b.imapUser),
      imapPass:   rawImapPass ? encryptSecret(rawImapPass) : null,
    }

    // F-04: SSRF validation — reject hosts that are, or resolve to, private/
    // reserved/metadata addresses, plus non-standard ports.
    await assertPublicMailHost(data.smtpHost, 'smtpHost')
    await assertPublicMailHost(data.imapHost, 'imapHost')
    validateMailPort(data.smtpPort, [25, 465, 587, 2525], 'smtpPort')
    validateMailPort(data.imapPort, [143, 993], 'imapPort')

    // If password fields omitted (null), preserve existing encrypted values
    const existing = await prisma.workspaceEmailConfig.findUnique({ where: { workspaceId } })
    if (data.smtpPass === null && existing?.smtpPass) data.smtpPass = existing.smtpPass
    if (data.imapPass === null && existing?.imapPass) data.imapPass = existing.imapPass

    await prisma.workspaceEmailConfig.upsert({
      where: { workspaceId },
      create: { workspaceId, ...data },
      update: data,
    })

    res.json({ ok: true })
  })
)

workspaceRouter.get(
  '/:id/icp',
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const workspaceId = req.params.id as string

    const membership = await prisma.membership.findFirst({
      where: { userId: user.id, workspaceId },
      select: { role: true }
    })
    if (!membership) throw new ApiError(403, 'Access denied')

    const icp = await prisma.workspaceICP.findUnique({ where: { workspaceId } })
    res.json({ icp: icp ?? null })
  })
)

workspaceRouter.put(
  '/:id/icp',
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const workspaceId = req.params.id as string

    const canManage = await prisma.membership.findFirst({
      where: { userId: user.id, workspaceId, role: { in: ['owner', 'admin'] } }
    })
    if (!canManage) throw new ApiError(403, 'Must be owner or admin to update ICP')

    const body = req.body ?? {}
    const arr = (v: unknown): string[] | undefined =>
      Array.isArray(v) ? v.filter((s: unknown) => typeof s === 'string') : undefined

    const targetIndustries = arr(body.targetIndustries)
    const targetGeos = arr(body.targetGeos)
    const excludedIndustries = arr(body.excludedIndustries)
    const minEmployees = typeof body.minEmployees === 'number' ? body.minEmployees : null
    const maxEmployees = typeof body.maxEmployees === 'number' ? body.maxEmployees : null
    const mustHaveEmail = typeof body.mustHaveEmail === 'boolean' ? body.mustHaveEmail : undefined
    const businessType = typeof body.businessType === 'string' ? body.businessType.trim() || null : undefined
    const outreachTone = typeof body.outreachTone === 'string' && ['professional', 'casual', 'direct'].includes(body.outreachTone) ? body.outreachTone : undefined
    const approvalMode = typeof body.approvalMode === 'boolean' ? body.approvalMode : undefined
    const dailySendLimit = typeof body.dailySendLimit === 'number' && body.dailySendLimit > 0 ? Math.min(body.dailySendLimit, 500) : undefined
    const playbook = typeof body.playbook === 'string' ? body.playbook || null : undefined

    const data: Record<string, unknown> = {}
    if (targetIndustries !== undefined) data.targetIndustries = targetIndustries
    if (targetGeos !== undefined) data.targetGeos = targetGeos
    if (excludedIndustries !== undefined) data.excludedIndustries = excludedIndustries
    if (minEmployees !== undefined) data.minEmployees = minEmployees
    if (maxEmployees !== undefined) data.maxEmployees = maxEmployees
    if (mustHaveEmail !== undefined) data.mustHaveEmail = mustHaveEmail
    if (businessType !== undefined) data.businessType = businessType
    if (outreachTone !== undefined) data.outreachTone = outreachTone
    if (approvalMode !== undefined) data.approvalMode = approvalMode
    if (dailySendLimit !== undefined) data.dailySendLimit = dailySendLimit
    if (playbook !== undefined) data.playbook = playbook

    const icp = await prisma.workspaceICP.upsert({
      where: { workspaceId },
      create: {
        workspaceId,
        targetIndustries: (data.targetIndustries as string[]) ?? [],
        targetGeos: (data.targetGeos as string[]) ?? [],
        excludedIndustries: (data.excludedIndustries as string[]) ?? [],
        minEmployees: (data.minEmployees as number | null) ?? null,
        maxEmployees: (data.maxEmployees as number | null) ?? null,
        mustHaveEmail: (data.mustHaveEmail as boolean) ?? false,
        businessType: (data.businessType as string | null) ?? null,
        outreachTone: (data.outreachTone as string) ?? 'professional',
        approvalMode: (data.approvalMode as boolean) ?? true,
        dailySendLimit: (data.dailySendLimit as number) ?? 50,
        playbook: (data.playbook as string | null) ?? null,
      },
      update: data,
    })

    res.json({ icp })
  })
)

workspaceRouter.delete(
  '/:id/api-key',
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const workspaceId = req.params.id as string

    const canManage = await prisma.membership.findFirst({
      where: { userId: user.id, workspaceId, role: { in: ['owner', 'admin'] } }
    })
    if (!canManage) throw new ApiError(403, 'Must be owner or admin')

    // F-05: Evict old hash from cache before deleting so the revoked key stops working immediately
    const existing = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { ingestApiKey: true } })
    if (existing?.ingestApiKey) evictCachedWorkspace(existing.ingestApiKey)

    await prisma.workspace.update({ where: { id: workspaceId }, data: { ingestApiKey: null } })
    res.json({ ok: true })
  })
)

// Deterministic per-company pseudo-score so demos look identical run-to-run and
// any test that depends on seeded data is stable. (Previously Math.random(),
// which made the dashboard and seed-dependent tests non-deterministic.)
function seededScore(companyName: string, salt: number, range: number, base: number): number {
  let h = salt >>> 0
  for (let i = 0; i < companyName.length; i++) {
    h = (Math.imul(h, 31) + companyName.charCodeAt(i)) >>> 0
  }
  return (h % range) + base
}

// Onboarding seed — marks workspace setup complete and optionally creates
// example (isExample=true) prospects so the dashboard is never empty on day 1.
workspaceRouter.post(
  '/:id/seed',
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const workspaceId = req.params.id as string

    const membership = await prisma.membership.findFirst({
      where: { userId: user.id, workspaceId, role: { in: ['owner', 'admin'] } }
    })
    if (!membership) throw new ApiError(403, 'Must be owner or admin')

    const playbookId: string | null = typeof req.body?.playbookId === 'string' ? req.body.playbookId : null
    const includeExamples: boolean = req.body?.includeExamples !== false

    // Mark onboarding complete
    await prisma.workspace.update({ where: { id: workspaceId }, data: { onboardingCompleted: true } })

    if (includeExamples && playbookId) {
      // Only seed if no real prospects exist yet
      const existingCount = await prisma.prospect.count({ where: { workspaceId, isExample: false } })
      if (existingCount === 0) {
        const seeds = SEED_COMPANIES[playbookId] ?? SEED_COMPANIES['industrial']

        // Create each prospect individually so we can attach signals + recommendation
        for (const s of seeds) {
          const exampleSignals = EXAMPLE_SIGNALS[s.companyName] ?? EXAMPLE_SIGNALS['__default__']
          const score = {
            opportunityScore: seededScore(s.companyName, 1, 25, 62),
            intentScore:      seededScore(s.companyName, 2, 20, 55),
            fitScore:         seededScore(s.companyName, 3, 20, 58),
            timingScore:      seededScore(s.companyName, 4, 25, 52),
            confidenceScore:  seededScore(s.companyName, 5, 15, 45),
          }
          // Check idempotency
          const already = await prisma.prospect.findFirst({ where: { workspaceId, companyName: s.companyName } })
          if (already) continue

          const prospect = await prisma.prospect.create({
            data: {
              workspaceId,
              companyName: s.companyName,
              industry:    s.industry,
              location:    s.location,
              employeeCount: s.employeeCount,
              description: s.description,
              contactName: s.contactName,
              contactTitle: s.contactTitle,
              isExample: true,
              buyingStage: 'EVALUATING',
              ...score,
            }
          })

          // Seed example signals so the evidence panel has content
          const now = new Date()
          await prisma.signal.createMany({
            data: exampleSignals.map(({ daysAgo, ...sig }) => ({
              workspaceId,
              prospectId: prospect.id,
              ...sig,
              detectedAt: new Date(now.getTime() - daysAgo * 86_400_000),
            }))
          })

          // Seed a recommendation so the hot accounts panel has an action
          await prisma.recommendation.create({
            data: {
              workspaceId,
              prospectId: prospect.id,
              bestContact:  s.contactName,
              bestTiming:   'Next 2 weeks',
              bestChannel:  'Email',
              messageAngle: 'Lead with recent growth evidence and how you reduce operational strain',
              reasoning:    `${s.companyName} is showing ${exampleSignals.length} buying signal${exampleSignals.length !== 1 ? 's' : ''}. They match your ICP and are currently in evaluation mode.`,
              actionText:   'Send introduction email referencing recent activity',
              urgency:      'HIGH',
              priority:     score.opportunityScore,
              expiresAt:    new Date(Date.now() + 14 * 86_400_000),
            }
          })
        }
      }
    }

    res.json({ ok: true })
  })
)

// Hardcoded seed companies per playbook (fictional, clearly marked)
const SEED_COMPANIES: Record<string, Array<{
  companyName: string; industry: string; location: string; employeeCount: number;
  description: string; contactName: string; contactTitle: string
}>> = {
  industrial: [
    { companyName: 'Ironclad Engineering Pty Ltd', industry: 'Industrial Engineering', location: 'Brisbane, QLD', employeeCount: 28, description: 'Structural fabrication and site works for mining and civil projects', contactName: 'Gary Malone', contactTitle: 'Operations Manager' },
    { companyName: 'Summit Plant & Equipment', industry: 'Construction', location: 'Ipswich, QLD', employeeCount: 15, description: 'Plant hire and civil earthworks across South-East Queensland', contactName: 'Kerry Walsh', contactTitle: 'General Manager' },
    { companyName: 'Apex Fabrication Group', industry: 'Manufacturing', location: 'Acacia Ridge, QLD', employeeCount: 42, description: 'Custom steel fabrication for industrial and resource sector clients', contactName: 'Dan Prescott', contactTitle: 'Managing Director' },
  ],
  recruitment: [
    { companyName: 'Bridgeway Labour Solutions', industry: 'Recruitment', location: 'Brisbane, QLD', employeeCount: 12, description: 'Specialised trade and industrial labour hire across QLD', contactName: 'Alicia Park', contactTitle: 'Director' },
    { companyName: 'Crestfield Workforce Group', industry: 'Staffing', location: 'Gold Coast, QLD', employeeCount: 20, description: 'Mining, civil and construction workforce supply', contactName: 'Tom Briers', contactTitle: 'Managing Director' },
    { companyName: 'Pinnacle People Pty Ltd', industry: 'HR & Recruitment', location: 'Townsville, QLD', employeeCount: 9, description: 'Regional labour hire focusing on Northern Queensland trades', contactName: 'Sarah Nguyen', contactTitle: 'Operations Lead' },
  ],
  equipment: [
    { companyName: 'TerraMax Equipment Group', industry: 'Equipment Supply', location: 'Yatala, QLD', employeeCount: 35, description: 'Heavy equipment sales, hire and servicing for construction sector', contactName: 'Phil Donovan', contactTitle: 'Sales Director' },
    { companyName: 'ProFleet Machinery', industry: 'Equipment Rental', location: 'Wacol, QLD', employeeCount: 18, description: 'Short and long-term plant hire with on-site maintenance', contactName: 'Craig Ellison', contactTitle: 'Operations Manager' },
    { companyName: 'BlueLine Attachments', industry: 'Manufacturing', location: 'Archerfield, QLD', employeeCount: 11, description: 'Custom excavator attachments and bucket rebuilds', contactName: 'Mark Sutton', contactTitle: 'Owner' },
  ],
  agency: [
    { companyName: 'Meridian Digital Studio', industry: 'Marketing Agency', location: 'Brisbane, QLD', employeeCount: 8, description: 'Web design, SEO and digital campaigns for SMEs', contactName: 'Jessica Holt', contactTitle: 'Creative Director' },
    { companyName: 'Clearpath Marketing Group', industry: 'Advertising', location: 'Fortitude Valley, QLD', employeeCount: 14, description: 'Brand strategy and digital advertising for B2B clients', contactName: 'Leo Vance', contactTitle: 'CEO' },
    { companyName: 'Vantage Content Co.', industry: 'Content Marketing', location: 'Newstead, QLD', employeeCount: 6, description: 'Content strategy, copywriting and social media management', contactName: 'Amy Foster', contactTitle: 'Managing Editor' },
  ],
  b2b_services: [
    { companyName: 'Highbridge Advisory Pty Ltd', industry: 'Business Consulting', location: 'Brisbane CBD, QLD', employeeCount: 7, description: 'Strategic advisory for growth-stage SMEs and family businesses', contactName: 'Neil Crawford', contactTitle: 'Principal' },
    { companyName: 'Focal Accounting Solutions', industry: 'Accounting', location: 'Milton, QLD', employeeCount: 11, description: 'Cloud accounting, tax and CFO-as-a-service for SMEs', contactName: 'Priya Sharma', contactTitle: 'Managing Partner' },
    { companyName: 'Sentinel Legal Group', industry: 'Legal Services', location: 'Spring Hill, QLD', employeeCount: 9, description: 'Commercial law, contracts and business dispute resolution', contactName: 'David Kwan', contactTitle: 'Principal Solicitor' },
  ],
}

type ExampleSignalRow = {
  type: SignalType; strength: number; sourceReliability: number; industryRelevance: number;
  title: string; description: string | null; source: string; daysAgo: number
}

// Fictional buying signals for each example prospect — seeds the evidence panel
const EXAMPLE_SIGNALS: Record<string, ExampleSignalRow[]> = {
  'Ironclad Engineering Pty Ltd': [
    { type: 'HIRING', strength: 78, sourceReliability: 80, industryRelevance: 85, title: '6 open positions on Seek', description: 'Hiring boilermakers, riggers and a site supervisor', source: 'example', daysAgo: 3 },
    { type: 'EXPANSION', strength: 72, sourceReliability: 70, industryRelevance: 80, title: 'Team grew 18% in 6 months', description: null, source: 'example', daysAgo: 14 },
  ],
  'Summit Plant & Equipment': [
    { type: 'PROCUREMENT', strength: 80, sourceReliability: 75, industryRelevance: 90, title: 'Tendered on 2 civil contracts', description: 'Active bids on SEQ infrastructure projects', source: 'example', daysAgo: 5 },
    { type: 'HIRING', strength: 65, sourceReliability: 80, industryRelevance: 75, title: '3 open positions', description: 'Seeking operators and a fleet coordinator', source: 'example', daysAgo: 9 },
  ],
  'Apex Fabrication Group': [
    { type: 'FUNDING', strength: 85, sourceReliability: 90, industryRelevance: 80, title: 'Series A · $4.2M total funding', description: 'Last round 4 months ago', source: 'example', daysAgo: 120 },
    { type: 'EXPANSION', strength: 75, sourceReliability: 75, industryRelevance: 85, title: 'Opened second facility in Rocklea', description: null, source: 'example', daysAgo: 21 },
    { type: 'HIRING', strength: 70, sourceReliability: 80, industryRelevance: 78, title: '8 open positions', description: 'Major recruiting push across fabrication and QA roles', source: 'example', daysAgo: 2 },
  ],
  'Bridgeway Labour Solutions': [
    { type: 'EXPANSION', strength: 70, sourceReliability: 72, industryRelevance: 80, title: 'New branch in Mackay', description: null, source: 'example', daysAgo: 30 },
    { type: 'HIRING', strength: 68, sourceReliability: 80, industryRelevance: 75, title: '4 open positions', description: null, source: 'example', daysAgo: 7 },
  ],
  'Crestfield Workforce Group': [
    { type: 'PROCUREMENT', strength: 82, sourceReliability: 78, industryRelevance: 88, title: 'Won 2 mining site contracts', description: 'Expanding workforce supply to Bowen Basin', source: 'example', daysAgo: 11 },
  ],
  'TerraMax Equipment Group': [
    { type: 'HIRING', strength: 75, sourceReliability: 80, industryRelevance: 82, title: '5 open positions', description: 'Sales reps and service technicians', source: 'example', daysAgo: 4 },
    { type: 'FUNDING', strength: 80, sourceReliability: 85, industryRelevance: 78, title: 'Seed · $1.8M raised', description: null, source: 'example', daysAgo: 90 },
  ],
  'Meridian Digital Studio': [
    { type: 'HIRING', strength: 72, sourceReliability: 80, industryRelevance: 70, title: '3 open positions', description: 'Developer, designer and a new account manager', source: 'example', daysAgo: 6 },
    { type: 'WEBSITE_CHANGE', strength: 60, sourceReliability: 65, industryRelevance: 65, title: 'Launched new service page', description: 'Added lead generation service offering', source: 'example', daysAgo: 18 },
  ],
  'Highbridge Advisory Pty Ltd': [
    { type: 'EXPANSION', strength: 73, sourceReliability: 70, industryRelevance: 78, title: 'Added 3 new advisory partners', description: null, source: 'example', daysAgo: 25 },
    { type: 'HIRING', strength: 67, sourceReliability: 80, industryRelevance: 72, title: '2 open positions', description: null, source: 'example', daysAgo: 12 },
  ],
  '__default__': [
    { type: 'HIRING', strength: 70, sourceReliability: 75, industryRelevance: 75, title: '4 open positions detected', description: null, source: 'example', daysAgo: 5 },
    { type: 'EXPANSION', strength: 68, sourceReliability: 70, industryRelevance: 72, title: 'Team headcount growing', description: null, source: 'example', daysAgo: 20 },
  ],
}
