import { Router } from 'express'
import { asyncHandler, ApiError, requireUser } from '../../lib/http.js'
import { userBelongsToWorkspace } from '../../lib/workspaces.js'
import { z } from 'zod'
import {
  getWorkspaceQuotas,
  getQuotaUsage,
  checkQuota,
  type QuotaType,
} from '@acaos/backend-core/lib/workspaceQuota.js'
import {
  calculateCost,
  getUsageSummary,
} from '@acaos/backend-core/lib/usageAttribution.js'
import { prisma } from '@acaos/backend-core/lib/prisma.js'

// Phase 4.4: Workspace quota visibility endpoints. Shows workspace members their
// current quota usage, remaining capacity, and monthly costs. Helps users
// understand their consumption and plan upgrade recommendations.

const quotaTypeSchema = z.enum(['api_calls', 'emails_sent', 'database_queries', 'storage_bytes', 'ai_tokens'])

export function registerQuotaRoutes(router: Router): void {
  // GET /api/workspaces/:id/quotas — User-facing quota status
  router.get(
    '/:id/quotas',
    asyncHandler(async (req, res) => {
      const user = requireUser(req)
      const workspaceId = req.params.id

      if (!(await userBelongsToWorkspace(user.id, workspaceId))) {
        throw new ApiError(403, 'Access denied')
      }

      const ws = await prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { plan: true },
      })

      if (!ws) throw new ApiError(404, 'Workspace not found')

      const quotas = getWorkspaceQuotas(workspaceId)
      const plan = (ws.plan || 'free') as 'free' | 'starter' | 'growth'

      if (!quotas || quotas.length === 0) {
        return res.json({
          workspaceId,
          plan,
          quotas: [],
          message: 'No quota data available yet',
        })
      }

      const byStatus = {
        ok: quotas.filter((q) => q.status === 'ok'),
        warning: quotas.filter((q) => q.status === 'warning'),
        exceeded: quotas.filter((q) => q.status === 'exceeded'),
      }

      res.json({
        workspaceId,
        plan,
        quotas: quotas.map((q) => ({
          type: q.quotaType,
          status: q.status,
          usage: q.currentUsage,
          limit: q.limitValue,
          softCap: q.softCapValue,
          percentageUsed: q.percentageUsed.toFixed(1),
          resetAt: q.resetAt.toISOString(),
          resetCycle: q.resetCycle,
        })),
        summary: {
          healthy: byStatus.ok.length,
          warning: byStatus.warning.length,
          exceeded: byStatus.exceeded.length,
        },
        recommendations: [
          byStatus.exceeded.length > 0
            ? 'One or more quotas exceeded — requests may be blocked. Contact support for immediate relief.'
            : '',
          byStatus.warning.length > 0 ? `${byStatus.warning.length} quota(s) approaching limit — consider upgrading plan` : '',
          byStatus.ok.length === quotas.length ? 'All quotas healthy' : '',
        ].filter(Boolean),
        upgradeInfo: {
          currentPlan: plan,
          nextPlan: plan === 'free' ? 'starter' : plan === 'starter' ? 'growth' : 'contact-sales',
          description: 'Higher plans include increased quotas across all metric types',
        },
      })
    })
  )

  // GET /api/workspaces/:id/quotas/cost — Monthly cost breakdown
  router.get(
    '/:id/quotas/cost',
    asyncHandler(async (req, res) => {
      const user = requireUser(req)
      const workspaceId = req.params.id

      if (!(await userBelongsToWorkspace(user.id, workspaceId))) {
        throw new ApiError(403, 'Access denied')
      }

      const ws = await prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { plan: true },
      })

      if (!ws) throw new ApiError(404, 'Workspace not found')

      const plan = (ws.plan || 'free') as 'free' | 'starter' | 'growth'
      const now = new Date()
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
      const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0)

      const costBreakdown = calculateCost(workspaceId, plan, monthStart, monthEnd)

      res.json({
        workspaceId,
        plan,
        period: {
          start: monthStart.toISOString().split('T')[0],
          end: monthEnd.toISOString().split('T')[0],
        },
        costs: {
          baseTierCost: parseFloat(costBreakdown.costs.baseTierCost.toFixed(2)),
          overageCost: parseFloat(costBreakdown.costs.overageCost.toFixed(2)),
          externalApiCost: parseFloat(costBreakdown.costs.externalApiCost.toFixed(2)),
          totalCost: parseFloat(costBreakdown.costs.totalCost.toFixed(2)),
        },
        usage: {
          apiCalls: costBreakdown.usage.apiCalls,
          emailsSent: costBreakdown.usage.emailsSent,
          dbQueries: costBreakdown.usage.dbQueries,
          storageBytes: costBreakdown.usage.storageBytes,
          aiTokens: costBreakdown.usage.aiTokens,
          jobsProcessed: costBreakdown.usage.jobsProcessed,
        },
        breakdown: costBreakdown.breakdown.map((item) => ({
          category: item.category,
          usage: item.usage,
          limit: item.limit,
          cost: parseFloat(item.cost.toFixed(2)),
          percentOfUsage: ((item.usage / item.limit) * 100).toFixed(1) + '%',
        })),
        recommendations: [
          costBreakdown.costs.overageCost > costBreakdown.costs.baseTierCost / 2
            ? 'Overage costs are significant — consider upgrading to next plan'
            : 'Overage costs minimal',
          costBreakdown.costs.externalApiCost > 10
            ? 'External API costs are accumulating — implement caching/batching'
            : 'External API costs under control',
        ],
      })
    })
  )

  // GET /api/workspaces/:id/quotas/:quotaType/status — Single quota status
  router.get(
    '/:id/quotas/:quotaType/status',
    asyncHandler(async (req, res) => {
      const user = requireUser(req)
      const { id: workspaceId, quotaType } = req.params

      if (!(await userBelongsToWorkspace(user.id, workspaceId))) {
        throw new ApiError(403, 'Access denied')
      }

      const parsed = quotaTypeSchema.safeParse(quotaType)
      if (!parsed.success) {
        throw new ApiError(400, `Invalid quota type: ${quotaType}`)
      }

      const quota = getQuotaUsage(workspaceId, parsed.data)

      if (!quota) {
        return res.status(404).json({
          error: `No usage data for quota type: ${quotaType}`,
        })
      }

      res.json({
        workspaceId,
        quota: {
          type: quota.quotaType,
          status: quota.status,
          usage: quota.currentUsage,
          limit: quota.limitValue,
          softCap: quota.softCapValue,
          percentageUsed: quota.percentageUsed.toFixed(1),
          resetAt: quota.resetAt.toISOString(),
          resetCycle: quota.resetCycle,
        },
        message:
          quota.status === 'ok'
            ? `Usage is healthy (${quota.percentageUsed.toFixed(0)}% of limit)`
            : quota.status === 'warning'
              ? `Approaching soft cap at ${quota.percentageUsed.toFixed(0)}% of limit`
              : `Hard cap exceeded — requests may be blocked`,
      })
    })
  )
}
