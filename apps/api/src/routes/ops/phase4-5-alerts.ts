// Phase 4.5: Quota alerts and cost forecasting endpoints
// Provides operators with real-time alerts, upgrade recommendations,
// and cost forecasting for billing and capacity planning.

import { Router } from 'express'
import { asyncHandler } from '../../lib/http.js'
import {
  getActiveAlerts,
  getAlertHistory,
  getAlertSummary,
  recommendPlanUpgrade,
  forecastMonthEnd,
  type QuotaAlert,
} from '@acaos/backend-core/lib/quotaAlerts.js'
import {
  forecastMonthendCost,
  identifyCostOptimizations,
  analyzeUsagePattern,
  getUsageHistory,
  type UsagePattern,
} from '@acaos/backend-core/lib/costForecasting.js'
import { getUsageSummary, calculateCost, PRICING } from '@acaos/backend-core/lib/usageAttribution.js'

export const phase45AlertsRouter = Router()

/**
 * GET /api/ops/alerts/summary — Overall alert status.
 * High-level view of all active alerts across system.
 */
phase45AlertsRouter.get(
  '/summary',
  asyncHandler(async (_req, res) => {
    const summary = getAlertSummary()

    res.json({
      summary,
      status:
        summary.criticalAlerts > 0
          ? 'critical'
          : summary.warningAlerts > 0
            ? 'warning'
            : 'healthy',
      recommendations: [
        summary.criticalAlerts > 0 ? 'Critical alerts require immediate action' : '',
        summary.affectedWorkspaces > 5 ? 'Many workspaces showing quota stress' : '',
        summary.totalActiveAlerts === 0 ? 'All quotas healthy' : '',
      ].filter(Boolean),
      nextSteps: [
        '1. Review critical alerts',
        '2. Identify affected workspaces',
        '3. Recommend upgrades for high-risk workspaces',
      ],
    })
  })
)

/**
 * GET /api/ops/alerts/:workspaceId — Active alerts for workspace.
 */
phase45AlertsRouter.get(
  '/:workspaceId',
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params
    const alerts = getActiveAlerts(workspaceId)

    res.json({
      workspaceId,
      activeAlerts: alerts,
      count: alerts.length,
      critical: alerts.filter((a) => a.level === 'critical').length,
      warnings: alerts.filter((a) => a.level === 'warning').length,
      recommendations:
        alerts.length > 0
          ? [
              ...new Set(
                alerts
                  .filter((a) => a.recommendation)
                  .map((a) => a.recommendation!)
              ),
            ]
          : ['No alerts'],
    })
  })
)

/**
 * GET /api/ops/alerts/:workspaceId/history — Alert history for workspace.
 */
phase45AlertsRouter.get(
  '/:workspaceId/history',
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params
    const limit = parseInt(req.query.limit as string) || 50
    const history = getAlertHistory(workspaceId).slice(-limit)

    res.json({
      workspaceId,
      total: history.length,
      alerts: history.reverse(), // Most recent first
    })
  })
)

/**
 * GET /api/ops/alerts/:workspaceId/upgrade-recommendation — Plan upgrade advice.
 */
phase45AlertsRouter.get(
  '/:workspaceId/upgrade-recommendation',
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params
    const plan = (req.query.plan as 'free' | 'starter' | 'growth') || 'starter'

    const now = new Date()
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0)

    const costBreakdown = calculateCost(workspaceId, plan, monthStart, monthEnd)
    const currentMonthCost = costBreakdown.costs.totalCost

    const daysElapsed = now.getDate()
    const daysInMonth = monthEnd.getDate()
    const projectedMonthEnd = Math.ceil((currentMonthCost / daysElapsed) * daysInMonth)

    const projectedOverage = Math.max(0, projectedMonthEnd - costBreakdown.costs.baseTierCost)

    const recommendation = recommendPlanUpgrade(
      workspaceId,
      plan,
      projectedOverage,
      currentMonthCost
    )

    if (!recommendation) {
      return res.json({
        workspaceId,
        plan,
        status: 'optimal',
        message: 'Current plan is cost-effective',
        currentMonthProjection: {
          cost: currentMonthCost.toFixed(2),
          overage: projectedOverage.toFixed(2),
        },
      })
    }

    res.json({
      workspaceId,
      plan,
      status: 'upgrade_recommended',
      recommendation: {
        ...recommendation,
        estimatedMonthlyCost: recommendation.estimatedMonthlyCost.toFixed(2),
        savingsVsOverage: recommendation.savingsVsOverage.toFixed(2),
      },
      currentProjection: {
        monthlyCost: currentMonthCost.toFixed(2),
        projectedOverage: projectedOverage.toFixed(2),
      },
    })
  })
)

