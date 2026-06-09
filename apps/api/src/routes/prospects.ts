import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { asyncHandler, ApiError } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import {
  calculateOpportunityScores,
  detectBuyingStage,
  calcWinProbability,
  generateRuleBasedRecommendation,
  getOpportunityTier,
  predictBuyingIntent,
  toRawSignal,
} from '../lib/signalEngine.js'
import { userHasWorkspaceAccess } from '../lib/workspaces.js'
import { enqueueScoreProspects } from '../lib/queues.js'
import type { AuthedRequest } from '../types/auth.js'

export const prospectsRouter = Router()
prospectsRouter.use(requireAuth)

async function getICP(workspaceId: string) {
  const icp = await prisma.workspaceICP.findUnique({ where: { workspaceId } })
  if (!icp) return undefined
  return {
    targetIndustries: icp.targetIndustries,
    minEmployees:     icp.minEmployees  ?? undefined,
    maxEmployees:     icp.maxEmployees  ?? undefined,
    targetGeos:       icp.targetGeos,
    mustHaveEmail:    icp.mustHaveEmail,
  }
}

// GET /api/prospects?workspaceId=&tier=&stage=&page=&limit=
prospectsRouter.get('/', asyncHandler(async (req, res) => {
  const workspaceId = req.query.workspaceId as string
  if (!workspaceId) throw new ApiError(400, 'workspaceId required')

  const userId = (req as AuthedRequest).user.id
  if (!await userHasWorkspaceAccess(userId, workspaceId)) throw new ApiError(403, 'Access denied')

  const page  = Math.max(1, parseInt(req.query.page  as string) || 1)
  const limit = Math.min(100, parseInt(req.query.limit as string) || 25)
  const skip  = (page - 1) * limit

  const tierFilter    = req.query.tier    as string | undefined
  const stageFilter   = req.query.stage   as string | undefined
  const outcomeFilter = req.query.outcome as string | undefined
  const search        = req.query.search  as string | undefined

  const where: Record<string, unknown> = { workspaceId }
  if (stageFilter)   where.buyingStage  = stageFilter
  if (outcomeFilter) where.outcomeStage = outcomeFilter
  if (search) where.companyName = { contains: search, mode: 'insensitive' }

  // Tier filter maps to score range — keeps pagination accurate
  if (tierFilter) {
    const tier = tierFilter.toUpperCase()
    if (tier === 'HOT')  where.opportunityScore = { gte: 72 }
    else if (tier === 'WARM') where.opportunityScore = { gte: 45, lt: 72 }
    else if (tier === 'COLD') where.opportunityScore = { lt: 45 }
  }

  const [prospects, total] = await Promise.all([
    prisma.prospect.findMany({
      where,
      select: {
        id: true, workspaceId: true, companyName: true, domain: true,
        industry: true, employeeCount: true, location: true,
        contactName: true, contactEmail: true, contactPhone: true, contactTitle: true,
        linkedinUrl: true, opportunityScore: true, intentScore: true, fitScore: true,
        timingScore: true, confidenceScore: true, similarityScore: true, channelScore: true,
        buyingStage: true, outcomeStage: true, expectedDealValue: true,
        winProbability: true, lastSignalAt: true, lastContactedAt: true,
        sourceTag: true, createdAt: true, updatedAt: true,
        _count: { select: { signals: true } },
        recommendations: { orderBy: { priority: 'desc' }, take: 1 },
      },
      orderBy: { opportunityScore: 'desc' },
      skip,
      take: limit + 1,
    }),
    prisma.prospect.count({ where }),
  ])

  const hasMore = prospects.length > limit
  if (hasMore) prospects.pop()

  res.json({
    prospects: prospects.map((p: (typeof prospects)[0]) => ({
      ...p,
      signalCount:       p._count.signals,
      tier:              getOpportunityTier(p.opportunityScore),
      topRecommendation: p.recommendations[0] ?? null,
    })),
    page,
    limit,
    total,
    hasMore,
  })
}))

