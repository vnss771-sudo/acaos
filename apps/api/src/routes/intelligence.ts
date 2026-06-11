import { Router } from 'express'
import type { Request } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { asyncHandler, ApiError } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import { getOpportunityTier, calcWinProbability } from '../lib/signalEngine.js'
import type { BuyingStage } from '../lib/signalEngine.js'

type AuthedRequest = Request & { user?: { id: string; email: string; name: string | null } }

async function assertMembership(userId: string, workspaceId: string): Promise<void> {
  const membership = await prisma.membership.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } }
  })
  if (!membership) throw new ApiError(403, 'Not a member of this workspace')
}

export const intelligenceRouter = Router()
intelligenceRouter.use(requireAuth)

// GET /api/intelligence/opportunities?workspaceId=
intelligenceRouter.get('/opportunities', asyncHandler(async (req, res) => {
  const workspaceId = req.query.workspaceId as string
  if (!workspaceId) throw new ApiError(400, 'workspaceId required')

  const prospects = await prisma.prospect.findMany({
    where: { workspaceId, outcomeStage: { notIn: ['WON', 'LOST'] } },
    include: {
      signals: { orderBy: { detectedAt: 'desc' }, take: 5 },
      recommendations: { orderBy: { priority: 'desc' }, take: 1 },
      // Accurate POA check independent of the take:5 signal window
      _count: { select: { signals: { where: { type: 'PROBLEM_OWNER_ACTIVATION' } } } }
    },
    orderBy: { opportunityScore: 'desc' },
    take: 200
  })

  const hot  = prospects.filter(p => p.opportunityScore >= 72)
  const warm = prospects.filter(p => p.opportunityScore >= 45 && p.opportunityScore < 72)
  const cold = prospects.filter(p => p.opportunityScore < 45)

  const toSummary = (p: typeof prospects[0]) => ({
    id: p.id,
    companyName: p.companyName,
    industry: p.industry,
    location: p.location,
    opportunityScore: p.opportunityScore,
    intentScore: p.intentScore,
    fitScore: p.fitScore,
    timingScore: p.timingScore,
    confidenceScore: p.confidenceScore,
    expectedRevenueScore: p.expectedRevenueScore,
    retentionProbability: p.retentionProbability,
    expansionProbability: p.expansionProbability,
    tier: getOpportunityTier(p.opportunityScore),
    buyingStage: p.buyingStage,
    outcomeStage: p.outcomeStage,
    contactName: p.contactName,
    contactEmail: p.contactEmail,
    contactTitle: p.contactTitle,
    expectedDealValue: p.expectedDealValue,
    winProbability: p.winProbability,
    lastSignalAt: p.lastSignalAt,
    latestSignal: p.signals[0] ?? null,
    signalCount: p.signals.length,
    topRecommendation: p.recommendations[0] ?? null,
    isActivated: p._count.signals > 0,
  })

  res.json({
    hot: hot.map(toSummary),
    warm: warm.map(toSummary),
    cold: cold.map(toSummary),
    totals: { hot: hot.length, warm: warm.length, cold: cold.length, total: prospects.length }
  })
}))

// GET /api/intelligence/strategy-cards?workspaceId=&limit=
intelligenceRouter.get('/strategy-cards', asyncHandler(async (req, res) => {
  const workspaceId = req.query.workspaceId as string
  if (!workspaceId) throw new ApiError(400, 'workspaceId required')
  const limit = Math.min(50, parseInt(req.query.limit as string ?? '20') || 20)

  const prospects = await prisma.prospect.findMany({
    where: { workspaceId, outcomeStage: { notIn: ['WON', 'LOST'] } },
    include: {
      recommendations: { orderBy: { createdAt: 'desc' }, take: 1 },
      signals: { where: { type: 'PROBLEM_OWNER_ACTIVATION' }, take: 1 }
    },
    orderBy: { expectedRevenueScore: 'desc' },
    take: limit
  })

  res.json({
    strategyCards: prospects.map(p => ({
      id: p.id,
      companyName: p.companyName,
      industry: p.industry,
      location: p.location,
      expectedRevenueScore: p.expectedRevenueScore,
      opportunityScore: p.opportunityScore,
      winProbability: p.winProbability,
      expectedDealValue: p.expectedDealValue,
      tier: getOpportunityTier(p.opportunityScore),
      buyingStage: p.buyingStage,
      contactName: p.contactName,
      contactEmail: p.contactEmail,
      contactTitle: p.contactTitle,
      recommendation: p.recommendations[0] ?? null,
      isActivated: p.signals.length > 0,
    }))
  })
}))

