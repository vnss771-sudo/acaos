import { Router } from 'express'
import { prisma } from '../lib/prisma.js'
import { asyncHandler, ApiError } from '../lib/http.js'
import { requireAuth } from '../middleware/auth.js'
import type { AuthedRequest } from '../types/auth.js'

export const adminRouter = Router()
adminRouter.use(requireAuth)

function isAdminUser(email: string): boolean {
  const adminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase()
  return Boolean(adminEmail && email.toLowerCase() === adminEmail)
}

adminRouter.use((req, _res, next) => {
  const user = (req as AuthedRequest).user
  if (!isAdminUser(user.email)) throw new ApiError(403, 'Admin access required')
  next()
})

adminRouter.get(
  '/overview',
  asyncHandler(async (_req, res) => {
    const now = new Date()
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)

    const [workspaces, aiUsage] = await Promise.all([
      prisma.workspace.findMany({
        select: {
          id: true,
          name: true,
          slug: true,
          plan: true,
          subscriptionStatus: true,
          createdAt: true,
          _count: {
            select: { leads: true, campaigns: true, memberships: true }
          }
        },
        orderBy: { createdAt: 'desc' }
      }),
      prisma.aiUsage.groupBy({
        by: ['workspaceId'],
        where: { month: { gte: monthStart } },
        _sum: { count: true }
      })
    ])

    const usageByWs = new Map(aiUsage.map(u => [u.workspaceId, u._sum.count ?? 0]))

    const summary = workspaces.map(ws => ({
      id: ws.id,
      name: ws.name,
      slug: ws.slug,
      plan: ws.plan,
      subscriptionStatus: ws.subscriptionStatus ?? null,
      createdAt: ws.createdAt,
      memberCount: ws._count.memberships,
      leadCount: ws._count.leads,
      campaignCount: ws._count.campaigns,
      aiCallsThisMonth: usageByWs.get(ws.id) ?? 0
    }))

    const totals = {
      workspaceCount: summary.length,
      totalLeads: summary.reduce((s, w) => s + w.leadCount, 0),
      totalCampaigns: summary.reduce((s, w) => s + w.campaignCount, 0),
      totalAiCalls: summary.reduce((s, w) => s + w.aiCallsThisMonth, 0),
      paidWorkspaces: summary.filter(w => w.plan !== 'free').length
    }

    res.json({ workspaces: summary, totals })
  })
)
