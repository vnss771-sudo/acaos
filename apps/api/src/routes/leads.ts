import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { asyncHandler, ApiError } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import { userBelongsToWorkspace, assertMinimumWorkspaceRole } from '../lib/workspaces.js'
import { computeLeadScore, DEFAULT_SCORING_WEIGHTS } from '../lib/scoring.js'
import { checkLeadLimit, reserveLeadCapacity } from '../lib/limits.js'
import { escCsv } from '../lib/csv.js'
import { recordAudit } from '../lib/audit.js'
import type { AuthedRequest } from '../types/auth.js'
import type { LeadStage } from '@prisma/client'
import type { UpdateDraftRequest } from '@acaos/shared'

export const leadsRouter = Router()
leadsRouter.use(requireAuth)

async function assertCampaignInWorkspace(campaignId: string | null | undefined, workspaceId: string): Promise<void> {
  if (!campaignId) return
  const campaign = await prisma.campaign.findFirst({ where: { id: campaignId, workspaceId } })
  if (!campaign) throw new ApiError(400, 'campaignId not found in this workspace')
}

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
      ...(stage && VALID_STAGES.includes(stage) ? { stage: stage as LeadStage } : {}),
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

    await assertCampaignInWorkspace(leadData.campaignId, workspaceId)

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

    await assertMinimumWorkspaceRole(user.id, workspaceId, 'admin')

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

    const campaignIds = [...new Set(rows.map((r: any) => r.campaignId).filter(Boolean))]
    for (const cid of campaignIds) await assertCampaignInWorkspace(cid, workspaceId)

    // Reserve capacity and insert atomically under a per-workspace lock so the
    // batch as a whole is checked against the plan cap (not just "already full"),
    // and concurrent imports cannot race past the limit.
    const created = await prisma.$transaction(async (tx) => {
      const allowed = await reserveLeadCapacity(tx, workspaceId, rows.length)
      if (allowed < rows.length) {
        throw new ApiError(
          429,
          `Lead limit reached — importing ${rows.length} leads would exceed your plan's cap (${allowed} slot${allowed === 1 ? '' : 's'} remaining). Upgrade or import fewer.`
        )
      }
      const result = await tx.lead.createMany({ data: rows, skipDuplicates: false })
      return result.count
    })
    res.json({ created })
  })
)

// Export leads as CSV
leadsRouter.get('/export', asyncHandler(async (req, res) => {
  const user = (req as AuthedRequest).user
  const workspaceId = String(req.query.workspaceId || '').trim()
  if (!workspaceId) throw new ApiError(400, 'workspaceId required')

  await assertMinimumWorkspaceRole(user.id, workspaceId, 'admin')

  const HEADERS = ['id','businessName','contactName','email','phone','website','city','category','score','stage','sourceTag','notes','aiSummary','outreachAngle','createdAt','updatedAt']

  res.setHeader('Content-Type', 'text/csv')
  res.setHeader('Content-Disposition', `attachment; filename="leads-${workspaceId}-${new Date().toISOString().slice(0,10)}.csv"`)
  res.write(HEADERS.join(',') + '\n')

  // Cursor-based pagination prevents OOM on large workspaces.
  // Sort by id (unique, stable) rather than createdAt alone to avoid skipped/
  // duplicated rows when multiple rows share the same createdAt timestamp.
  const PAGE = 500
  let cursor: string | undefined
  let totalWritten = 0
  const MAX = 50_000

  while (totalWritten < MAX) {
    const batch = await prisma.lead.findMany({
      where: { workspaceId },
      select: {
        id: true, businessName: true, contactName: true, email: true, phone: true,
        website: true, city: true, category: true, score: true, stage: true,
        sourceTag: true, notes: true, aiSummary: true, outreachAngle: true,
        createdAt: true, updatedAt: true
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: PAGE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {})
    })

    if (batch.length === 0) break
    for (const l of batch) {
      res.write(HEADERS.map(h => escCsv((l as Record<string, unknown>)[h])).join(',') + '\n')
    }
    totalWritten += batch.length
    cursor = batch[batch.length - 1].id
    if (batch.length < PAGE) break
  }

  res.end()
}))

// Get lead by id
leadsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const lead = await prisma.lead.findUnique({ where: { id: req.params.id as string } })
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
    const leadId = req.params.id as string
    const lead = await prisma.lead.findUnique({ where: { id: leadId } })
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
    if (typeof req.body?.campaignId === 'string') {
      const cid = req.body.campaignId || null
      await assertCampaignInWorkspace(cid, lead.workspaceId)
      updates.campaignId = cid
    }

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

    const updated = await prisma.lead.update({ where: { id: leadId }, data: updates })
    res.json({ lead: updated })
  })
)

