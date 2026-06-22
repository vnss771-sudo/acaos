import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireVerifiedForMutation } from '../middleware/auth.js'
import { asyncHandler, ApiError } from '../lib/http.js'
import { parseBody, parseQuery, workspaceIdField } from '../lib/validate.js'
import { prisma } from '../lib/prisma.js'
import { userBelongsToWorkspace, assertMinimumWorkspaceRole } from '../lib/workspaces.js'
import { assertWorkspacePermission } from '../lib/permissions.js'
import { computeLeadScore, DEFAULT_SCORING_WEIGHTS } from '../lib/scoring.js'
import { normalizeEmailKey } from '@acaos/backend-core/lib/normalize.js'
import { checkLeadLimit, reserveLeadCapacity } from '../lib/limits.js'
import { escCsv } from '../lib/csv.js'
import { recordAudit } from '../lib/audit.js'
import { invalidateWorkspaceStats } from '../lib/statsCache.js'
import type { Prisma } from '@prisma/client'
import type { Assert, CreateLeadRequest, Extends, ImportLeadsRequest, LeadStage } from '@acaos/shared'

export const leadsRouter = Router()
leadsRouter.use(requireAuth)
leadsRouter.use(requireVerifiedForMutation)

async function assertCampaignInWorkspace(campaignId: string | null | undefined, workspaceId: string): Promise<void> {
  if (!campaignId) return
  const campaign = await prisma.campaign.findFirst({ where: { id: campaignId, workspaceId } })
  if (!campaign) throw new ApiError(400, 'campaignId not found in this workspace')
}

const VALID_STAGES = ['NEW', 'RESEARCHED', 'OUTREACH_SENT', 'REPLIED', 'BOOKED', 'CLOSED', 'DEAD'] as const satisfies readonly LeadStage[]

function isLeadStage(value: string): value is LeadStage {
  return VALID_STAGES.includes(value as LeadStage)
}
const MAX_SHORT = 200
const MAX_NOTES = 2_000
const MAX_AI = 5_000

// page/limit/search stay tolerant (.catch) and are clamped in the handler, matching
// the previous Number()||default behaviour rather than rejecting odd query strings.
const listLeadsQuerySchema = z.object({
  workspaceId: workspaceIdField,
  campaignId: z.string().trim().optional(),
  stage: z.string().trim().optional(),
  search: z.string().trim().optional(),
  page: z.coerce.number().int().positive().optional().catch(undefined),
  limit: z.coerce.number().int().positive().optional().catch(undefined),
})
const workspaceQuerySchema = z.object({ workspaceId: workspaceIdField })
const createLeadSchema = z.object({
  workspaceId: workspaceIdField,
  businessName: z.string().trim().min(1, 'businessName required').max(MAX_SHORT, `businessName must be at most ${MAX_SHORT} characters`),
  campaignId: z.string().optional(),
  contactName: z.string().optional(),
  email: z.string().optional(),
  website: z.string().optional(),
  city: z.string().optional(),
  category: z.string().optional(),
  notes: z.string().optional(),
})
const importLeadsSchema = z.object({
  workspaceId: workspaceIdField,
  leads: z.array(z.any()).min(1, 'leads array required').max(500, 'Maximum 500 leads per import'),
})

