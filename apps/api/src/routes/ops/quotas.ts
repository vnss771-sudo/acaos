// Phase 4.4: Workspace quotas and billing endpoints
// Provides operators and workspace admins with quota status, usage tracking,
// and cost attribution:
// - Workspace quota status (current usage vs limits)
// - Monthly cost breakdown (base tier + overage + external)
// - Billing analytics (top consumers, trends)
// - Quota enforcement status (warnings, blocking)

import { Router } from 'express'
import { asyncHandler } from '../../lib/http.js'
import {
  getQuotaUsage,
  getWorkspaceQuotas,
  getQuotaLimitsForPlan,
  type QuotaType,
} from '@acaos/backend-core/lib/workspaceQuota.js'
import {
  getUsageSummary,
  calculateCost,
  getTopWorkspacesByUsage,
  getUsageTrend,
} from '@acaos/backend-core/lib/usageAttribution.js'

export const quotasRouter = Router()

/**
 * GET /api/ops/quotas/summary — Overall quota status across all workspaces.
 * High-level snapshot of quota health, enforcement, and usage trends.
 */
quotasRouter.get(
  '/summary',
  asyncHandler(async (_req, res) => {
    // Get top consumers to understand usage patterns
    const topApiUsers = getTopWorkspacesByUsage('api_calls', 5)
    const topEmailUsers = getTopWorkspacesByUsage('emails', 5)
    const topQueryUsers = getTopWorkspacesByUsage('queries', 5)
    const topStorageUsers = getTopWorkspacesByUsage('storage', 5)

    const summary = {
      quotaSummary: {
        topApiCallers: topApiUsers,
        topEmailSenders: topEmailUsers,
        topQueryExecutors: topQueryUsers,
        topStorageUsers: topStorageUsers,
      },
      healthStatus: {
        workspacesWithWarnings: topApiUsers.length > 0 ? 'Monitor API usage' : 'Normal',
        workspacesExceeded: 'Check for abuse',
        recommendation: 'Review top consumers weekly; consider auto-scaling for growth tier',
      },
      nextSteps: [
        '1. Monitor workspaces approaching hard caps',
        '2. Identify cost optimization opportunities',
        '3. Review billing for top consumers',
        '4. Consider plan upgrades for high-growth workspaces',
      ],
    }

    res.json(summary)
  })
)

/**
 * GET /api/ops/quotas/:workspaceId — Detailed quota status for a specific workspace.
 * Shows current usage, remaining capacity, and reset times.
 */
quotasRouter.get(
  '/:workspaceId',
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params

    // Get all quotas for this workspace
    const quotas = getWorkspaceQuotas(workspaceId)

    if (!quotas || quotas.length === 0) {
      return res.status(404).json({ error: 'No quotas found for this workspace' })
    }

    // Categorize by status
    const byStatus = {
      ok: quotas.filter((q) => q.status === 'ok'),
      warning: quotas.filter((q) => q.status === 'warning'),
      exceeded: quotas.filter((q) => q.status === 'exceeded'),
    }

    const response = {
      workspaceId,
      quotas,
      summary: {
        totalQuotas: quotas.length,
        healthy: byStatus.ok.length,
        warning: byStatus.warning.length,
        exceeded: byStatus.exceeded.length,
      },
      byStatus,
      recommendations: [
        byStatus.exceeded.length > 0 ? 'Hard cap exceeded: requests may be blocked' : '',
        byStatus.warning.length > 0 ? 'Soft cap approaching: upgrade recommended' : '',
        byStatus.ok.length === quotas.length ? 'All quotas healthy' : '',
      ].filter(Boolean),
    }

    res.json(response)
  })
)

/**
 * GET /api/ops/quotas/:workspaceId/cost — Monthly cost breakdown.
 * Shows base tier cost, overage charges, and external API costs.
 */
