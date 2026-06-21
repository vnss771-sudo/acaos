import { Router } from 'express'
import { requireAuth, requireVerifiedForMutation } from '../middleware/auth.js'
import { asyncHandler, ApiError } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import { getOpportunityTier, calcWinProbability } from '../lib/signalEngine.js'
import type { BuyingStage, OutcomeStage } from '../lib/signalEngine.js'
import { userBelongsToWorkspace } from '../lib/workspaces.js'
import { centsToDollars } from '../lib/money.js'
import { parseQuery, workspaceIdField } from '../lib/validate.js'
import { z } from 'zod'

// Shared query schema for the workspace-scoped GET endpoints — mirrors the prior
// `req.query.workspaceId as string` + `if (!workspaceId) 400`.
const workspaceQuerySchema = z.object({ workspaceId: workspaceIdField })

export const intelligenceRouter = Router()
intelligenceRouter.use(requireAuth)
intelligenceRouter.use(requireVerifiedForMutation)

// Resolve the requested workspace and confirm the caller is a member.
async function requireWorkspace(req: import('express').Request): Promise<string> {
  const { workspaceId } = parseQuery(workspaceQuerySchema, req)
  const user = req.user!
  if (!(await userBelongsToWorkspace(user.id, workspaceId))) {
    throw new ApiError(403, 'Workspace access denied')
  }
  return workspaceId
}

type OpportunityProspectRow = {
  id: string
  companyName: string
  industry: string | null
  location: string | null
  opportunityScore: number
  intentScore: number
  fitScore: number
  timingScore: number
  confidenceScore: number
  buyingStage: BuyingStage
  outcomeStage: OutcomeStage
  contactName: string | null
  contactEmail: string | null
  contactTitle: string | null
  expectedDealValue: number | null
  winProbability: number | null
  lastSignalAt: Date | null
  signals: unknown[]
  recommendations: unknown[]
  isExample: boolean
}

type ForecastProspectRow = {
  id: string
  companyName: string
  buyingStage: BuyingStage
  outcomeStage: OutcomeStage
  opportunityScore: number
  expectedDealValue: number | null
  winProbability: number | null
  industry: string | null
}

type SignalCountRow = { type: string; _count: number }
type StageCountRow = { buyingStage: string; _count: number }

// GET /api/intelligence/opportunities?workspaceId=
// Returns hot/warm/cold prospects with recommendations
intelligenceRouter.get('/opportunities', asyncHandler(async (req, res) => {
  const workspaceId = await requireWorkspace(req)

  // Auto-hide example prospects once any real prospect exists
  const realCount = await prisma.prospect.count({ where: { workspaceId, isExample: false } })
  const prospectsWhere = {
    workspaceId,
    outcomeStage: { notIn: ['WON', 'LOST'] as OutcomeStage[] },
    ...(realCount > 0 ? { isExample: false } : {})
  }

  const prospects = await prisma.prospect.findMany({
    where: prospectsWhere,
    include: {
      signals: { orderBy: { detectedAt: 'desc' }, take: 5 },
      recommendations: { orderBy: { priority: 'desc' }, take: 1 }
    },
    orderBy: { opportunityScore: 'desc' },
    take: 200
  }) as OpportunityProspectRow[]

  const hot = prospects.filter((p: OpportunityProspectRow) => p.opportunityScore >= 72)
  const warm = prospects.filter((p: OpportunityProspectRow) => p.opportunityScore >= 45 && p.opportunityScore < 72)
  const cold = prospects.filter((p: OpportunityProspectRow) => p.opportunityScore < 45)

  const toSummary = (p: OpportunityProspectRow) => ({
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
    isExample: p.isExample,
  })

  res.json({
    hot: hot.map(toSummary),
    warm: warm.map(toSummary),
    cold: cold.map(toSummary),
    totals: { hot: hot.length, warm: warm.length, cold: cold.length, total: prospects.length },
    hasRealProspects: realCount > 0,
  })
}))