// Compile-time guards: the validated requests must satisfy the shared contracts.
type _CreateLeadConforms = Assert<Extends<z.infer<typeof createLeadSchema>, CreateLeadRequest>>
type _ImportLeadsConforms = Assert<Extends<z.infer<typeof importLeadsSchema>, ImportLeadsRequest>>
const idList = z.array(z.string()).min(1, 'ids array required')
const bulkDeleteSchema = z.object({ workspaceId: workspaceIdField, ids: idList.max(200, 'Maximum 200 leads per bulk delete') })
const bulkStageSchema = z.object({ workspaceId: workspaceIdField, ids: idList.max(200, 'Maximum 200 leads per bulk update'), stage: z.string().trim().min(1) })
const bulkAssignSchema = z.object({ workspaceId: workspaceIdField, ids: idList.max(200, 'Maximum 200 leads per bulk update'), campaignId: z.string().optional() })
// PATCH is a partial update: every field optional. Per-field length/stage checks
// stay in the handler so their exact messages and "only update what's present"
// semantics are preserved.
// The web edit form PATCHes the whole lead (spread of the Lead object), so the
// nullable columns arrive as null. Accept null here (unknown keys like id/phone
// are stripped by z.object); the handler's `typeof === 'string'` checks then skip
// null/absent fields, preserving the original "update only the strings sent" rule.
const updateLeadSchema = z.object({
  businessName: z.string().optional(),
  contactName: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  website: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  aiSummary: z.string().nullable().optional(),
  outreachAngle: z.string().nullable().optional(),
  stage: z.string().optional(),
  campaignId: z.string().nullable().optional(),
  score: z.number().optional(),
})
const updateDraftSchema = z.object({
  subject: z.string().optional(),
  emailBody: z.string().optional(),
  followup: z.union([z.string(), z.null()]).optional(),
})

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
    const user = req.user!
    const q = parseQuery(listLeadsQuerySchema, req)
    const workspaceId = q.workspaceId
    const campaignId = q.campaignId
    const stage = q.stage
    const search = q.search && q.search.length > MAX_SHORT ? q.search.slice(0, MAX_SHORT) : q.search
    const page = Math.max(1, q.page ?? 1)
    const limit = Math.min(100, Math.max(1, q.limit ?? 25))

    const member = await userBelongsToWorkspace(user.id, workspaceId)
    if (!member) throw new ApiError(403, 'Access denied')

    const where = {
      workspaceId,
      ...(campaignId ? { campaignId } : {}),
      ...(stage && isLeadStage(stage) ? { stage } : {}),
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
    const user = req.user!
    const body = parseBody(createLeadSchema, req)
    const workspaceId = body.workspaceId

    const member = await userBelongsToWorkspace(user.id, workspaceId)
    if (!member) throw new ApiError(403, 'Access denied')

    await checkLeadLimit(workspaceId)

    const leadData = {
      workspaceId,
      businessName: body.businessName,
      campaignId: body.campaignId || null,
      contactName: typeof body.contactName === 'string' ? body.contactName.trim() || null : null,
      email: typeof body.email === 'string' ? body.email.trim().toLowerCase() || null : null,
      emailKey: typeof body.email === 'string' ? normalizeEmailKey(body.email) : null,
      website: typeof body.website === 'string' ? body.website.trim() || null : null,
      city: typeof body.city === 'string' ? body.city.trim() || null : null,
      category: typeof body.category === 'string' ? body.category.trim() || null : null,
      notes: typeof body.notes === 'string' ? body.notes.trim() || null : null
    }

    await assertCampaignInWorkspace(leadData.campaignId, workspaceId)

    const weights = await getWorkspaceWeights(workspaceId)
    const score = computeLeadScore(leadData, weights)

    const lead = await prisma.lead.create({ data: { ...leadData, score } })
    invalidateWorkspaceStats(workspaceId) // new lead changes totals/funnel/recent
    void recordAudit({
      workspaceId, actorUserId: user.id, type: 'lead.created',
      entityType: 'lead', entityId: lead.id,
    })
    res.status(201).json({ lead })
  })
)

// Bulk import leads
leadsRouter.post(
  '/import',
  asyncHandler(async (req, res) => {
    const user = req.user!
    const { workspaceId, leads } = parseBody(importLeadsSchema, req)

    await assertWorkspacePermission(user.id, workspaceId, 'leads:import')

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
          emailKey: typeof l.email === 'string' ? normalizeEmailKey(l.email) : null,
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
    const created = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
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
    if (created > 0) invalidateWorkspaceStats(workspaceId) // bulk import shifts totals/funnel
    if (created > 0) {
      void recordAudit({
        workspaceId, actorUserId: user.id, type: 'lead.imported',
        entityType: 'lead', metadata: { created },
      })
    }
    res.json({ created })
  })
)

// Export leads as CSV
leadsRouter.get('/export', asyncHandler(async (req, res) => {
  const user = req.user!
  const { workspaceId } = parseQuery(workspaceQuerySchema, req)

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
    const user = req.user!
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
    const user = req.user!
    const leadId = req.params.id as string
    const lead = await prisma.lead.findUnique({ where: { id: leadId } })
    if (!lead) throw new ApiError(404, 'Lead not found')

    const member = await userBelongsToWorkspace(user.id, lead.workspaceId)
    if (!member) throw new ApiError(403, 'Access denied')

    const body = parseBody(updateLeadSchema, req)
    const b = body as Record<string, unknown>
    const updates: Record<string, unknown> = {}
    const shortFields = ['contactName', 'email', 'website', 'city', 'category']
    const notesFields = ['notes']
    const aiFields = ['aiSummary', 'outreachAngle']

    for (const field of shortFields) {
      if (typeof b[field] === 'string') updates[field] = (b[field] as string).trim() || null
    }
    for (const field of notesFields) {
      if (typeof b[field] === 'string') {
        const v = (b[field] as string).trim()
        if (v.length > MAX_NOTES) throw new ApiError(400, `${field} must be at most ${MAX_NOTES} characters`)
        updates[field] = v || null
      }
    }
    for (const field of aiFields) {
      if (typeof b[field] === 'string') {
        const v = (b[field] as string).trim()
        if (v.length > MAX_AI) throw new ApiError(400, `${field} must be at most ${MAX_AI} characters`)
        updates[field] = v || null
      }
    }
    if (typeof body.businessName === 'string' && body.businessName.trim()) {
      if (body.businessName.trim().length > MAX_SHORT) throw new ApiError(400, `businessName must be at most ${MAX_SHORT} characters`)
      updates.businessName = body.businessName.trim()
    }
    if (typeof body.stage === 'string') {
      if (!isLeadStage(body.stage)) throw new ApiError(400, `stage must be one of: ${VALID_STAGES.join(', ')}`)
      updates.stage = body.stage
    }
    if (typeof body.campaignId === 'string') {
      const cid = body.campaignId || null
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
    } else if (typeof body.score === 'number') {
      // Allow manual override only if no auto-rescore
      updates.score = body.score
    }

    const updated = await prisma.lead.update({ where: { id: leadId }, data: updates })
    invalidateWorkspaceStats(lead.workspaceId) // stage/score/campaign edits move funnel & top leads
    void recordAudit({
      workspaceId: lead.workspaceId, actorUserId: user.id, type: 'lead.updated',
      entityType: 'lead', entityId: leadId, metadata: { fields: Object.keys(updates) },
    })
    res.json({ lead: updated })
  })
)