/**
 * GET /api/ops/alerts/:workspaceId/cost-forecast — Month-end cost prediction.
 */
phase45AlertsRouter.get(
  '/:workspaceId/cost-forecast',
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params
    const plan = (req.query.plan as 'free' | 'starter' | 'growth') || 'starter'

    const now = new Date()
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
    const daysElapsed = now.getDate()
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()

    const costBreakdown = calculateCost(workspaceId, plan, monthStart, now)
    const forecast = forecastMonthendCost(
      workspaceId,
      costBreakdown.costs.baseTierCost,
      PRICING.overagePricing as Record<string, number>,
      daysElapsed
    )

    const forecastData = forecastMonthEnd(
      workspaceId,
      costBreakdown.usage.apiCalls + costBreakdown.usage.emailsSent,
      daysElapsed,
      costBreakdown.costs.totalCost,
      plan
    )

    res.json({
      workspaceId,
      plan,
      period: {
        daysElapsed,
        daysInMonth,
        daysRemaining: daysInMonth - daysElapsed,
      },
      current: {
        monthlyCost: costBreakdown.costs.totalCost.toFixed(2),
        baseTierCost: costBreakdown.costs.baseTierCost.toFixed(2),
      },
      forecast: {
        projectedTotal: forecast.projectedTotal.toFixed(2),
        projectedOverage: forecast.projectedOverage.toFixed(2),
        confidence: `${forecast.confidence}%`,
        breakdown: forecast.breakdown.map((b) => ({
          metric: b.metric,
          dailyAverage: b.dailyAverage,
          monthlyProjection: b.monthlyProjection,
          costImpact: b.costImpact.toFixed(2),
          percentOfTotal: b.percentOfTotal.toFixed(1) + '%',
        })),
      },
      recommendation: forecastData.recommendation,
      shouldUpgrade: forecastData.shouldUpgrade,
    })
  })
)

/**
 * GET /api/ops/alerts/:workspaceId/cost-optimizations — Cost saving opportunities.
 */
phase45AlertsRouter.get(
  '/:workspaceId/cost-optimizations',
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params
    const optimizations = identifyCostOptimizations(workspaceId, {})

    if (optimizations.length === 0) {
      return res.json({
        workspaceId,
        optimizations: [],
        status: 'optimized',
        message: 'No obvious cost optimization opportunities detected',
      })
    }

    const totalPotentialSavings = optimizations.reduce((sum, o) => sum + o.potentialSavings, 0)

    res.json({
      workspaceId,
      optimizations: optimizations.map((o) => ({
        metric: o.metric,
        currentUsage: o.currentUsage,
        potentialSavings: o.potentialSavings.toFixed(2),
        savingsPercentage: o.savingsPercentage.toFixed(1) + '%',
        recommendation: o.recommendation,
        priority: o.priority,
      })),
      summary: {
        count: optimizations.length,
        totalPotentialSavings: totalPotentialSavings.toFixed(2),
        highPriority: optimizations.filter((o) => o.priority === 'high').length,
      },
    })
  })
)

/**
 * GET /api/ops/alerts/:workspaceId/usage-patterns — Usage trend analysis.
 */
phase45AlertsRouter.get(
  '/:workspaceId/usage-patterns',
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params
    const days = parseInt(req.query.days as string) || 30

    const metrics = ['apiCalls', 'emailsSent', 'dbQueries', 'aiTokens']
    const patterns: UsagePattern[] = []

    for (const metric of metrics) {
      const pattern = analyzeUsagePattern(workspaceId, metric as any, days)
      patterns.push(pattern)
    }

    const history = getUsageHistory(workspaceId)

    res.json({
      workspaceId,
      period: days,
      dataPoints: history.length,
      patterns: patterns.map((p) => ({
        metric: p.metric,
        dailyAverage: p.dailyAverage,
        dailyStdDev: p.dailyStdDev,
        peakDaily: p.peakDaily,
        trend: p.trend,
        trendPercentage: p.trendPercentage + '%',
      })),
      recommendations: [
        patterns.some((p) => p.trend === 'volatile')
          ? 'High volatility detected — monitor for anomalies'
          : '',
        patterns.some((p) => p.trend === 'increasing')
          ? 'Increasing trend — consider proactive optimization'
          : '',
        patterns.every((p) => p.trend === 'stable') ? 'Usage patterns stable' : '',
      ].filter(Boolean),
    })
  })
)
