import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { asyncHandler, ApiError } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import { userBelongsToWorkspace } from '../lib/workspaces.js'
import { computeLeadScore, DEFAULT_SCORING_WEIGHTS } from '../lib/scoring.js'
import { checkLeadLimit } from '../lib/limits.js'
import { logActivity, logBatch } from '../lib/activity.js'
import { fireStageWebhook } from '../lib/webhook.js'
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

function toCsvRow(fields: string[]): string {
  return fields.map(f => `"${String(f ?? '').replace(/"/g, '""')}"`).join(',')
}

// CSV Export — GET /api/leads/export.csv
leadsRouter.get(
  '/export.csv',
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const workspaceId = String(req.query.workspaceId || '').trim()
    const stage = typeof req.query.stage === 'string' ? req.query.stage.trim() : undefined
    const campaignId = typeof req.query.campaignId === 'string' ? req.query.campaignId.trim() : undefined

    if (!workspaceId) throw new ApiError(400, 'workspaceId required')
    const member = await userBelongsToWorkspace(user.id, workspaceId)
    if (!member) throw new ApiError(403, 'Access denied')

    const where = {
      workspaceId,
      ...(stage ? { stage } : {}),
      ...(campaignId ? { campaignId } : {})
    }

    const leads = await prisma.lead.findMany({
      where,
      orderBy: [{ score: 'desc' }, { createdAt: 'desc' }],
      take: 10_000
    })

    const headers = ['businessName', 'contactName', 'email', 'phone', 'website', 'city', 'category', 'stage', 'score', 'notes', 'aiSummary', 'outreachAngle', 'sourceTag', 'createdAt']
    const rows = [
      toCsvRow(headers),
      ...leads.map(l => toCsvRow([
        l.businessName, l.contactName ?? '', l.email ?? '', l.phone ?? '',
        l.website ?? '', l.city ?? '', l.category ?? '', l.stage, String(l.score),
        l.notes ?? '', l.aiSummary ?? '', l.outreachAngle ?? '',
        l.sourceTag ?? '', l.createdAt.toISOString()
      ]))
    ]

    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="leads-${workspaceId}-${new Date().toISOString().slice(0, 10)}.csv"`)
    res.send('﻿' + rows.join('\r\n')) // BOM for Excel compatibility
  })
)

// List leads — GET /api/leads
leadsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const workspaceId = String(req.query.workspaceId || '').trim()
    const campaignId = typeof req.query.campaignId === 'string' ? req.query.campaignId.trim() : undefined
    const stage = typeof req.query.stage === 'string' ? req.query.stage.trim() : undefined
    const tier = typeof req.query.tier === 'string' ? req.query.tier.trim().toUpperCase() : undefined
    const rawSearch = typeof req.query.search === 'string' ? req.query.search.trim() : undefined
    const search = rawSearch && rawSearch.length > MAX_SHORT ? rawSearch.slice(0, MAX_SHORT) : rawSearch
    const page = Math.max(1, Number(req.query.page) || 1)
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25))

    if (!workspaceId) throw new ApiError(400, 'workspaceId required')
    const member = await userBelongsToWorkspace(user.id, workspaceId)
    if (!member) throw new ApiError(403, 'Access denied')

    // Tier filter translates to score ranges
    let scoreFilter: { gte?: number; lt?: number } | undefined
    if (tier === 'HOT') scoreFilter = { gte: 72 }
    else if (tier === 'WARM') scoreFilter = { gte: 48, lt: 72 }
    else if (tier === 'COLD') scoreFilter = { lt: 48 }

    const where = {
      workspaceId,
      ...(campaignId ? { campaignId } : {}),
      ...(stage ? { stage } : {}),
      ...(scoreFilter ? { score: scoreFilter } : {}),
      ...(search ? {
        OR: [
          { businessName: { contains: search, mode: 'insensitive' as const } },
          { contactName: { contains: search, mode: 'insensitive' as const } },
          { email: { contains: search, mode: 'insensitive' as const } },
          { category: { contains: search, mode: 'insensitive' as const } },
          { city: { contains: search, mode: 'insensitive' as const } }
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

    await logActivity({
      leadId: lead.id, workspaceId, userId: user.id,
      type: 'CREATED',
      meta: { businessName: lead.businessName, score, stage: 'NEW' }
    })

    res.status(201).json({ lead })
  })
)

// Bulk import leads — POST /api/leads/import
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

    // Upsert leads with email (dedup within workspace), create leads without email
    const withEmail = rows.filter(r => r.email)
    const withoutEmail = rows.filter(r => !r.email)

    let created = 0
    let updated = 0

    for (const row of withEmail) {
      const existing = await prisma.lead.findFirst({
        where: { workspaceId, email: row.email! }
      })
      if (existing) {
        await prisma.lead.update({
          where: { id: existing.id },
          data: {
            businessName: row.businessName,
            contactName: row.contactName,
            website: row.website,
            city: row.city,
            category: row.category,
            notes: row.notes,
            sourceTag: row.sourceTag,
            score: row.score
          }
        })
        updated++
      } else {
        await prisma.lead.create({ data: row })
        created++
      }
    }

    if (withoutEmail.length > 0) {
      const res2 = await prisma.lead.createMany({ data: withoutEmail, skipDuplicates: true })
      created += res2.count
    }

    // Log activity for newly created leads (too expensive to log all for large imports)
    // Just log a single IMPORTED event per batch on the workspace
    if (created > 0 || updated > 0) {
      // Find the most recently created leads from this import batch to log
      const recentLeads = await prisma.lead.findMany({
        where: { workspaceId, createdAt: { gte: new Date(Date.now() - 5000) } },
        select: { id: true },
        take: Math.min(created, 50)
      })
      if (recentLeads.length > 0) {
        await logBatch(recentLeads.map(l => ({
          leadId: l.id,
          workspaceId,
          userId: user.id,
          type: 'IMPORTED' as const,
          meta: { batchSize: rows.length, created, updated }
        })))
      }
    }

    res.json({ created, updated, total: created + updated })
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

// Get activity log for a lead
leadsRouter.get(
  '/:id/activity',
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const lead = await prisma.lead.findUnique({ where: { id: req.params.id } })
    if (!lead) throw new ApiError(404, 'Lead not found')

    const member = await userBelongsToWorkspace(user.id, lead.workspaceId)
    if (!member) throw new ApiError(403, 'Access denied')

    const activities = await prisma.leadActivity.findMany({
      where: { leadId: req.params.id },
      orderBy: { createdAt: 'desc' },
      take: 50
    })

    res.json({ activities })
  })
)

// Update lead
leadsRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const lead = await prisma.lead.findUnique({ where: { id: req.params.id } })
    if (!lead) throw new ApiError(404, 'Lead not found')

    const member = await userBelongsToWorkspace(user.id, lead.workspaceId)
    if (!member) throw new ApiError(403, 'Access denied')

    const updates: Record<string, unknown> = {}
    const shortFields = ['contactName', 'website', 'city', 'category', 'phone']
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
    // Email updates — normalise and check uniqueness
    if (typeof req.body?.email === 'string') {
      const newEmail = req.body.email.trim().toLowerCase() || null
      if (newEmail && newEmail !== lead.email) {
        const conflict = await prisma.lead.findFirst({
          where: { workspaceId: lead.workspaceId, email: newEmail, id: { not: lead.id } }
        })
        if (conflict) throw new ApiError(409, 'A lead with this email already exists in the workspace')
      }
      updates.email = newEmail
    }

    const prevStage = lead.stage
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
      updates.score = req.body.score
    }

    const updated = await prisma.lead.update({ where: { id: req.params.id }, data: updates })

    // Log significant changes
    if (updates.stage && updates.stage !== prevStage) {
      await logActivity({
        leadId: lead.id, workspaceId: lead.workspaceId, userId: user.id,
        type: 'STAGE_CHANGE',
        meta: { from: prevStage, to: updates.stage }
      })
      fireStageWebhook(lead.workspaceId, lead.id, lead.businessName, prevStage, String(updates.stage))
    } else if (Object.keys(updates).length > 0) {
      await logActivity({
        leadId: lead.id, workspaceId: lead.workspaceId, userId: user.id,
        type: 'FIELD_UPDATE',
        meta: { fields: Object.keys(updates).filter(k => k !== 'score'), newScore: updated.score }
      })
    }

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

// Bulk delete
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

    // Log bulk stage change
    await logBatch(ids.slice(0, result.count).map(id => ({
      leadId: id, workspaceId, userId: user.id,
      type: 'STAGE_CHANGE' as const,
      meta: { to: stage, bulk: true }
    })))

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

// Bulk enqueue research
leadsRouter.post(
  '/bulk-research',
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const workspaceId = String(req.body?.workspaceId || '').trim()
    const ids = req.body?.ids

    if (!workspaceId) throw new ApiError(400, 'workspaceId required')
    if (!Array.isArray(ids) || ids.length === 0) throw new ApiError(400, 'ids array required')
    if (ids.length > 50) throw new ApiError(400, 'Maximum 50 leads per bulk research')

    const member = await userBelongsToWorkspace(user.id, workspaceId)
    if (!member) throw new ApiError(403, 'Access denied')

    const { enqueueResearchLead } = await import('../lib/queues.js')
    const { checkAndIncrementAiUsage } = await import('../lib/limits.js')

    const jobs = []
    for (const leadId of ids) {
      try {
        await checkAndIncrementAiUsage(workspaceId, 'AI_RESEARCH')
        const job = await enqueueResearchLead(leadId, user.id)
        jobs.push({ leadId, jobId: job.id })
      } catch {
        break // Stop on limit reached
      }
    }

    res.status(202).json({ queued: jobs.length, jobs })
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
