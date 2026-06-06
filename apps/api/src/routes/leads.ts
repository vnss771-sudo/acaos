import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { asyncHandler, ApiError } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import { userBelongsToWorkspace } from '../lib/workspaces.js'
import { computeLeadScore, DEFAULT_SCORING_WEIGHTS } from '../lib/scoring.js'
import { checkLeadLimit } from '../lib/limits.js'
import type { AuthedRequest } from '../types/auth.js'

export const leadsRouter = Router()
leadsRouter.use(requireAuth)

const VALID_STAGES = ['NEW', 'RESEARCHED', 'OUTREACH_SENT', 'REPLIED', 'BOOKED', 'CLOSED', 'DEAD']
const MAX_SHORT = 200
const MAX_NOTES = 2_000
const MAX_AI = 5_000

async function getWorkspaceWeights(workspaceId: string) {
  const model = await prisma.scoringModel.findUnique({
    where: { workspaceId },
    select: { weights: true }
  })
  return (model?.weights as typeof DEFAULT_SCORING_WEIGHTS | null) ?? DEFAULT_SCORING_WEIGHTS
}

// List leads
leadsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const workspaceId = String(req.query.workspaceId || '').trim()
    const campaignId = typeof req.query.campaignId === 'string' ? req.query.campaignId.trim() : undefined
    const stage = typeof req.query.stage === 'string' ? req.query.stage.trim() : undefined
    const rawSearch = typeof req.query.search === 'string' ? req.query.search.trim() : undefined
    const search = rawSearch && rawSearch.length > MAX_SHORT ? rawSearch.slice(0, MAX_SHORT) : rawSearch
    const page = Math.max(1, Number(req.query.page) || 1)
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25))

    if (!workspaceId) throw new ApiError(400, 'workspaceId required')

    const member = await userBelongsToWorkspace(user.id, workspaceId)
    if (!member) throw new ApiError(403, 'Access denied')

    const where = {
      workspaceId,
      ...(campaignId ? { campaignId } : {}),
      ...(stage ? { stage } : {}),
      ...(search ? {
        OR: [
          { businessName: { contains: search, mode: 'insensitive' as const } },
          { contactName: { contains: search, mode: 'insensitive' as const } },
          { email: { contains: search, mode: 'insensitive' as const } },
          { category: { contains: search, mode: 'insensitive' as const } }
        ]
      } : {})
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
    if (businessName.length > MAX_SHORT) throw new ApiError(400, `businessName must be at most ${MAX_SHORT} characters`)

    const member = await userBelongsToWorkspace(user.id, workspaceId)
    if (!member) throw new ApiError(403, 'Access denied')

    await checkLeadLimit(workspaceId)

    const leadData = {
      workspaceId,
      businessName,
      campaignId: typeof req.body?.campaignId === 'string' ? req.body.campaignId || null : null,
      contactName: typeof req.body?.contactName === 'string' ? req.body.contactName.trim() || null : null,
      email: typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() || null : null,
      website: typeof req.body?.website === 'string' ? req.body.website.trim() || null : null,
      city: typeof req.body?.city === 'string' ? req.body.city.trim() || null : null,
      category: typeof req.body?.category === 'string' ? req.body.category.trim() || null : null,
      notes: typeof req.body?.notes === 'string' ? req.body.notes.trim() || null : null
    }

    const weights = await getWorkspaceWeights(workspaceId)
    const score = computeLeadScore(leadData, weights)

    const lead = await prisma.lead.create({ data: { ...leadData, score } })
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

    await checkLeadLimit(workspaceId)

    const weights = await getWorkspaceWeights(workspaceId)

    const rows = leads
      .filter((l) => typeof l?.businessName === 'string' && l.businessName.trim())
      .map((l) => {
        const row = {
          workspaceId,
          businessName: String(l.businessName).trim(),
          campaignId: typeof l.campaignId === 'string' ? l.campaignId || null : null,
          contactName: typeof l.contactName === 'string' ? l.contactName.trim() || null : null,
          email: typeof l.email === 'string' ? l.email.trim().toLowerCase() || null : null,
          website: typeof l.website === 'string' ? l.website.trim() || null : null,
          city: typeof l.city === 'string' ? l.city.trim() || null : null,
          category: typeof l.category === 'string' ? l.category.trim() || null : null,
          notes: typeof l.notes === 'string' ? l.notes.trim() || null : null,
          sourceTag: typeof l.sourceTag === 'string' ? l.sourceTag.trim() || null : null
        }
        return { ...row, score: computeLeadScore(row, weights) }
      })

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
    const shortFields = ['contactName', 'email', 'website', 'city', 'category']
    const notesFields = ['notes']
    const aiFields = ['aiSummary', 'outreachAngle']

    for (const field of shortFields) {
      if (typeof req.body?.[field] === 'string') updates[field] = req.body[field].trim() || null
    }
    for (const field of notesFields) {
      if (typeof req.body?.[field] === 'string') {
        const v = req.body[field].trim()
        if (v.length > MAX_NOTES) throw new ApiError(400, `${field} must be at most ${MAX_NOTES} characters`)
        updates[field] = v || null
      }
    }
    for (const field of aiFields) {
      if (typeof req.body?.[field] === 'string') {
        const v = req.body[field].trim()
        if (v.length > MAX_AI) throw new ApiError(400, `${field} must be at most ${MAX_AI} characters`)
        updates[field] = v || null
      }
    }
    if (typeof req.body?.businessName === 'string' && req.body.businessName.trim()) {
      if (req.body.businessName.trim().length > MAX_SHORT) throw new ApiError(400, `businessName must be at most ${MAX_SHORT} characters`)
      updates.businessName = req.body.businessName.trim()
    }
    if (typeof req.body?.stage === 'string') {
      if (!VALID_STAGES.includes(req.body.stage)) throw new ApiError(400, `stage must be one of: ${VALID_STAGES.join(', ')}`)
      updates.stage = req.body.stage
    }
    if (typeof req.body?.campaignId === 'string') updates.campaignId = req.body.campaignId || null

    // Recompute score whenever ICP-relevant fields change
    const scoringFields = ['businessName', 'category', 'contactName', 'email', 'website', 'notes', 'aiSummary', 'outreachAngle']
    const shouldRescore = scoringFields.some(f => f in updates)
    if (shouldRescore) {
      const merged = { ...lead, ...updates }
      const weights = await getWorkspaceWeights(lead.workspaceId)
      updates.score = computeLeadScore(merged as Parameters<typeof computeLeadScore>[0], weights)
    } else if (typeof req.body?.score === 'number') {
      // Allow manual override only if no auto-rescore
      updates.score = req.body.score
    }

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

// Bulk delete leads
leadsRouter.post(
  '/bulk-delete',
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const workspaceId = String(req.body?.workspaceId || '').trim()
    const ids = req.body?.ids

    if (!workspaceId) throw new ApiError(400, 'workspaceId required')
    if (!Array.isArray(ids) || ids.length === 0) throw new ApiError(400, 'ids array required')
    if (ids.length > 200) throw new ApiError(400, 'Maximum 200 leads per bulk delete')

    const member = await userBelongsToWorkspace(user.id, workspaceId)
    if (!member) throw new ApiError(403, 'Access denied')

    const result = await prisma.lead.deleteMany({
      where: { id: { in: ids }, workspaceId }
    })
    res.json({ deleted: result.count })
  })
)