// GET /api/intelligence/forecast?workspaceId=
// Revenue prediction engine
intelligenceRouter.get('/forecast', asyncHandler(async (req, res) => {
  const workspaceId = await requireWorkspace(req)

  const realCount = await prisma.prospect.count({ where: { workspaceId, isExample: false } })
  const exampleFilter = realCount > 0 ? { isExample: false } : {}

  const prospects = await prisma.prospect.findMany({
    where: { workspaceId, outcomeStage: { notIn: ['WON', 'LOST'] }, ...exampleFilter },
    select: {
      id: true, companyName: true, buyingStage: true, outcomeStage: true,
      opportunityScore: true, expectedDealValue: true, winProbability: true,
      industry: true
    }
  }) as ForecastProspectRow[]

  // Aggregate won revenue/count in SQL rather than loading every won-outcome row
  // into memory just to sum it. (dealValue is stored in cents.)
  const wonAgg = await prisma.prospectOutcome.aggregate({
    // Exclude outcomes recorded against example prospects once real data exists,
    // so won revenue/count isn't inflated by demo records.
    where: { workspaceId, stage: 'WON', ...(realCount > 0 ? { prospect: { isExample: false } } : {}) },
    _sum: { dealValue: true },
    _count: true,
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

  const pipeline = prospects.map((p: ForecastProspectRow) => {
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

  const totalPipelineValue = pipeline.reduce((s: number, p: { dealValue: number }) => s + p.dealValue, 0)
  const weightedForecast = pipeline.reduce((s: number, p: { expectedRevenue: number }) => s + p.expectedRevenue, 0)
  const wonRevenue = centsToDollars(wonAgg._sum.dealValue) ?? 0
  const wonCount = wonAgg._count

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
        ? Math.round(pipeline.reduce((s: number, p: { winProbability: number }) => s + p.winProbability, 0) / pipeline.length)
        : 0
    },
    stageBreakdown,
    pipeline: pipeline.sort((a: { expectedRevenue: number }, b: { expectedRevenue: number }) => b.expectedRevenue - a.expectedRevenue).slice(0, 50)
  })
}))

// GET /api/intelligence/stats?workspaceId=
// Signal and scoring statistics
intelligenceRouter.get('/stats', asyncHandler(async (req, res) => {
  const workspaceId = await requireWorkspace(req)

  const realCount = await prisma.prospect.count({ where: { workspaceId, isExample: false } })
  const exampleFilter = realCount > 0 ? { isExample: false } : {}

  // Tier counts are computed with bounded SQL range counts rather than loading
  // every prospect into memory and bucketing in JS (which grows unbounded).
  const [totalProspects, rawSignalCounts, rawStageDist, hot, warm, cold] = await Promise.all([
    prisma.prospect.count({ where: { workspaceId, ...exampleFilter } }),
    // Signals have no isExample column; filter through the prospect relation so
    // the breakdown stays consistent with the example-filtered prospect counts.
    prisma.signal.groupBy({ by: ['type'], where: { workspaceId, ...(realCount > 0 ? { prospect: { isExample: false } } : {}) }, _count: true }),
    prisma.prospect.groupBy({ by: ['buyingStage'], where: { workspaceId, ...exampleFilter }, _count: true }),
    prisma.prospect.count({ where: { workspaceId, opportunityScore: { gte: 72 }, ...exampleFilter } }),
    prisma.prospect.count({ where: { workspaceId, opportunityScore: { gte: 45, lt: 72 }, ...exampleFilter } }),
    prisma.prospect.count({ where: { workspaceId, opportunityScore: { lt: 45 }, ...exampleFilter } }),
  ])
  const signalCounts = rawSignalCounts as SignalCountRow[]
  const stageDist = rawStageDist as StageCountRow[]

  res.json({
    totalProspects,
    tierDistribution: { HOT: hot, WARM: warm, COLD: cold },
    signalBreakdown: Object.fromEntries(signalCounts.map((r: SignalCountRow) => [r.type, r._count])),
    stageDistribution: Object.fromEntries(stageDist.map((r: StageCountRow) => [r.buyingStage, r._count]))
  })
}))