// GET /api/prospects/:id
prospectsRouter.get('/:id', asyncHandler(async (req, res) => {
  const prospect = await prisma.prospect.findUnique({
    where: { id: req.params.id },
    include: {
      signals:         { orderBy: { detectedAt: 'desc' } },
      recommendations: { orderBy: { priority: 'desc' } },
      outcomes:        { orderBy: { recordedAt: 'desc' } },
    },
  })
  if (!prospect) throw new ApiError(404, 'Prospect not found')

  const userId = (req as AuthedRequest).user.id
  if (!await userHasWorkspaceAccess(userId, prospect.workspaceId)) throw new ApiError(403, 'Access denied')

  const rawSignals = prospect.signals.map(toRawSignal)
  const prediction = predictBuyingIntent(rawSignals, prospect.buyingStage, prospect.opportunityScore)

  res.json({ ...prospect, tier: getOpportunityTier(prospect.opportunityScore), prediction })
}))

// POST /api/prospects
prospectsRouter.post('/', asyncHandler(async (req, res) => {
  const workspaceId = req.body.workspaceId as string
  if (!workspaceId)         throw new ApiError(400, 'workspaceId required')
  if (!req.body.companyName) throw new ApiError(400, 'companyName required')

  const userId = (req as AuthedRequest).user.id
  if (!await userHasWorkspaceAccess(userId, workspaceId)) throw new ApiError(403, 'Access denied')

  const meta = {
    industry:      req.body.industry      ?? null,
    employeeCount: req.body.employeeCount ? Number(req.body.employeeCount) : null,
    contactEmail:  req.body.contactEmail  ?? null,
    contactName:   req.body.contactName   ?? null,
    domain:        req.body.domain        ?? null,
    location:      req.body.location      ?? null,
  }

  const icp    = await getICP(workspaceId)
  const scores = calculateOpportunityScores([], meta, icp)

  // Scores are computed before create — single atomic write, no orphan risk
  const updated = await prisma.prospect.create({
    data: {
      workspaceId,
      companyName:       req.body.companyName,
      domain:            meta.domain,
      industry:          meta.industry,
      employeeCount:     meta.employeeCount,
      estimatedRevenue:  req.body.estimatedRevenue ? Number(req.body.estimatedRevenue) : null,
      location:          meta.location,
      description:       req.body.description   ?? null,
      notes:             req.body.notes          ?? null,
      aiSummary:         req.body.aiSummary      ?? null,
      contactName:       meta.contactName,
      contactEmail:      meta.contactEmail,
      contactPhone:      req.body.contactPhone   ?? null,
      contactTitle:      req.body.contactTitle   ?? null,
      linkedinUrl:       req.body.linkedinUrl    ?? null,
      expectedDealValue: req.body.expectedDealValue ? Number(req.body.expectedDealValue) : null,
      sourceTag:         req.body.sourceTag      ?? null,
      ...scores,
    },
  })

  res.status(201).json({ ...updated, tier: getOpportunityTier(updated.opportunityScore) })
}))

// PATCH /api/prospects/:id
prospectsRouter.patch('/:id', asyncHandler(async (req, res) => {
  const existing = await prisma.prospect.findUnique({ where: { id: req.params.id } })
  if (!existing) throw new ApiError(404, 'Prospect not found')

  const userId = (req as AuthedRequest).user.id
  if (!await userHasWorkspaceAccess(userId, existing.workspaceId)) throw new ApiError(403, 'Access denied')

  const allowed = [
    'companyName', 'domain', 'industry', 'employeeCount', 'estimatedRevenue',
    'location', 'description', 'notes', 'aiSummary',
    'contactName', 'contactEmail', 'contactPhone', 'contactTitle',
    'linkedinUrl', 'outcomeStage', 'buyingStage', 'expectedDealValue', 'sourceTag',
  ]

  const data: Record<string, unknown> = {}
  for (const key of allowed) {
    if (req.body[key] !== undefined) data[key] = req.body[key]
  }
  if (req.body.lastContactedAt) data.lastContactedAt = new Date(req.body.lastContactedAt)

  const updated = await prisma.prospect.update({ where: { id: req.params.id }, data })
  res.json({ ...updated, tier: getOpportunityTier(updated.opportunityScore) })
}))

// DELETE /api/prospects/:id
prospectsRouter.delete('/:id', asyncHandler(async (req, res) => {
  const existing = await prisma.prospect.findUnique({ where: { id: req.params.id } })
  if (!existing) throw new ApiError(404, 'Prospect not found')

  const userId = (req as AuthedRequest).user.id
  if (!await userHasWorkspaceAccess(userId, existing.workspaceId)) throw new ApiError(403, 'Access denied')

  await prisma.prospect.delete({ where: { id: req.params.id } })
  res.json({ ok: true })
}))

