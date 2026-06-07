import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { prisma } from '../lib/prisma.js'
import { asyncHandler, ApiError } from '../lib/http.js'
import { ensureWorkspaceSlug, userCanManageWorkspaceBilling } from '../lib/workspaces.js'
import { normalizeOptionalString } from '../lib/validation.js'
import { createBillingPortalSession } from '../services/stripe.js'
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
    const workspace = await prisma.workspace.findUnique({
      where: { id: req.params.id },
      select: {
        id: true, name: true, slug: true, plan: true,
        subscriptionStatus: true, createdAt: true, updatedAt: true,
        _count: { select: { leads: true, campaigns: true } }
      }
    })

    if (!workspace) throw new ApiError(404, 'Workspace not found')

    const membership = await prisma.membership.findFirst({
      where: { userId: user.id, workspaceId: req.params.id },
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
    const existing = await prisma.workspace.findUnique({ where: { id: req.params.id } })
    if (!existing) throw new ApiError(404, 'Workspace not found')

    const membership = await prisma.membership.findFirst({
      where: { userId: user.id, workspaceId: req.params.id, role: { in: ['owner', 'admin'] } },
      select: { role: true }
    })
    if (!membership) throw new ApiError(403, 'Must be owner or admin to update workspace')

    const updates: { name?: string; slug?: string; webhookUrl?: string | null } = {}

    if (typeof req.body?.name === 'string' && req.body.name.trim()) {
      updates.name = req.body.name.trim()
    }

    if (typeof req.body?.slug === 'string' && req.body.slug.trim()) {
      updates.slug = await ensureWorkspaceSlug(req.body.slug.trim())
    }

    if ('webhookUrl' in req.body) {
      const rawUrl = req.body.webhookUrl
      if (rawUrl === null || rawUrl === '') {
        updates.webhookUrl = null
      } else if (typeof rawUrl === 'string') {
        try { new URL(rawUrl) } catch { throw new ApiError(400, 'webhookUrl must be a valid URL') }
        updates.webhookUrl = rawUrl.trim()
      }
    }

    if (Object.keys(updates).length === 0) throw new ApiError(400, 'No valid updates provided')

    const workspace = await prisma.workspace.update({
      where: { id: req.params.id },
      data: updates,
      select: { id: true, name: true, slug: true, plan: true, webhookUrl: true }
    })

    res.json({ workspace })
  })
)

workspaceRouter.post(
  '/:id/billing-portal',
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const allowed = await userCanManageWorkspaceBilling(user.id, req.params.id)
    if (!allowed) throw new ApiError(403, 'Access denied')

    const workspace = await prisma.workspace.findUnique({
      where: { id: req.params.id },
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
    const membership = await prisma.membership.findFirst({
      where: { userId: user.id, workspaceId: req.params.id },
      select: { role: true }
    })
    if (!membership) throw new ApiError(403, 'Access denied')

    const members = await prisma.membership.findMany({
      where: { workspaceId: req.params.id },
      include: { user: { select: { id: true, email: true, name: true } } },
      orderBy: { createdAt: 'asc' }
    })

    res.json({
      members: members.map(m => ({
        id: m.id, role: m.role, createdAt: m.createdAt, user: m.user
      }))
    })
  })
)

// DELETE /api/workspaces/:id/members/:memberId — remove a member (owner only)
workspaceRouter.delete(
  '/:id/members/:memberId',
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const { id: workspaceId, memberId } = req.params

    const callerMembership = await prisma.membership.findFirst({
      where: { userId: user.id, workspaceId, role: 'owner' }
    })
    if (!callerMembership) throw new ApiError(403, 'Only workspace owners can remove members')

    const target = await prisma.membership.findFirst({ where: { id: memberId, workspaceId } })
    if (!target) throw new ApiError(404, 'Member not found')
    if (target.role === 'owner') throw new ApiError(400, 'Cannot remove the workspace owner')
    if (target.userId === user.id) throw new ApiError(400, 'Cannot remove yourself')

    await prisma.membership.delete({ where: { id: memberId } })
    res.json({ ok: true })
  })
)

// GET /api/workspaces/:id/settings — return workspace with webhookUrl (owner only)
workspaceRouter.get(
  '/:id/settings',
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const membership = await prisma.membership.findFirst({
      where: { userId: user.id, workspaceId: req.params.id, role: { in: ['owner', 'admin'] } }
    })
    if (!membership) throw new ApiError(403, 'Access denied')

    const workspace = await prisma.workspace.findUnique({
      where: { id: req.params.id },
      select: { id: true, name: true, slug: true, plan: true, webhookUrl: true, ingestApiKey: true }
    })
    if (!workspace) throw new ApiError(404, 'Workspace not found')

    res.json({ workspace: { ...workspace, role: membership.role } })
  })
)