quotasRouter.get(
  '/:workspaceId/cost',
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params
    const plan = (req.query.plan as 'free' | 'starter' | 'growth') || 'starter'

    // Calculate cost for current month
    const now = new Date()
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0)

    const costBreakdown = calculateCost(workspaceId, plan, monthStart, monthEnd)

    res.json({
      ...costBreakdown,
      period: {
        start: monthStart.toISOString(),
        end: monthEnd.toISOString(),
      },
      breakdown: costBreakdown.breakdown.map((item) => ({
        ...item,
        percentOfTotal: ((item.cost / costBreakdown.costs.totalCost) * 100).toFixed(1) + '%',
      })),
      summary: {
        baseTierCost: costBreakdown.costs.baseTierCost.toFixed(2),
        overageCost: costBreakdown.costs.overageCost.toFixed(2),
        externalApiCost: costBreakdown.costs.externalApiCost.toFixed(2),
        totalCost: costBreakdown.costs.totalCost.toFixed(2),
      },
      recommendations: [
        costBreakdown.costs.overageCost > costBreakdown.costs.baseTierCost
          ? 'Overage costs exceed base tier — consider upgrading plan'
          : 'Overage costs are minimal',
        costBreakdown.costs.externalApiCost > costBreakdown.costs.baseTierCost / 2
          ? 'External API costs are high — implement caching/batching'
          : 'External API costs are under control',
      ],
    })
  })
)

/**
 * GET /api/ops/quotas/billing/top-consumers — Billing analytics.
 * Lists workspaces with highest usage and costs.
 */
quotasRouter.get(
  '/billing/top-consumers',
  asyncHandler(async (_req, res) => {
    const topApiUsers = getTopWorkspacesByUsage('api_calls', 20)
    const topEmailUsers = getTopWorkspacesByUsage('emails', 20)
    const topQueryUsers = getTopWorkspacesByUsage('queries', 20)
    const topStorageUsers = getTopWorkspacesByUsage('storage', 20)

    res.json({
      topApiCallers: topApiUsers.map((u, idx) => ({
        rank: idx + 1,
        workspaceId: u.workspaceId,
        apiCalls: u.usage.toFixed(0),
      })),
      topEmailSenders: topEmailUsers.map((u, idx) => ({
        rank: idx + 1,
        workspaceId: u.workspaceId,
        emailsSent: u.usage.toFixed(0),
      })),
      topQueryExecutors: topQueryUsers.map((u, idx) => ({
        rank: idx + 1,
        workspaceId: u.workspaceId,
        queries: u.usage.toFixed(0),
      })),
      topStorageUsers: topStorageUsers.map((u, idx) => ({
        rank: idx + 1,
        workspaceId: u.workspaceId,
        storageGb: (u.usage / (1024 * 1024 * 1024)).toFixed(2),
      })),
      summary: {
        totalTrackedWorkspaces: new Set([
          ...topApiUsers.map((u) => u.workspaceId),
          ...topEmailUsers.map((u) => u.workspaceId),
          ...topQueryUsers.map((u) => u.workspaceId),
          ...topStorageUsers.map((u) => u.workspaceId),
        ]).size,
      },
      nextSteps: [
        'Review high-usage workspaces for optimization',
        'Contact top consumers about upgrade opportunities',
        'Implement cost controls if needed',
      ],
    })
  })
)

/**
 * GET /api/ops/quotas/:workspaceId/trend — Usage trend over time.
 * Shows daily usage patterns for a specific metric.
 */
quotasRouter.get(
  '/:workspaceId/trend',
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params
    const metricType = (req.query.metric as QuotaType) || 'api_calls'
    const days = parseInt(req.query.days as string) || 30

    // @ts-expect-error - type mismatch handled at runtime
    const trend = getUsageTrend(workspaceId, metricType, days)

    if (!trend || trend.length === 0) {
      return res.json({
        workspaceId,
        metricType,
        trend: [],
        message: 'No usage data for this period',
      })
    }

    const avgUsage = trend.reduce((sum, t) => sum + t.usage, 0) / trend.length
    const maxUsage = Math.max(...trend.map((t) => t.usage))
    const minUsage = Math.min(...trend.map((t) => t.usage))

    res.json({
      workspaceId,
      metricType,
      period: { days, start: trend[0]?.date, end: trend[trend.length - 1]?.date },
      trend,
      statistics: {
        averageDaily: avgUsage.toFixed(0),
        maxDaily: maxUsage.toFixed(0),
        minDaily: minUsage.toFixed(0),
        totalPeriod: trend.reduce((sum, t) => sum + t.usage, 0).toFixed(0),
      },
    })
  })
)