// POST /api/prospects/:id/rescore
prospectsRouter.post('/:id/rescore', asyncHandler(async (req, res) => {
  const prospect = await prisma.prospect.findUnique({
    where: { id: req.params.id },
    include: { signals: true },
  })
  if (!prospect) throw new ApiError(404, 'Prospect not found')

  const userId = (req as AuthedRequest).user.id
  if (!await userHasWorkspaceAccess(userId, prospect.workspaceId)) throw new ApiError(403, 'Access denied')

  const rawSignals = prospect.signals.map(toRawSignal)
  const icp        = await getICP(prospect.workspaceId)
  const scores     = calculateOpportunityScores(rawSignals, {
    industry:      prospect.industry,
    employeeCount: prospect.employeeCount,
    contactEmail:  prospect.contactEmail,
    contactName:   prospect.contactName,
    domain:        prospect.domain,
    location:      prospect.location,
  }, icp)
  const buyingStage    = detectBuyingStage(rawSignals, scores.opportunityScore)
  const winProbability = calcWinProbability(buyingStage, scores.opportunityScore)

  const updated = await prisma.prospect.update({
    where: { id: req.params.id },
    data: { ...scores, buyingStage, winProbability },
  })
  res.json({ ...updated, tier: getOpportunityTier(updated.opportunityScore) })
}))

// POST /api/prospects/:id/outcome
prospectsRouter.post('/:id/outcome', asyncHandler(async (req, res) => {
  const prospect = await prisma.prospect.findUnique({ where: { id: req.params.id } })
  if (!prospect) throw new ApiError(404, 'Prospect not found')
  if (!req.body.stage) throw new ApiError(400, 'stage required')

  const userId = (req as AuthedRequest).user.id
  if (!await userHasWorkspaceAccess(userId, prospect.workspaceId)) throw new ApiError(403, 'Access denied')

  const [outcome, updated] = await prisma.$transaction([
    prisma.prospectOutcome.create({
      data: {
        workspaceId: prospect.workspaceId,
        prospectId:  prospect.id,
        stage:       req.body.stage,
        notes:       req.body.notes     ?? null,
        dealValue:   req.body.dealValue ? Number(req.body.dealValue) : null,
      },
    }),
    prisma.prospect.update({
      where: { id: prospect.id },
      data: {
        outcomeStage:   req.body.stage,
        lastContactedAt: ['CONTACTED','MEETING','PROPOSAL','WON','LOST'].includes(req.body.stage)
          ? new Date() : undefined,
      },
    }),
  ])

  // Trigger background recalibration on WON/LOST outcomes
  if (['WON', 'LOST'].includes(req.body.stage)) {
    enqueueScoreProspects(prospect.workspaceId).catch(() => {})
  }

  res.json({ outcome, prospect: { ...updated, tier: getOpportunityTier(updated.opportunityScore) } })
}))

// POST /api/prospects/:id/recommend
prospectsRouter.post('/:id/recommend', asyncHandler(async (req, res) => {
  const prospect = await prisma.prospect.findUnique({
    where: { id: req.params.id },
    include: { signals: true },
  })
  if (!prospect) throw new ApiError(404, 'Prospect not found')

  const userId = (req as AuthedRequest).user.id
  if (!await userHasWorkspaceAccess(userId, prospect.workspaceId)) throw new ApiError(403, 'Access denied')

  const rawSignals = prospect.signals.map(toRawSignal)
  const rec = generateRuleBasedRecommendation(
    {
      industry:      prospect.industry,
      employeeCount: prospect.employeeCount,
      contactEmail:  prospect.contactEmail,
      contactName:   prospect.contactName,
      contactPhone:  prospect.contactPhone,
      linkedinUrl:   prospect.linkedinUrl,
      domain:        prospect.domain,
      location:      prospect.location,
    },
    rawSignals
  )

  const recommendation = await prisma.recommendation.create({
    data: {
      workspaceId: prospect.workspaceId,
      prospectId:  prospect.id,
      ...rec,
      expiresAt: new Date(Date.now() + 7 * 86_400_000),
    },
  })

  res.status(201).json(recommendation)
}))