// GET /api/intelligence/forecast?workspaceId=
intelligenceRouter.get('/forecast', asyncHandler(async (req, res) => {
  const workspaceId = req.query.workspaceId as string
  if (!workspaceId) throw new ApiError(400, 'workspaceId required')

  const prospects = await prisma.prospect.findMany({
    where: { workspaceId, outcomeStage: { notIn: ['WON', 'LOST'] } },
    select: {
      id: true, companyName: true, buyingStage: true, outcomeStage: true,
      opportunityScore: true, expectedDealValue: true, winProbability: true,
      industry: true
    }
  })

  const won = await prisma.prospectOutcome.findMany({
    where: { workspaceId, stage: 'WON' },
    select: { dealValue: true, recordedAt: true }
  })

  function defaultDealValue(industry: string | null): number {
    if (!industry) return 5000
    const lower = industry.toLowerCase()
    if (lower.includes('financ') || lower.includes('insur')) return 20000
    if (lower.includes('construct') || lower.includes('civil')) return 15000
    if (lower.includes('tech') || lower.includes('software')) return 12000
    if (lower.includes('logistics') || lower.includes('transport')) return 10000
    return 5000
  }

  const pipeline = prospects.map(p => {
    const dealValue = p.expectedDealValue ?? defaultDealValue(p.industry)
    const winProb = p.winProbability ?? calcWinProbability(p.buyingStage as BuyingStage, p.opportunityScore)
    const expectedRevenue = dealValue * winProb
    return {
      id: p.id,
      companyName: p.companyName,
      buyingStage: p.buyingStage,
      opportunityScore: p.opportunityScore,
      dealValue,
      winProbability: Math.round(winProb * 100),
      expectedRevenue: Math.round(expectedRevenue),
      tier: getOpportunityTier(p.opportunityScore)
    }
  })

  const totalPipelineValue = pipeline.reduce((s, p) => s + p.dealValue, 0)
  const weightedForecast   = pipeline.reduce((s, p) => s + p.expectedRevenue, 0)
  const wonRevenue         = won.reduce((s, o) => s + (o.dealValue ?? 0), 0)
  const wonCount           = won.length

  const stageBreakdown: Record<string, { count: number; forecast: number }> = {}
  for (const p of pipeline) {
    const stage = p.buyingStage
    if (!stageBreakdown[stage]) stageBreakdown[stage] = { count: 0, forecast: 0 }
    stageBreakdown[stage].count++
    stageBreakdown[stage].forecast += p.expectedRevenue
  }

  res.json({
    summary: {
      totalProspects: pipeline.length,
      totalPipelineValue: Math.round(totalPipelineValue),
      weightedForecast: Math.round(weightedForecast),
      wonRevenue: Math.round(wonRevenue),
      wonCount,
      avgDealValue: pipeline.length > 0 ? Math.round(totalPipelineValue / pipeline.length) : 0,
      avgWinRate: pipeline.length > 0
        ? Math.round(pipeline.reduce((s, p) => s + p.winProbability, 0) / pipeline.length)
        : 0
    },
    stageBreakdown,
    pipeline: pipeline.sort((a, b) => b.expectedRevenue - a.expectedRevenue).slice(0, 50)
  })
}))

// GET /api/intelligence/stats?workspaceId=
intelligenceRouter.get('/stats', asyncHandler(async (req, res) => {
  const workspaceId = req.query.workspaceId as string
  if (!workspaceId) throw new ApiError(400, 'workspaceId required')

  const [totalProspects, signalCounts, stageDist] = await Promise.all([
    prisma.prospect.count({ where: { workspaceId } }),
    prisma.signal.groupBy({ by: ['type'], where: { workspaceId }, _count: true }),
    prisma.prospect.groupBy({ by: ['buyingStage'], where: { workspaceId }, _count: true })
  ])

  const allProspects = await prisma.prospect.findMany({
    where: { workspaceId },
    select: { opportunityScore: true }
  })
  const hot  = allProspects.filter(p => p.opportunityScore >= 72).length
  const warm = allProspects.filter(p => p.opportunityScore >= 45 && p.opportunityScore < 72).length
  const cold = allProspects.filter(p => p.opportunityScore < 45).length

  res.json({
    totalProspects,
    tierDistribution: { HOT: hot, WARM: warm, COLD: cold },
    signalBreakdown: Object.fromEntries(signalCounts.map(r => [r.type, r._count])),
    stageDistribution: Object.fromEntries(stageDist.map(r => [r.buyingStage, r._count]))
  })
}))

// ── Industry Signal Config CRUD ────────────────────────────────────────────────

// GET /api/intelligence/industry-configs?workspaceId=
intelligenceRouter.get('/industry-configs', asyncHandler(async (req, res) => {
  const workspaceId = req.query.workspaceId as string
  if (!workspaceId) throw new ApiError(400, 'workspaceId required')

  const configs = await prisma.industrySignalConfig.findMany({
    where: { workspaceId },
    orderBy: { industry: 'asc' }
  })

  res.json({ configs })
}))

// PUT /api/intelligence/industry-configs/:industry
intelligenceRouter.put('/industry-configs/:industry', asyncHandler(async (req, res) => {
  const { industry } = req.params
  const { workspaceId, signalBoosts, description } = req.body
  if (!workspaceId) throw new ApiError(400, 'workspaceId required')
  if (!signalBoosts || typeof signalBoosts !== 'object') throw new ApiError(400, 'signalBoosts must be an object')

  const userId = (req as AuthedRequest).user?.id
  if (!userId) throw new ApiError(401, 'Unauthorized')
  await assertMembership(userId, workspaceId)

  const config = await prisma.industrySignalConfig.upsert({
    where: { workspaceId_industry: { workspaceId, industry } },
    create: { workspaceId, industry, signalBoosts, description: description ?? null },
    update: { signalBoosts, description: description ?? null }
  })

  res.json({ config })
}))

// DELETE /api/intelligence/industry-configs/:industry
// workspaceId must come from the request body — never from query params (CSRF defence)
intelligenceRouter.delete('/industry-configs/:industry', asyncHandler(async (req, res) => {
  const { industry } = req.params
  const workspaceId = req.body?.workspaceId as string | undefined
  if (!workspaceId) throw new ApiError(400, 'workspaceId required in request body')

  const userId = (req as AuthedRequest).user?.id
  if (!userId) throw new ApiError(401, 'Unauthorized')
  await assertMembership(userId, workspaceId)

  await prisma.industrySignalConfig.delete({
    where: { workspaceId_industry: { workspaceId, industry } }
  })

  res.json({ ok: true })
}))
