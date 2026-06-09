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

// GET /api/workspaces/:id/icp — retrieve ICP config
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
    res.json({ icp: icp ?? { workspaceId, targetIndustries: [], minEmployees: 1, maxEmployees: 999999, targetGeos: [], mustHaveEmail: false } })
  })
)

// PUT /api/workspaces/:id/icp — upsert ICP config
workspaceRouter.put(
  '/:id/icp',
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const workspaceId = req.params.id as string
    const membership = await prisma.membership.findFirst({
      where: { userId: user.id, workspaceId, role: { in: ['owner', 'admin'] } },
      select: { role: true }
    })
    if (!membership) throw new ApiError(403, 'Must be owner or admin to update ICP')

    const { targetIndustries, minEmployees, maxEmployees, targetGeos, mustHaveEmail } = req.body
    const icp = await prisma.workspaceICP.upsert({
      where: { workspaceId },
      create: {
        workspaceId,
        targetIndustries: Array.isArray(targetIndustries) ? targetIndustries : [],
        minEmployees: minEmployees ? Number(minEmployees) : 1,
        maxEmployees: maxEmployees ? Number(maxEmployees) : 999999,
        targetGeos: Array.isArray(targetGeos) ? targetGeos : [],
        mustHaveEmail: Boolean(mustHaveEmail),
      },
      update: {
        ...(Array.isArray(targetIndustries) && { targetIndustries }),
        ...(minEmployees !== undefined && { minEmployees: Number(minEmployees) }),
        ...(maxEmployees !== undefined && { maxEmployees: Number(maxEmployees) }),
        ...(Array.isArray(targetGeos) && { targetGeos }),
        ...(mustHaveEmail !== undefined && { mustHaveEmail: Boolean(mustHaveEmail) }),
      }
    })
    res.json({ icp })
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

    res.json({
      members: members.map(m => ({
        id: m.id, role: m.role, createdAt: m.createdAt, user: m.user
      }))
    })
  })
)
