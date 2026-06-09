import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { asyncHandler, ApiError } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import {
  calculateOpportunityScores,
  detectBuyingStage,
  calcWinProbability,
  generateRuleBasedRecommendation,
  getOpportunityTier
} from '../lib/signalEngine.js'
import { userHasWorkspaceAccess } from '../lib/workspaces.js'
import type { RawSignal, ICPConfig } from '../lib/signalEngine.js'
import type { AuthedRequest } from '../types/auth.js'

export const prospectsRouter = Router()
prospectsRouter.use(requireAuth)

function toRawSignal(s: { type: string; strength: number; sourceReliability: number; industryRelevance: number; detectedAt: Date }): RawSignal {
  return {
    type: s.type as RawSignal['type'],
    strength: s.strength,
    sourceReliability: s.sourceReliability,
    industryRelevance: s.industryRelevance,
    detectedAt: s.detectedAt
  }
}

async function getICP(workspaceId: string): Promise<ICPConfig | null> {
  return prisma.workspaceICP.findUnique({ where: { workspaceId } })
}

// GET /api/prospects?workspaceId=&tier=&stage=&page=&limit=
prospectsRouter.get('/', asyncHandler(async (req, res) => {
  const workspaceId = req.query.workspaceId as string
  if (!workspaceId) throw new ApiError(400, 'workspaceId required')

  const userId = (req as AuthedRequest).user.id
  if (!await userHasWorkspaceAccess(userId, workspaceId)) throw new ApiError(403, 'Access denied')

  const page = Math.max(1, parseInt(req.query.page as string) || 1)
  const limit = Math.min(100, parseInt(req.query.limit as string) || 25)
  const skip = (page - 1) * limit
  const tierFilter = req.query.tier as string | undefined
  const stageFilter = req.query.stage as string | undefined
  const outcomeFilter = req.query.outcome as string | undefined
  const search = req.query.search as string | undefined

  const where: Record<string, unknown> = { workspaceId }
  if (stageFilter) where.buyingStage = stageFilter
  if (outcomeFilter) where.outcomeStage = outcomeFilter
  if (search) where.companyName = { contains: search, mode: 'insensitive' }

  let prospects = await prisma.prospect.findMany({
    where,
    include: { signals: true, recommendations: { orderBy: { priority: 'desc' }, take: 1 } },
    orderBy: { opportunityScore: 'desc' },
    skip,
    take: limit + 1
  })

  if (tierFilter) {
    prospects = prospects.filter(p => getOpportunityTier(p.opportunityScore) === tierFilter.toUpperCase())
  }

  const hasMore = prospects.length > limit
  if (hasMore) prospects.pop()

  const total = await prisma.prospect.count({ where })

  res.json({
    prospects: prospects.map(p => ({
      ...p,
      tier: getOpportunityTier(p.opportunityScore),
      topRecommendation: p.recommendations[0] ?? null,
      signalCount: p.signals.length
    })),
    page,
    limit,
    total,
    hasMore
  })
}))

// GET /api/prospects/:id
prospectsRouter.get('/:id', asyncHandler(async (req, res) => {
  const prospectId = req.params.id as string
  const prospect = await prisma.prospect.findUnique({
    where: { id: prospectId },
    include: {
      signals: { orderBy: { detectedAt: 'desc' } },
      recommendations: { orderBy: { priority: 'desc' } },
      outcomes: { orderBy: { recordedAt: 'desc' } }
    }
  })
  if (!prospect) throw new ApiError(404, 'Prospect not found')

  const userId = (req as AuthedRequest).user.id
  if (!await userHasWorkspaceAccess(userId, prospect.workspaceId)) throw new ApiError(403, 'Access denied')

  res.json({ ...prospect, tier: getOpportunityTier(prospect.opportunityScore) })
}))