// Delete lead
leadsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const leadId = req.params.id as string
    const lead = await prisma.lead.findUnique({ where: { id: leadId } })
    if (!lead) throw new ApiError(404, 'Lead not found')

    await assertMinimumWorkspaceRole(user.id, lead.workspaceId, 'admin')

    await prisma.lead.delete({ where: { id: leadId } })
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

    await assertMinimumWorkspaceRole(user.id, workspaceId, 'admin')

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

    await assertMinimumWorkspaceRole(user.id, workspaceId, 'admin')

    const result = await prisma.lead.updateMany({
      where: { id: { in: ids }, workspaceId },
      data: { stage: stage as LeadStage }
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

    await assertMinimumWorkspaceRole(user.id, workspaceId, 'admin')

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
    const leadId = req.params.id as string
    const lead = await prisma.lead.findUnique({ where: { id: leadId } })
    if (!lead) throw new ApiError(404, 'Lead not found')

    const member = await userBelongsToWorkspace(user.id, lead.workspaceId)
    if (!member) throw new ApiError(403, 'Access denied')

    const drafts = await prisma.outreachDraft.findMany({
      where: { leadId: leadId },
      orderBy: { createdAt: 'desc' }
    })

    res.json({ drafts })
  })
)

// Approval queue — all DRAFTED drafts awaiting review for a workspace
leadsRouter.get(
  '/approvals/pending',
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const workspaceId = String(req.query.workspaceId || '').trim()
    if (!workspaceId) throw new ApiError(400, 'workspaceId required')
    const member = await userBelongsToWorkspace(user.id, workspaceId)
    if (!member) throw new ApiError(403, 'Access denied')

    const drafts = await prisma.outreachDraft.findMany({
      where: { workspaceId, status: 'DRAFTED' },
      include: { lead: { select: { id: true, businessName: true, email: true, city: true, category: true } } },
      orderBy: { createdAt: 'asc' },
      take: 100,
    })

    res.json({ drafts })
  })
)

// Approve a draft
leadsRouter.post(
  '/:id/drafts/:draftId/approve',
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const { id: leadId, draftId } = req.params as { id: string; draftId: string }
    const draft = await prisma.outreachDraft.findUnique({ where: { id: draftId } })
    if (!draft || draft.leadId !== leadId) throw new ApiError(404, 'Draft not found')

    await assertMinimumWorkspaceRole(user.id, draft.workspaceId, 'admin')

    const updated = await prisma.outreachDraft.update({
      where: { id: draftId },
      data: { status: 'APPROVED', reviewedAt: new Date(), reviewedBy: user.id },
    })
    void recordAudit({
      workspaceId: draft.workspaceId, actorUserId: user.id, type: 'draft.approve',
      entityType: 'outreachDraft', entityId: draftId, metadata: { leadId },
    })
    res.json({ draft: updated })
  })
)

// Reject a draft
leadsRouter.post(
  '/:id/drafts/:draftId/reject',
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const { id: leadId, draftId } = req.params as { id: string; draftId: string }
    const draft = await prisma.outreachDraft.findUnique({ where: { id: draftId } })
    if (!draft || draft.leadId !== leadId) throw new ApiError(404, 'Draft not found')

    await assertMinimumWorkspaceRole(user.id, draft.workspaceId, 'admin')

    const updated = await prisma.outreachDraft.update({
      where: { id: draftId },
      data: { status: 'REJECTED', reviewedAt: new Date(), reviewedBy: user.id },
    })
    void recordAudit({
      workspaceId: draft.workspaceId, actorUserId: user.id, type: 'draft.reject',
      entityType: 'outreachDraft', entityId: draftId, metadata: { leadId },
    })
    res.json({ draft: updated })
  })
)

// Edit a draft's content before approval (reviewer tweaks copy). Only DRAFTED
// drafts are editable — once APPROVED/SENT the content is locked.
leadsRouter.patch(
  '/:id/drafts/:draftId',
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const { id: leadId, draftId } = req.params as { id: string; draftId: string }
    const draft = await prisma.outreachDraft.findUnique({ where: { id: draftId } })
    if (!draft || draft.leadId !== leadId) throw new ApiError(404, 'Draft not found')

    await assertMinimumWorkspaceRole(user.id, draft.workspaceId, 'admin')
    if (draft.status !== 'DRAFTED') throw new ApiError(409, `Cannot edit a ${draft.status.toLowerCase()} draft`)

    const body = req.body as UpdateDraftRequest
    const data: { subject?: string; emailBody?: string; followup?: string | null } = {}
    if (typeof body.subject === 'string') {
      const s = body.subject.trim()
      if (!s) throw new ApiError(400, 'subject cannot be empty')
      if (s.length > 300) throw new ApiError(400, 'subject must be at most 300 characters')
      data.subject = s
    }
    if (typeof body.emailBody === 'string') {
      const b = body.emailBody.trim()
      if (!b) throw new ApiError(400, 'emailBody cannot be empty')
      if (b.length > 20_000) throw new ApiError(400, 'emailBody must be at most 20000 characters')
      data.emailBody = b
    }
    if (body.followup === null) data.followup = null
    else if (typeof body.followup === 'string') data.followup = body.followup.trim() || null

    if (Object.keys(data).length === 0) throw new ApiError(400, 'No editable fields provided')

    const updated = await prisma.outreachDraft.update({ where: { id: draftId }, data })
    void recordAudit({
      workspaceId: draft.workspaceId, actorUserId: user.id, type: 'draft.edit',
      entityType: 'outreachDraft', entityId: draftId, metadata: { leadId, fields: Object.keys(data) },
    })
    res.json({ draft: updated })
  })
)
