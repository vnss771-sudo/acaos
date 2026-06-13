import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { prisma } from '../lib/prisma.js'
import { asyncHandler, ApiError } from '../lib/http.js'
import { ensureWorkspaceSlug, userCanManageWorkspaceBilling } from '../lib/workspaces.js'
import { normalizeOptionalString } from '../lib/validation.js'
import { createBillingPortalSession } from '../services/stripe.js'
import { generateApiKey, hashApiKey } from '../lib/apiKeys.js'
import { generateRefreshToken, hashRefreshToken } from '../lib/jwt.js'
import { isMailConfigured, sendMail } from '../services/mail.js'
import { encryptSecret, decryptSecret, isEncrypted } from '../lib/encrypt.js'
import { normalizeEmail, isValidEmail } from '../lib/validation.js'
import type { AuthedRequest } from '../types/auth.js'

export const workspaceRouter = Router()
workspaceRouter.use(requireAuth)

workspaceRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const workspaces = await prisma.workspace.findMany({
      where: { memberships: { some: { userId: user.id } } },
      select: {
        id: true, name: true, slug: true, plan: true,
        subscriptionStatus: true, createdAt: true,
        _count: { select: { leads: true, campaigns: true } }
      },
      orderBy: { createdAt: 'asc' }
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

workspaceRouter.patch(
  '/:id',
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

    const updates: { name?: string; slug?: string } = {}

    if (typeof req.body?.name === 'string' && req.body.name.trim()) {
      updates.name = req.body.name.trim()
    }

    if (typeof req.body?.slug === 'string' && req.body.slug.trim()) {
      updates.slug = await ensureWorkspaceSlug(req.body.slug.trim())
    }

    if (Object.keys(updates).length === 0) throw new ApiError(400, 'No valid updates provided')

    const workspace = await prisma.workspace.update({
      where: { id: workspaceId },
      data: updates,
      select: { id: true, name: true, slug: true, plan: true }
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
      where: { userId: user.id, workspaceId, role: { in: ['owner', 'admin'] } }
    })
    if (!canManage) throw new ApiError(403, 'Must be owner or admin to add members')

    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : ''
    const role = typeof req.body?.role === 'string' && ['admin', 'member'].includes(req.body.role) ? req.body.role : 'member'

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
      where: { userId: user.id, workspaceId, role: { in: ['owner', 'admin'] } }
    })
    if (!canManage) throw new ApiError(403, 'Must be owner or admin to invite members')

    const rawEmail = typeof req.body?.email === 'string' ? req.body.email : ''
    const email = normalizeEmail(rawEmail)
    if (!isValidEmail(email)) throw new ApiError(400, 'Valid email required')

    const role = typeof req.body?.role === 'string' && ['admin', 'member'].includes(req.body.role) ? req.body.role : 'member'

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
      await sendMail(email, `You've been invited to join ${workspace?.name ?? 'a workspace'} on ACAOS`,
        `<p>You've been invited to join <strong>${workspace?.name ?? 'a workspace'}</strong> on ACAOS as ${role === 'admin' ? 'an admin' : 'a member'}.</p>` +
        `<p><a href="${inviteUrl}">Accept invitation</a></p>` +
        `<p>This link expires in 7 days. If you don't have an ACAOS account yet, you'll be asked to create one first.</p>`
      )
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

    await prisma.workspace.update({ where: { id: workspaceId }, data: { ingestApiKey: null } })
    res.json({ ok: true })
  })
)

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
        await prisma.prospect.createMany({
          data: seeds.map(s => ({
            workspaceId,
            companyName: s.companyName,
            industry: s.industry,
            location: s.location,
            employeeCount: s.employeeCount,
            description: s.description,
            contactName: s.contactName,
            contactTitle: s.contactTitle,
            isExample: true,
            opportunityScore: Math.floor(Math.random() * 30) + 60,
            intentScore: Math.floor(Math.random() * 25) + 50,
            fitScore: Math.floor(Math.random() * 25) + 55,
            timingScore: Math.floor(Math.random() * 30) + 50,
            confidenceScore: Math.floor(Math.random() * 20) + 40,
          })),
          skipDuplicates: true
        })
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