// POST /api/prospects
prospectsRouter.post('/', asyncHandler(async (req, res) => {
  const workspaceId = req.body.workspaceId as string
  if (!workspaceId) throw new ApiError(400, 'workspaceId required')
  if (!req.body.companyName) throw new ApiError(400, 'companyName required')

  const userId = (req as AuthedRequest).user.id
  if (!await userHasWorkspaceAccess(userId, workspaceId)) throw new ApiError(403, 'Access denied')

  const prospect = await prisma.prospect.create({
    data: {
      workspaceId,
      companyName: req.body.companyName,
      domain: req.body.domain ?? null,
      industry: req.body.industry ?? null,
      employeeCount: req.body.employeeCount ? Number(req.body.employeeCount) : null,
      estimatedRevenue: req.body.estimatedRevenue ? Number(req.body.estimatedRevenue) : null,
      location: req.body.location ?? null,
      description: req.body.description ?? null,
      contactName: req.body.contactName ?? null,
      contactEmail: req.body.contactEmail ?? null,
      contactPhone: req.body.contactPhone ?? null,
      contactTitle: req.body.contactTitle ?? null,
      linkedinUrl: req.body.linkedinUrl ?? null,
      expectedDealValue: req.body.expectedDealValue ? Number(req.body.expectedDealValue) : null,
      sourceTag: req.body.sourceTag ?? null,
    }
  })

  const icp = await getICP(workspaceId)
  const scores = calculateOpportunityScores([], {
    industry: prospect.industry,
    employeeCount: prospect.employeeCount,
    contactEmail: prospect.contactEmail,
    contactName: prospect.contactName,
    domain: prospect.domain
  }, icp)

  const updated = await prisma.prospect.update({ where: { id: prospect.id }, data: { ...scores } })
  res.status(201).json({ ...updated, tier: getOpportunityTier(updated.opportunityScore) })
}))

// PATCH /api/prospects/:id
prospectsRouter.patch('/:id', asyncHandler(async (req, res) => {
  const prospectId = req.params.id as string
  const existing = await prisma.prospect.findUnique({ where: { id: prospectId } })
  if (!existing) throw new ApiError(404, 'Prospect not found')

  const userId = (req as AuthedRequest).user.id
  if (!await userHasWorkspaceAccess(userId, existing.workspaceId)) throw new ApiError(403, 'Access denied')

  const allowed = ['companyName','domain','industry','employeeCount','estimatedRevenue',
    'location','description','contactName','contactEmail','contactPhone','contactTitle',
    'linkedinUrl','outcomeStage','buyingStage','expectedDealValue','notes','aiSummary']

  const data: Record<string, unknown> = {}
  for (const key of allowed) {
    if (req.body[key] !== undefined) data[key] = req.body[key]
  }
  if (req.body.lastContactedAt) data.lastContactedAt = new Date(req.body.lastContactedAt)

  const updated = await prisma.prospect.update({ where: { id: prospectId }, data })
  res.json({ ...updated, tier: getOpportunityTier(updated.opportunityScore) })
}))

// DELETE /api/prospects/:id
prospectsRouter.delete('/:id', asyncHandler(async (req, res) => {
  const prospectId = req.params.id as string
  const existing = await prisma.prospect.findUnique({ where: { id: prospectId } })
  if (!existing) throw new ApiError(404, 'Prospect not found')

  const userId = (req as AuthedRequest).user.id
  if (!await userHasWorkspaceAccess(userId, existing.workspaceId)) throw new ApiError(403, 'Access denied')

  await prisma.prospect.delete({ where: { id: prospectId } })
  res.json({ ok: true })
}))

// POST /api/prospects/:id/rescore — recalculate scores from current signals
prospectsRouter.post('/:id/rescore', asyncHandler(async (req, res) => {
  const prospectId = req.params.id as string
  const prospect = await prisma.prospect.findUnique({ where: { id: prospectId } })
  if (!prospect) throw new ApiError(404, 'Prospect not found')

  const userId = (req as AuthedRequest).user.id
  if (!await userHasWorkspaceAccess(userId, prospect.workspaceId)) throw new ApiError(403, 'Access denied')

  const [signals, icp] = await Promise.all([
    prisma.signal.findMany({ where: { prospectId }, orderBy: { detectedAt: 'desc' } }),
    getICP(prospect.workspaceId)
  ])

  const rawSignals = signals.map(toRawSignal)
  const scores = calculateOpportunityScores(rawSignals, {
    industry: prospect.industry,
    employeeCount: prospect.employeeCount,
    contactEmail: prospect.contactEmail,
    contactName: prospect.contactName,
    domain: prospect.domain
  }, icp)
  const buyingStage = detectBuyingStage(rawSignals, scores.opportunityScore)
  const winProbability = calcWinProbability(buyingStage, scores.opportunityScore)

  const updated = await prisma.prospect.update({
    where: { id: prospectId },
    data: { ...scores, buyingStage, winProbability }
  })
  res.json({ ...updated, tier: getOpportunityTier(updated.opportunityScore) })
}))