// Delete lead
leadsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const user = req.user!
    const leadId = req.params.id as string
    const lead = await prisma.lead.findUnique({ where: { id: leadId } })
    if (!lead) throw new ApiError(404, 'Lead not found')

    await assertMinimumWorkspaceRole(user.id, lead.workspaceId, 'admin')

    await prisma.lead.delete({ where: { id: leadId } })
    invalidateWorkspaceStats(lead.workspaceId) // removing a lead changes totals/funnel
    void recordAudit({
      workspaceId: lead.workspaceId, actorUserId: user.id, type: 'lead.deleted',
      entityType: 'lead', entityId: leadId,
    })
    res.json({ ok: true })
  })
)

// Bulk delete leads
leadsRouter.post(
  '/bulk-delete',
  asyncHandler(async (req, res) => {
    const user = req.user!
    const { workspaceId, ids } = parseBody(bulkDeleteSchema, req)

    await assertMinimumWorkspaceRole(user.id, workspaceId, 'admin')

    const result = await prisma.lead.deleteMany({
      where: { id: { in: ids }, workspaceId }
    })
    if (result.count > 0) invalidateWorkspaceStats(workspaceId) // bulk delete changes totals/funnel
    if (result.count > 0) {
      void recordAudit({
        workspaceId, actorUserId: user.id, type: 'lead.bulk_deleted',
        entityType: 'lead', metadata: { deleted: result.count },
      })
    }
    res.json({ deleted: result.count })
  })
)

// Bulk stage update
leadsRouter.post(
  '/bulk-stage',
  asyncHandler(async (req, res) => {
    const user = req.user!
    const { workspaceId, ids, stage } = parseBody(bulkStageSchema, req)
    if (!isLeadStage(stage)) throw new ApiError(400, `stage must be one of: ${VALID_STAGES.join(', ')}`)

    await assertMinimumWorkspaceRole(user.id, workspaceId, 'admin')

    const result = await prisma.lead.updateMany({
      where: { id: { in: ids }, workspaceId },
      data: { stage: stage as LeadStage }
    })
    if (result.count > 0) invalidateWorkspaceStats(workspaceId) // bulk stage change moves the funnel
    if (result.count > 0) {
      void recordAudit({
        workspaceId, actorUserId: user.id, type: 'lead.bulk_stage_updated',
        entityType: 'lead', metadata: { updated: result.count, stage },
      })
    }
    res.json({ updated: result.count })
  })
)

// Bulk campaign assignment
leadsRouter.post(
  '/bulk-assign',
  asyncHandler(async (req, res) => {
    const user = req.user!
    const parsed = parseBody(bulkAssignSchema, req)
    const { workspaceId, ids } = parsed
    const campaignId = parsed.campaignId || null

    await assertMinimumWorkspaceRole(user.id, workspaceId, 'admin')

    if (campaignId) {
      const campaign = await prisma.campaign.findFirst({ where: { id: campaignId, workspaceId } })
      if (!campaign) throw new ApiError(404, 'Campaign not found')
    }

    const result = await prisma.lead.updateMany({
      where: { id: { in: ids }, workspaceId },
      data: { campaignId }
    })
    if (result.count > 0) {
      void recordAudit({
        workspaceId, actorUserId: user.id, type: 'lead.bulk_assigned',
        entityType: 'lead', metadata: { updated: result.count, campaignId },
      })
    }
    res.json({ updated: result.count })
  })
)

// Get outreach drafts for a lead
leadsRouter.get(
  '/:id/drafts',
  asyncHandler(async (req, res) => {
    const user = req.user!
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
    const user = req.user!
    const { workspaceId } = parseQuery(workspaceQuerySchema, req)
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
    const user = req.user!
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
    const user = req.user!
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
    const user = req.user!
    const { id: leadId, draftId } = req.params as { id: string; draftId: string }
    const draft = await prisma.outreachDraft.findUnique({ where: { id: draftId } })
    if (!draft || draft.leadId !== leadId) throw new ApiError(404, 'Draft not found')

    await assertMinimumWorkspaceRole(user.id, draft.workspaceId, 'admin')
    if (draft.status !== 'DRAFTED') throw new ApiError(409, `Cannot edit a ${draft.status.toLowerCase()} draft`)

    const body = parseBody(updateDraftSchema, req)
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
