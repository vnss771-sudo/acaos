import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { prisma } from '../lib/prisma.js'
import { asyncHandler, ApiError } from '../lib/http.js'
import { ensureWorkspaceSlug, userCanManageWorkspaceBilling } from '../lib/workspaces.js'
import { normalizeOptionalString } from '../lib/validation.js'
import { createBillingPortalSession } from '../services/stripe.js'
import { generateApiKey, hashApiKey } from '../lib/apiKeys.js'
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

    res.status(201).json({ member: { ...invitee, role } })
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

    const data = {
      smtpHost:   str(b.smtpHost),
      smtpPort:   num(b.smtpPort),
      smtpSecure: bool(b.smtpSecure, false),
      smtpUser:   str(b.smtpUser),
      smtpPass:   str(b.smtpPass),
      smtpFrom:   str(b.smtpFrom),
      imapHost:   str(b.imapHost),
      imapPort:   num(b.imapPort),
      imapSecure: bool(b.imapSecure, true),
      imapUser:   str(b.imapUser),
      imapPass:   str(b.imapPass),
    }

    // If password fields omitted (null), keep existing values
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
    const targetIndustries = Array.isArray(body.targetIndustries) ? body.targetIndustries.filter((s: unknown) => typeof s === 'string') : undefined
    const targetGeos = Array.isArray(body.targetGeos) ? body.targetGeos.filter((s: unknown) => typeof s === 'string') : undefined
    const minEmployees = typeof body.minEmployees === 'number' ? body.minEmployees : null
    const maxEmployees = typeof body.maxEmployees === 'number' ? body.maxEmployees : null
    const mustHaveEmail = typeof body.mustHaveEmail === 'boolean' ? body.mustHaveEmail : undefined

    const data: Record<string, unknown> = {}
    if (targetIndustries !== undefined) data.targetIndustries = targetIndustries
    if (targetGeos !== undefined) data.targetGeos = targetGeos
    if (minEmployees !== undefined) data.minEmployees = minEmployees
    if (maxEmployees !== undefined) data.maxEmployees = maxEmployees
    if (mustHaveEmail !== undefined) data.mustHaveEmail = mustHaveEmail

    const icp = await prisma.workspaceICP.upsert({
      where: { workspaceId },
      create: {
        workspaceId,
        targetIndustries: (data.targetIndustries as string[]) ?? [],
        targetGeos: (data.targetGeos as string[]) ?? [],
        minEmployees: (data.minEmployees as number | null) ?? null,
        maxEmployees: (data.maxEmployees as number | null) ?? null,
        mustHaveEmail: (data.mustHaveEmail as boolean) ?? false,
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
