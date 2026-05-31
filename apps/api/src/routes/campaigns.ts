import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { asyncHandler, ApiError } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import { userBelongsToWorkspace } from '../lib/workspaces.js'
import type { AuthedRequest } from '../types/auth.js'

export const campaignsRouter = Router()
campaignsRouter.use(requireAuth)

const MAX_NAME = 200

// List campaigns for a workspace
campaignsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const workspaceId = String(req.query.workspaceId || '').trim()

    if (!workspaceId) throw new ApiError(400, 'workspaceId required')

    const member = await userBelongsToWorkspace(user.id, workspaceId)
    if (!member) throw new ApiError(403, 'Access denied')

    const campaigns = await prisma.campaign.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { leads: true } } }
    })

    res.json({ campaigns })
  })
)

// Create campaign
campaignsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const workspaceId = String(req.body?.workspaceId || '').trim()
    const name = String(req.body?.name || '').trim()
    const goalType = String(req.body?.goalType || 'BOOK_CALL').trim()

    if (!workspaceId) throw new ApiError(400, 'workspaceId required')
    if (!name) throw new ApiError(400, 'name required')
    if (name.length > MAX_NAME) throw new ApiError(400, `name must be at most ${MAX_NAME} characters`)

    const member = await userBelongsToWorkspace(user.id, workspaceId)
    if (!member) throw new ApiError(403, 'Access denied')

    const campaign = await prisma.campaign.create({
      data: { workspaceId, name, goalType }
    })

    res.status(201).json({ campaign })
  })
)

// Get campaign by id
campaignsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const campaign = await prisma.campaign.findUnique({
      where: { id: req.params.id },
      include: { _count: { select: { leads: true } } }
    })

    if (!campaign) throw new ApiError(404, 'Campaign not found')

    const member = await userBelongsToWorkspace(user.id, campaign.workspaceId)
    if (!member) throw new ApiError(403, 'Access denied')

    res.json({ campaign })
  })
)

// Update campaign
campaignsRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const existing = await prisma.campaign.findUnique({ where: { id: req.params.id } })
    if (!existing) throw new ApiError(404, 'Campaign not found')

    const member = await userBelongsToWorkspace(user.id, existing.workspaceId)
    if (!member) throw new ApiError(403, 'Access denied')

    const updates: { name?: string; goalType?: string } = {}
    if (typeof req.body?.name === 'string' && req.body.name.trim()) {
      updates.name = req.body.name.trim()
    }
    if (typeof req.body?.goalType === 'string' && req.body.goalType.trim()) {
      updates.goalType = req.body.goalType.trim()
    }

    const campaign = await prisma.campaign.update({ where: { id: req.params.id }, data: updates })
    res.json({ campaign })
  })
)

// Delete campaign
campaignsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const existing = await prisma.campaign.findUnique({ where: { id: req.params.id } })
    if (!existing) throw new ApiError(404, 'Campaign not found')

    const member = await userBelongsToWorkspace(user.id, existing.workspaceId)
    if (!member) throw new ApiError(403, 'Access denied')

    await prisma.campaign.delete({ where: { id: req.params.id } })
    res.json({ ok: true })
  })
)