// POST /api/prospects/:id/outcome — record outcome stage change
prospectsRouter.post('/:id/outcome', asyncHandler(async (req, res) => {
  const prospectId = req.params.id as string
  const prospect = await prisma.prospect.findUnique({ where: { id: prospectId } })
  if (!prospect) throw new ApiError(404, 'Prospect not found')

  const userId = (req as AuthedRequest).user.id
  if (!await userHasWorkspaceAccess(userId, prospect.workspaceId)) throw new ApiError(403, 'Access denied')

  if (!req.body.stage) throw new ApiError(400, 'stage required')

  const outcome = await prisma.prospectOutcome.create({
    data: {
      workspaceId: prospect.workspaceId,
      prospectId: prospect.id,
      stage: req.body.stage,
      notes: req.body.notes ?? null,
      dealValue: req.body.dealValue ? Number(req.body.dealValue) : null,
    }
  })

  const updated = await prisma.prospect.update({
    where: { id: prospect.id },
    data: {
      outcomeStage: req.body.stage,
      lastContactedAt: ['CONTACTED','MEETING','PROPOSAL','WON','LOST'].includes(req.body.stage)
        ? new Date() : undefined
    }
  })

  res.json({ outcome, prospect: { ...updated, tier: getOpportunityTier(updated.opportunityScore) } })
}))

// POST /api/prospects/:id/recommend — generate rule-based recommendation
prospectsRouter.post('/:id/recommend', asyncHandler(async (req, res) => {
  const prospectId = req.params.id as string
  const prospect = await prisma.prospect.findUnique({ where: { id: prospectId } })
  if (!prospect) throw new ApiError(404, 'Prospect not found')

  const userId = (req as AuthedRequest).user.id
  if (!await userHasWorkspaceAccess(userId, prospect.workspaceId)) throw new ApiError(403, 'Access denied')

  const signals = await prisma.signal.findMany({ where: { prospectId }, orderBy: { detectedAt: 'desc' } })
  const rawSignals = signals.map(toRawSignal)
  const rec = generateRuleBasedRecommendation(
    {
      industry: prospect.industry,
      employeeCount: prospect.employeeCount,
      contactEmail: prospect.contactEmail,
      contactName: prospect.contactName,
      contactPhone: prospect.contactPhone,
      linkedinUrl: prospect.linkedinUrl,
      domain: prospect.domain
    },
    rawSignals
  )

  const recommendation = await prisma.recommendation.create({
    data: {
      workspaceId: prospect.workspaceId,
      prospectId: prospect.id,
      ...rec,
      expiresAt: new Date(Date.now() + 7 * 86_400_000)
    }
  })

  res.status(201).json(recommendation)
}))

// POST /api/prospects/:id/enrich — Apollo.io company enrichment → auto-generate signals
prospectsRouter.post('/:id/enrich', asyncHandler(async (req, res) => {
  const prospectId = req.params.id as string
  const prospect = await prisma.prospect.findUnique({ where: { id: prospectId } })
  if (!prospect) throw new ApiError(404, 'Prospect not found')

  const userId = (req as AuthedRequest).user.id
  if (!await userHasWorkspaceAccess(userId, prospect.workspaceId)) throw new ApiError(403, 'Access denied')

  const { enrichProspect } = await import('../services/apollo.js')
  const result = await enrichProspect(prospect)

  // Persist any new signals
  const created: string[] = []
  for (const sig of result.signals) {
    const s = await prisma.signal.create({
      data: {
        workspaceId: prospect.workspaceId,
        prospectId: prospect.id,
        type: sig.type as import('@prisma/client').SignalType,
        strength: sig.strength,
        sourceReliability: sig.sourceReliability,
        industryRelevance: sig.industryRelevance,
        title: sig.title,
        description: sig.description,
        source: sig.source,
        detectedAt: sig.detectedAt,
      }
    })
    created.push(s.id)
  }

  // Update contact / company fields if Apollo returned better data
  if (Object.keys(result.updates).length > 0) {
    await prisma.prospect.update({ where: { id: prospectId }, data: result.updates })
  }

  // Rescore with new signals
  const [allSignals, icp] = await Promise.all([
    prisma.signal.findMany({ where: { prospectId } }),
    getICP(prospect.workspaceId)
  ])
  const rawSignals = allSignals.map(toRawSignal)
  const u = result.updates
  const scores = calculateOpportunityScores(rawSignals, {
    industry: (u.industry as string | null | undefined) ?? prospect.industry,
    employeeCount: (u.employeeCount as number | null | undefined) ?? prospect.employeeCount,
    contactEmail: (u.contactEmail as string | null | undefined) ?? prospect.contactEmail,
    contactName: (u.contactName as string | null | undefined) ?? prospect.contactName,
    domain: (u.domain as string | null | undefined) ?? prospect.domain
  }, icp)
  const buyingStage = detectBuyingStage(rawSignals, scores.opportunityScore)
  const winProbability = calcWinProbability(buyingStage, scores.opportunityScore)

  const updated = await prisma.prospect.update({
    where: { id: prospectId },
    data: { ...scores, buyingStage, winProbability }
  })

  res.json({
    prospect: { ...updated, tier: getOpportunityTier(updated.opportunityScore) },
    signalsCreated: created.length,
    signalIds: created
  })
}))
