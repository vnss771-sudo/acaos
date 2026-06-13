import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { asyncHandler, ApiError } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import { getOpportunityTier, calcWinProbability } from '../lib/signalEngine.js'
import type { BuyingStage } from '../lib/signalEngine.js'
import { userBelongsToWorkspace } from '../lib/workspaces.js'
import { centsToDollars } from '../lib/money.js'
import type { AuthedRequest } from '../types/auth.js'

export const intelligenceRouter = Router()
intelligenceRouter.use(requireAuth)

// Resolve the requested workspace and confirm the caller is a member.
async function requireWorkspace(req: import('express').Request): Promise<string> {
  const workspaceId = req.query.workspaceId as string
  if (!workspaceId) throw new ApiError(400, 'workspaceId required')
  const user = (req as AuthedRequest).user
  if (!(await userBelongsToWorkspace(user.id, workspaceId))) {
    throw new ApiError(403, 'Workspace access denied')
  }
  return workspaceId
}

// GET /api/intelligence/opportunities?workspaceId=
// Returns hot/warm/cold prospects with recommendations
intelligenceRouter.get('/opportunities', asyncHandler(async (req, res) => {
  const workspaceId = await requireWorkspace(req)

  const prospects = await prisma.prospect.findMany({
    where: { workspaceId, outcomeStage: { notIn: ['WON', 'LOST'] } },
    include: {
      signals: { orderBy: { detectedAt: 'desc' }, take: 5 },
      recommendations: { orderBy: { priority: 'desc' }, take: 1 }
    },
    orderBy: { opportunityScore: 'desc' },
    take: 200
  })

  const hot = prospects.filter(p => p.opportunityScore >= 72)
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
    tier: getOpportunityTier(p.opportunityScore),
    buyingStage: p.buyingStage,
    outcomeStage: p.outcomeStage,
    contactName: p.contactName,
    contactEmail: p.contactEmail,
    contactTitle: p.contactTitle,
    expectedDealValue: centsToDollars(p.expectedDealValue),
    winProbability: p.winProbability,
    lastSignalAt: p.lastSignalAt,
    latestSignal: p.signals[0] ?? null,
    signals: p.signals,
    signalCount: p.signals.length,
    topRecommendation: p.recommendations[0] ?? null,
  })

  res.json({
    hot: hot.map(toSummary),
    warm: warm.map(toSummary),
    cold: cold.map(toSummary),
    totals: { hot: hot.length, warm: warm.length, cold: cold.length, total: prospects.length }
  })
}))

// GET /api/intelligence/forecast?workspaceId=
// Revenue prediction engine
intelligenceRouter.get('/forecast', asyncHandler(async (req, res) => {
  const workspaceId = await requireWorkspace(req)

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

  // Default deal value by rough industry category
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
    // expectedDealValue is stored in cents; forecast math works in whole units.
    const dealValue = centsToDollars(p.expectedDealValue) ?? defaultDealValue(p.industry)
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
  const weightedForecast = pipeline.reduce((s, p) => s + p.expectedRevenue, 0)
  const wonRevenue = won.reduce((s, o) => s + (centsToDollars(o.dealValue) ?? 0), 0)
  const wonCount = won.length

  // Stage breakdown
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
// Signal and scoring statistics
intelligenceRouter.get('/stats', asyncHandler(async (req, res) => {
  const workspaceId = await requireWorkspace(req)

  // Tier counts are computed with bounded SQL range counts rather than loading
  // every prospect into memory and bucketing in JS (which grows unbounded).
  const [totalProspects, signalCounts, stageDist, hot, warm, cold] = await Promise.all([
    prisma.prospect.count({ where: { workspaceId } }),
    prisma.signal.groupBy({ by: ['type'], where: { workspaceId }, _count: true }),
    prisma.prospect.groupBy({ by: ['buyingStage'], where: { workspaceId }, _count: true }),
    prisma.prospect.count({ where: { workspaceId, opportunityScore: { gte: 72 } } }),
    prisma.prospect.count({ where: { workspaceId, opportunityScore: { gte: 45, lt: 72 } } }),
    prisma.prospect.count({ where: { workspaceId, opportunityScore: { lt: 45 } } }),
  ])

  res.json({
    totalProspects,
    tierDistribution: { HOT: hot, WARM: warm, COLD: cold },
    signalBreakdown: Object.fromEntries(signalCounts.map(r => [r.type, r._count])),
    stageDistribution: Object.fromEntries(stageDist.map(r => [r.buyingStage, r._count]))
  })
}))
