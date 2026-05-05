import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { asyncHandler, ApiError } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import { userBelongsToWorkspace } from '../lib/workspaces.js'
import type { AuthedRequest } from '../types/auth.js'

export const statsRouter = Router()
statsRouter.use(requireAuth)

const STAGES = ['NEW', 'RESEARCHED', 'OUTREACH_SENT', 'REPLIED', 'BOOKED', 'CLOSED', 'DEAD']

statsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const workspaceId = String(req.query.workspaceId || '').trim()
    if (!workspaceId) throw new ApiError(400, 'workspaceId required')

    const member = await userBelongsToWorkspace(user.id, workspaceId)
    if (!member) throw new ApiError(403, 'Access denied')

    const [stageCounts, campaignCount, totalLeads, recentLeads, topLeads] = await Promise.all([
      // Lead count per stage
      prisma.lead.groupBy({
        by: ['stage'],
        where: { workspaceId },
        _count: { _all: true }
      }),

      // Total active campaigns
      prisma.campaign.count({ where: { workspaceId } }),

      // Total leads
      prisma.lead.count({ where: { workspaceId } }),

      // 5 most recently added leads
      prisma.lead.findMany({
        where: { workspaceId },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: {
          id: true, businessName: true, stage: true, score: true,
          category: true, createdAt: true
        }
      }),

      // Top 5 leads by score
      prisma.lead.findMany({
        where: { workspaceId, score: { gt: 0 } },
        orderBy: { score: 'desc' },
        take: 5,
        select: {
          id: true, businessName: true, stage: true, score: true, category: true
        }
      })
    ])

    // Build funnel map
    const funnel: Record<string, number> = {}
    for (const stage of STAGES) funnel[stage] = 0
    for (const row of stageCounts) funnel[row.stage] = row._count._all

    // Conversion metrics
    const contacted = (funnel['OUTREACH_SENT'] ?? 0) + (funnel['REPLIED'] ?? 0)
      + (funnel['BOOKED'] ?? 0) + (funnel['CLOSED'] ?? 0)
    const replied = (funnel['REPLIED'] ?? 0) + (funnel['BOOKED'] ?? 0) + (funnel['CLOSED'] ?? 0)
    const booked = (funnel['BOOKED'] ?? 0) + (funnel['CLOSED'] ?? 0)

    const replyRate = contacted > 0 ? Math.round((replied / contacted) * 100) : 0
    const bookingRate = replied > 0 ? Math.round((booked / replied) * 100) : 0
    const closeRate = booked > 0 ? Math.round((funnel['CLOSED']! / booked) * 100) : 0

    res.json({
      totalLeads,
      campaignCount,
      funnel,
      metrics: { replyRate, bookingRate, closeRate, contacted, replied, booked, closed: funnel['CLOSED'] ?? 0 },
      recentLeads,
      topLeads
    })
  })
)

statsRouter.get(
  '/campaigns',
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const workspaceId = String(req.query.workspaceId || '').trim()
    if (!workspaceId) throw new ApiError(400, 'workspaceId required')

    const member = await userBelongsToWorkspace(user.id, workspaceId)
    if (!member) throw new ApiError(403, 'Access denied')

    const campaigns = await prisma.campaign.findMany({
      where: { workspaceId },
      include: {
        _count: { select: { leads: true } },
        leads: {
          select: { stage: true },
          where: { stage: { in: ['REPLIED', 'BOOKED', 'CLOSED'] } }
        }
      },
      orderBy: { createdAt: 'desc' }
    })

    const data = campaigns.map(c => ({
      id: c.id,
      name: c.name,
      goalType: c.goalType,
      totalLeads: c._count.leads,
      activeLeads: c.leads.length,
      createdAt: c.createdAt
    }))

    res.json({ campaigns: data })
  })
)
