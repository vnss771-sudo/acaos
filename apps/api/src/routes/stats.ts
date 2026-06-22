import { Router } from 'express'
import { requireAuth, requireVerifiedForMutation } from '../middleware/auth.js'
import { asyncHandler, ApiError } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import { userBelongsToWorkspace } from '../lib/workspaces.js'
import { getMonthlyUsage } from '../lib/limits.js'
import { getScoreTier } from '../lib/scoring.js'
import { statsCache } from '../lib/statsCache.js'
import { parseQuery, workspaceIdField } from '../lib/validate.js'
import { evaluateSenderReputation } from '@acaos/backend-core/lib/senderReputation.js'
import { reputationGuardMode } from '@acaos/backend-core/lib/launchControls.js'
import { z } from 'zod'

// Shared query schema — mirrors `String(... || '').trim()` + `if (!workspaceId) 400`.
const workspaceQuerySchema = z.object({ workspaceId: workspaceIdField })

export const statsRouter = Router()
statsRouter.use(requireAuth)
statsRouter.use(requireVerifiedForMutation)

const STAGES = ['NEW', 'RESEARCHED', 'OUTREACH_SENT', 'REPLIED', 'BOOKED', 'CLOSED', 'DEAD']

statsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const user = req.user!
    const { workspaceId } = parseQuery(workspaceQuerySchema, req)

    const member = await userBelongsToWorkspace(user.id, workspaceId)
    if (!member) throw new ApiError(403, 'Access denied')

    const payload = await statsCache.get(workspaceId, () => buildStats(workspaceId))
    res.json(payload)
  })
)

// Sender-reputation snapshot: the trailing bounce/complaint rates the circuit
// breaker reads, plus the current guard mode. Lets an operator SEE the numbers
// observe-mode is logging and decide when to graduate to 'enforce'. Read-only.
statsRouter.get(
  '/reputation',
  asyncHandler(async (req, res) => {
    const user = req.user!
    const { workspaceId } = parseQuery(workspaceQuerySchema, req)

    const member = await userBelongsToWorkspace(user.id, workspaceId)
    if (!member) throw new ApiError(403, 'Access denied')

    const verdict = await evaluateSenderReputation(workspaceId)
    res.json({ guardMode: reputationGuardMode(), ...verdict })
  })
)

// The workspace-scoped aggregation behind GET /api/stats. Pure read of
// workspace data (no per-user fields), so its result is safe to cache/share
// across members of the same workspace.
async function buildStats(workspaceId: string): Promise<Record<string, unknown>> {
    const [
      stageCounts,
      campaignCount,
      recentLeads,
      topLeads,
      scoringModel,
      usageData,
      scoreBuckets
    ] = await Promise.all([
      prisma.lead.groupBy({
        by: ['stage'],
        where: { workspaceId },
        _count: { _all: true }
      }),
      prisma.campaign.count({ where: { workspaceId } }),
      prisma.lead.findMany({
        where: { workspaceId },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: { id: true, businessName: true, stage: true, score: true, category: true, createdAt: true }
      }),
      prisma.lead.findMany({
        where: { workspaceId, score: { gt: 0 } },
        orderBy: { score: 'desc' },
        take: 5,
        select: { id: true, businessName: true, stage: true, score: true, category: true }
      }),
      prisma.scoringModel.findUnique({
        where: { workspaceId },
        select: { weights: true, performanceMetrics: true, updateCount: true, lastWeightUpdate: true }
      }),
      // Returns the lapse-aware plan + lead usage/limit, so we don't separately
      // count leads or refetch the workspace plan (both were redundant queries).
      getMonthlyUsage(workspaceId),
      // Score distribution buckets for tier breakdown
      prisma.lead.groupBy({
        by: ['score'],
        where: { workspaceId, score: { gt: 0 } },
        _count: { _all: true }
      })
    ])

    const funnel: Record<string, number> = {}
    for (const stage of STAGES) funnel[stage] = 0
    let totalLeads = 0
    for (const row of stageCounts) {
      funnel[row.stage] = row._count._all
      totalLeads += row._count._all // every lead has a stage, so this is the total
    }

    const contacted = (funnel['OUTREACH_SENT'] ?? 0) + (funnel['REPLIED'] ?? 0)
      + (funnel['BOOKED'] ?? 0) + (funnel['CLOSED'] ?? 0)
    const replied = (funnel['REPLIED'] ?? 0) + (funnel['BOOKED'] ?? 0) + (funnel['CLOSED'] ?? 0)
    const booked = (funnel['BOOKED'] ?? 0) + (funnel['CLOSED'] ?? 0)

    const replyRate = contacted > 0 ? Math.round((replied / contacted) * 100) : 0
    const bookingRate = replied > 0 ? Math.round((booked / replied) * 100) : 0
    const closeRate = booked > 0 ? Math.round((funnel['CLOSED']! / booked) * 100) : 0

    // Score tier distribution
    const scoreDistribution = { HOT: 0, WARM: 0, COLD: 0 }
    for (const row of scoreBuckets) {
      const tier = getScoreTier(row.score)
      scoreDistribution[tier] += row._count._all
    }

    return {
      totalLeads,
      campaignCount,
      funnel,
      metrics: { replyRate, bookingRate, closeRate, contacted, replied, booked, closed: funnel['CLOSED'] ?? 0 },
      recentLeads,
      topLeads,
      scoreDistribution,
      scoringModel: scoringModel
        ? {
          weights: scoringModel.weights,
          metrics: scoringModel.performanceMetrics,
          updateCount: scoringModel.updateCount,
          lastWeightUpdate: scoringModel.lastWeightUpdate
        }
        : null,
      usage: {
        ...usageData,
        // leads.limit is already the lapse-aware cap, normalized to -1 = unlimited.
        maxLeads: usageData.leads.limit
      }
    }
}

statsRouter.get(
  '/campaigns',
  asyncHandler(async (req, res) => {
    const user = req.user!
    const { workspaceId } = parseQuery(workspaceQuerySchema, req)

    const member = await userBelongsToWorkspace(user.id, workspaceId)
    if (!member) throw new ApiError(403, 'Access denied')

    const campaigns = await prisma.campaign.findMany({
      where: { workspaceId },
      include: {
        _count: { select: { leads: true } },
        leads: {
          select: { stage: true, score: true },
          where: { stage: { in: ['OUTREACH_SENT', 'REPLIED', 'BOOKED', 'CLOSED'] } }
        }
      },
      orderBy: { createdAt: 'desc' }
    })

    type CampaignStatsRow = {
      id: string
      name: string
      goalType: string
      createdAt: Date
      _count: { leads: number }
      leads: Array<{ stage: string; score: number }>
    }

    const data = (campaigns as CampaignStatsRow[]).map((c: CampaignStatsRow) => {
      const active = c.leads.filter((l: { stage: string }) => ['REPLIED', 'BOOKED', 'CLOSED'].includes(l.stage))
      const avgScore = c.leads.length > 0
        ? Math.round(c.leads.reduce((s: number, l: { score: number }) => s + l.score, 0) / c.leads.length)
        : 0
      return {
        id: c.id,
        name: c.name,
        goalType: c.goalType,
        totalLeads: c._count.leads,
        contactedLeads: c.leads.length,
        activeLeads: active.length,
        avgScore,
        createdAt: c.createdAt
      }
    })

    res.json({ campaigns: data })
  })
)
