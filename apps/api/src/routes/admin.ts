import { Router } from 'express'
import { prisma } from '../lib/prisma.js'
import { asyncHandler, ApiError } from '../lib/http.js'
import { requireAuth, requireVerifiedEmail } from '../middleware/auth.js'
import { getQueueStats } from '../lib/queues.js'
import type { AuthedRequest, AuthUser } from '../types/auth.js'

export const adminRouter = Router()
adminRouter.use(requireAuth)
// Platform-admin endpoints expose cross-tenant data, so the admin must also have
// a verified email — not just a matching address.
adminRouter.use(requireVerifiedEmail)

function isAdminUser(user: AuthUser): boolean {
  // Primary path: a non-user-settable DB flag, provisioned out-of-band. The
  // ADMIN_EMAIL env var is kept as a bootstrap fallback so the founder account
  // works before the flag is set, but the boundary no longer rests on it alone.
  if (user.isPlatformAdmin) return true
  const adminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase()
  return Boolean(adminEmail && user.email.toLowerCase() === adminEmail)
}

adminRouter.use((req, _res, next) => {
  const user = (req as AuthedRequest).user
  if (!isAdminUser(user)) throw new ApiError(403, 'Admin access required')
  next()
})

adminRouter.get(
  '/overview',
  asyncHandler(async (_req, res) => {
    const currentMonth = new Date().toISOString().slice(0, 7) // YYYY-MM

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
        orderBy: { createdAt: 'desc' },
        // Bound the cross-workspace scan — the overview shows the most recent
        // workspaces, not an unbounded full-table load.
        take: 500
      }),
      prisma.usageRecord.groupBy({
        by: ['workspaceId'],
        where: { month: currentMonth },
        _sum: { count: true }
      })
    ])

    type AdminUsageRow = { workspaceId: string; _sum: { count: number | null } }
    type AdminWorkspaceRow = {
      id: string
      name: string
      slug: string
      plan: string
      subscriptionStatus: string | null
      createdAt: Date
      _count: { leads: number; campaigns: number; memberships: number }
    }
    type AdminWorkspaceSummary = {
      id: string
      name: string
      slug: string
      plan: string
      subscriptionStatus: string | null
      createdAt: Date
      memberCount: number
      leadCount: number
      campaignCount: number
      aiCallsThisMonth: number
    }

    const usageByWs = new Map((aiUsage as AdminUsageRow[]).map((u: AdminUsageRow) => [u.workspaceId, u._sum.count ?? 0]))

    const summary: AdminWorkspaceSummary[] = (workspaces as AdminWorkspaceRow[]).map((ws: AdminWorkspaceRow) => ({
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
      totalLeads: summary.reduce((s: number, w: AdminWorkspaceSummary) => s + w.leadCount, 0),
      totalCampaigns: summary.reduce((s: number, w: AdminWorkspaceSummary) => s + w.campaignCount, 0),
      totalAiCalls: summary.reduce((s: number, w: AdminWorkspaceSummary) => s + w.aiCallsThisMonth, 0),
      paidWorkspaces: summary.filter((w: AdminWorkspaceSummary) => w.plan !== 'free').length
    }

    res.json({ workspaces: summary, totals })
  })
)

adminRouter.get(
  '/queue-stats',
  asyncHandler(async (_req, res) => {
    const stats = await getQueueStats()
    res.json({ queues: stats })
  })
)

// Recent audit events (optionally filtered by workspace or type) for operational
// visibility: sends, mission status changes, discovery failures, etc.
adminRouter.get(
  '/audit',
  asyncHandler(async (req, res) => {
    const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId.trim() : undefined
    const type = typeof req.query.type === 'string' ? req.query.type.trim() : undefined
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100))
    const events = await prisma.auditEvent.findMany({
      where: { ...(workspaceId ? { workspaceId } : {}), ...(type ? { type } : {}) },
      orderBy: { createdAt: 'desc' },
      take: limit,
    })
    res.json({ events })
  })
)