// Bulk stage update
leadsRouter.post(
  '/bulk-stage',
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const workspaceId = String(req.body?.workspaceId || '').trim()
    const ids = req.body?.ids
    const stage = String(req.body?.stage || '').trim()

    if (!workspaceId) throw new ApiError(400, 'workspaceId required')
    if (!Array.isArray(ids) || ids.length === 0) throw new ApiError(400, 'ids array required')
    if (ids.length > 200) throw new ApiError(400, 'Maximum 200 leads per bulk update')
    if (!VALID_STAGES.includes(stage)) throw new ApiError(400, `stage must be one of: ${VALID_STAGES.join(', ')}`)

    const member = await userBelongsToWorkspace(user.id, workspaceId)
    if (!member) throw new ApiError(403, 'Access denied')

    const result = await prisma.lead.updateMany({
      where: { id: { in: ids }, workspaceId },
      data: { stage }
    })
    res.json({ updated: result.count })
  })
)

// Bulk campaign assignment
leadsRouter.post(
  '/bulk-assign',
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const workspaceId = String(req.body?.workspaceId || '').trim()
    const ids = req.body?.ids
    const campaignId = typeof req.body?.campaignId === 'string' ? req.body.campaignId || null : null

    if (!workspaceId) throw new ApiError(400, 'workspaceId required')
    if (!Array.isArray(ids) || ids.length === 0) throw new ApiError(400, 'ids array required')
    if (ids.length > 200) throw new ApiError(400, 'Maximum 200 leads per bulk update')

    const member = await userBelongsToWorkspace(user.id, workspaceId)
    if (!member) throw new ApiError(403, 'Access denied')

    if (campaignId) {
      const campaign = await prisma.campaign.findFirst({ where: { id: campaignId, workspaceId } })
      if (!campaign) throw new ApiError(404, 'Campaign not found')
    }

    const result = await prisma.lead.updateMany({
      where: { id: { in: ids }, workspaceId },
      data: { campaignId }
    })
    res.json({ updated: result.count })
  })
)

// Get outreach drafts for a lead
leadsRouter.get(
  '/:id/drafts',
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const lead = await prisma.lead.findUnique({ where: { id: req.params.id } })
    if (!lead) throw new ApiError(404, 'Lead not found')

    const member = await userBelongsToWorkspace(user.id, lead.workspaceId)
    if (!member) throw new ApiError(403, 'Access denied')

    const drafts = await prisma.outreachDraft.findMany({
      where: { leadId: req.params.id },
      orderBy: { createdAt: 'desc' }
    })

    res.json({ drafts })
  })
)
