import { Router } from 'express'
import { prisma } from '../lib/prisma.js'
import { asyncHandler, ApiError } from '../lib/http.js'
import { requireAuth, requireVerifiedEmail, hasFreshAuth } from '../middleware/auth.js'
import { recordAudit } from '../lib/audit.js'
import { getQueueStats } from '../lib/queues.js'
import { parseQuery } from '../lib/validate.js'
import { z } from 'zod'
import type { AuthUser } from '../types/auth.js'

export const adminRouter = Router()
adminRouter.use(requireAuth)
// Platform-admin endpoints expose cross-tenant data, so the admin must also have
// a verified email — not just a matching address.
adminRouter.use(requireVerifiedEmail)

function emailMatchesBootstrapAdmin(user: AuthUser): boolean {
  const adminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase()
  return Boolean(adminEmail && user.email.toLowerCase() === adminEmail)
}

// Platform-admin gate. Authority rests on the non-user-settable DB flag
// (`isPlatformAdmin`). ADMIN_EMAIL is NOT a perpetual fallback — it is a
// one-time bootstrap: the first time a verified user whose address matches
// ADMIN_EMAIL reaches an admin route, we promote them to the DB flag and write
// an audit event. From then on the flag is the sole source of truth, so the env
// var can be removed and the grant is permanently recorded. This closes the
// "silent, never-expiring env backdoor" — every admin grant is now observable
// in the audit log and any subsequent ADMIN_EMAIL change cannot escalate a
// different account without leaving a trail.
adminRouter.use(
  asyncHandler(async (req, _res, next) => {
    const user = req.user!

    if (user.isPlatformAdmin) return next()

    if (user.emailVerified && emailMatchesBootstrapAdmin(user)) {
      // Promotion is a privilege escalation — require a recent credential proof
      // (step-up), so a long-lived stolen access token can't bootstrap admin.
      if (!(await hasFreshAuth(user.id))) {
        throw new ApiError(403, 'Re-authentication required to gain admin access')
      }
      await prisma.user.update({ where: { id: user.id }, data: { isPlatformAdmin: true } })
      user.isPlatformAdmin = true
      await recordAudit({
        actorUserId: user.id,
        type: 'platform_admin.bootstrap',
        entityType: 'User',
        entityId: user.id,
        metadata: { via: 'ADMIN_EMAIL' },
      })
      console.warn(`[admin] bootstrapped platform admin from ADMIN_EMAIL for user ${user.id} — promoted to DB flag`)
      return next()
    }

    throw new ApiError(403, 'Admin access required')
  })
)

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
const auditQuerySchema = z.object({
  // Mirrors the previous `typeof === 'string' ? trim() : undefined` handling:
  // present-and-string values are trimmed, anything else is treated as absent.
  workspaceId: z.string().trim().optional(),
  type: z.string().trim().optional(),
  // Mirrors `Math.min(200, Math.max(1, Number(limit) || 100))` exactly: any
  // falsy Number() result (NaN, 0, empty) becomes 100, then clamp to [1, 200].
  limit: z.unknown().optional().transform(v => Math.min(200, Math.max(1, Number(v) || 100))),
})

adminRouter.get(
  '/audit',
  asyncHandler(async (req, res) => {
    const { workspaceId: rawWorkspaceId, type: rawType, limit } = parseQuery(auditQuerySchema, req)
    const workspaceId = rawWorkspaceId || undefined
    const type = rawType || undefined
    const events = await prisma.auditEvent.findMany({
      where: { ...(workspaceId ? { workspaceId } : {}), ...(type ? { type } : {}) },
      orderBy: { createdAt: 'desc' },
      take: limit,
    })
    res.json({ events })
  })
)
