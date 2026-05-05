import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { asyncHandler, ApiError } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import { userBelongsToWorkspace } from '../lib/workspaces.js'
import type { AuthedRequest } from '../types/auth.js'

export const leadsRouter = Router()
leadsRouter.use(requireAuth)

const VALID_STAGES = ['NEW', 'RESEARCHED', 'OUTREACH_SENT', 'REPLIED', 'BOOKED', 'CLOSED', 'DEAD']

// List leads
leadsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const workspaceId = String(req.query.workspaceId || '').trim()
    const campaignId = typeof req.query.campaignId === 'string' ? req.query.campaignId.trim() : undefined
    const stage = typeof req.query.stage === 'string' ? req.query.stage.trim() : undefined
    const page = Math.max(1, Number(req.query.page) || 1)
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25))

    if (!workspaceId) throw new ApiError(400, 'workspaceId required')

    const member = await userBelongsToWorkspace(user.id, workspaceId)
    if (!member) throw new ApiError(403, 'Access denied')

    const where = {
      workspaceId,
      ...(campaignId ? { campaignId } : {}),
      ...(stage ? { stage } : {})
    }

    const [leads, total] = await Promise.all([
      prisma.lead.findMany({
        where,
        orderBy: [{ score: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * limit,
        take: limit
      }),
      prisma.lead.count({ where })
    ])

    res.json({ leads, total, page, limit, pages: Math.ceil(total / limit) })
  })
)

// Create single lead
leadsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const workspaceId = String(req.body?.workspaceId || '').trim()
    const businessName = String(req.body?.businessName || '').trim()

    if (!workspaceId) throw new ApiError(400, 'workspaceId required')
    if (!businessName) throw new ApiError(400, 'businessName required')

    const member = await userBelongsToWorkspace(user.id, workspaceId)
    if (!member) throw new ApiError(403, 'Access denied')

    const lead = await prisma.lead.create({
      data: {
        workspaceId,
        businessName,
        campaignId: typeof req.body?.campaignId === 'string' ? req.body.campaignId || null : null,
        contactName: typeof req.body?.contactName === 'string' ? req.body.contactName.trim() || null : null,
        email: typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() || null : null,
        website: typeof req.body?.website === 'string' ? req.body.website.trim() || null : null,
        city: typeof req.body?.city === 'string' ? req.body.city.trim() || null : null,
        category: typeof req.body?.category === 'string' ? req.body.category.trim() || null : null,
        notes: typeof req.body?.notes === 'string' ? req.body.notes.trim() || null : null,
        score: Number(req.body?.score) || 0
      }
    })

    res.status(201).json({ lead })
  })
)

// Bulk import leads
leadsRouter.post(
  '/import',
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const workspaceId = String(req.body?.workspaceId || '').trim()
    const leads = req.body?.leads

    if (!workspaceId) throw new ApiError(400, 'workspaceId required')
    if (!Array.isArray(leads) || leads.length === 0) throw new ApiError(400, 'leads array required')
    if (leads.length > 500) throw new ApiError(400, 'Maximum 500 leads per import')

    const member = await userBelongsToWorkspace(user.id, workspaceId)
    if (!member) throw new ApiError(403, 'Access denied')

    const rows = leads
      .filter((l) => typeof l?.businessName === 'string' && l.businessName.trim())
      .map((l) => ({
        workspaceId,
        businessName: String(l.businessName).trim(),
        campaignId: typeof l.campaignId === 'string' ? l.campaignId || null : null,
        contactName: typeof l.contactName === 'string' ? l.contactName.trim() || null : null,
        email: typeof l.email === 'string' ? l.email.trim().toLowerCase() || null : null,
        website: typeof l.website === 'string' ? l.website.trim() || null : null,
        city: typeof l.city === 'string' ? l.city.trim() || null : null,
        category: typeof l.category === 'string' ? l.category.trim() || null : null,
        notes: typeof l.notes === 'string' ? l.notes.trim() || null : null,
        score: Number(l.score) || 0
      }))

    const result = await prisma.lead.createMany({ data: rows, skipDuplicates: false })
    res.json({ created: result.count })
  })
)

// Get lead by id
leadsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const lead = await prisma.lead.findUnique({ where: { id: req.params.id } })
    if (!lead) throw new ApiError(404, 'Lead not found')

    const member = await userBelongsToWorkspace(user.id, lead.workspaceId)
    if (!member) throw new ApiError(403, 'Access denied')

    res.json({ lead })
  })
)

// Update lead (including AI fields and stage)
leadsRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const lead = await prisma.lead.findUnique({ where: { id: req.params.id } })
    if (!lead) throw new ApiError(404, 'Lead not found')

    const member = await userBelongsToWorkspace(user.id, lead.workspaceId)
    if (!member) throw new ApiError(403, 'Access denied')

    const updates: Record<string, unknown> = {}
    const fields = ['contactName', 'email', 'website', 'city', 'category', 'notes', 'aiSummary', 'outreachAngle']
    for (const field of fields) {
      if (typeof req.body?.[field] === 'string') updates[field] = req.body[field].trim() || null
    }
    if (typeof req.body?.businessName === 'string' && req.body.businessName.trim()) {
      updates.businessName = req.body.businessName.trim()
    }
    if (typeof req.body?.score === 'number') updates.score = req.body.score
    if (typeof req.body?.stage === 'string') {
      if (!VALID_STAGES.includes(req.body.stage)) throw new ApiError(400, `stage must be one of: ${VALID_STAGES.join(', ')}`)
      updates.stage = req.body.stage
    }
    if (typeof req.body?.campaignId === 'string') updates.campaignId = req.body.campaignId || null

    const updated = await prisma.lead.update({ where: { id: req.params.id }, data: updates })
    res.json({ lead: updated })
  })
)

// Delete lead
leadsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const lead = await prisma.lead.findUnique({ where: { id: req.params.id } })
    if (!lead) throw new ApiError(404, 'Lead not found')

    const member = await userBelongsToWorkspace(user.id, lead.workspaceId)
    if (!member) throw new ApiError(403, 'Access denied')

    await prisma.lead.delete({ where: { id: req.params.id } })
    res.json({ ok: true })
  })
)
