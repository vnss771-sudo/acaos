// Phase 4.7: Anomaly detection, cost attribution, and optimization analytics endpoints.

import { Router } from 'express'
import { asyncHandler } from '../../lib/http.js'
import {
  detectAnomaly,
  getAnomalies,
  resolveAnomaly,
  classifyPattern,
  getPattern,
  calculateCostAttribution,
  getCostAttribution,
  createOptimization,
  getOptimizations,
  markOptimizationImplemented,
  forecastQuotaExceeded,
  getOptimizationRecommendations,
  type MetricType,
  type OptimizationType,
} from '@acaos/backend-core/lib/anomalyDetection.js'

export const phase47AnalyticsRouter = Router()

// ============================================================================
// Anomaly Detection Endpoints
// ============================================================================

/**
 * POST /api/ops/analytics/anomalies/:workspaceId/detect
 * Detect anomalies in current usage.
 */
phase47AnalyticsRouter.post(
  '/anomalies/:workspaceId/detect',
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params
    const { metricType, currentDaily, baselineDaily, baselineStdDev } = req.body

    const anomaly = detectAnomaly(workspaceId, metricType as MetricType, currentDaily, baselineDaily, baselineStdDev)

    if (!anomaly) {
      return res.json({
        workspaceId,
        metricType,
        anomalyDetected: false,
        message: 'No anomaly detected. Usage is within normal parameters.',
      })
    }

    res.json({
      workspaceId,
      metricType,
      anomalyDetected: true,
      anomaly: {
        id: anomaly.id,
        severity: anomaly.severity,
        current: anomaly.currentDaily,
        baseline: anomaly.baselineDaily,
        deviationSigma: anomaly.deviationSigma.toFixed(2),
        detectedAt: anomaly.detectedAt.toISOString(),
      },
      message: `Anomaly detected: ${anomaly.metricType} usage is ${anomaly.deviationSigma.toFixed(1)}σ above baseline (${anomaly.severity})`,
    })
  })
)

/**
 * GET /api/ops/analytics/anomalies/:workspaceId
 * Get recent anomalies for workspace.
 */
phase47AnalyticsRouter.get(
  '/anomalies/:workspaceId',
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params
    const limit = parseInt(req.query.limit as string) || 50

    const anomalyList = getAnomalies(workspaceId, limit)

    res.json({
      workspaceId,
      count: anomalyList.length,
      anomalies: anomalyList.map((a) => ({
        id: a.id,
        metricType: a.metricType,
        severity: a.severity,
        current: a.currentDaily,
        baseline: a.baselineDaily,
        deviationSigma: a.deviationSigma.toFixed(2),
        detectedAt: a.detectedAt.toISOString(),
        resolved: a.resolvedAt ? true : false,
        rootCause: a.rootCause,
      })),
    })
  })
)

/**
 * PUT /api/ops/analytics/anomalies/:workspaceId/:anomalyId
 * Resolve an anomaly (mark as handled).
 */
phase47AnalyticsRouter.put(
  '/anomalies/:workspaceId/:anomalyId',
  asyncHandler(async (req, res) => {
    const { workspaceId, anomalyId } = req.params
    const { rootCause, actionTaken } = req.body

    const success = resolveAnomaly(workspaceId, anomalyId, rootCause, actionTaken)

    if (!success) {
      return res.status(404).json({ error: 'Anomaly not found' })
    }

    res.json({
      success: true,
      message: 'Anomaly resolved',
      rootCause,
      actionTaken,
    })
  })
)

// ============================================================================
// Usage Pattern Endpoints
// ============================================================================

/**
 * POST /api/ops/analytics/patterns/:workspaceId/classify
 * Classify current usage pattern.
 */
phase47AnalyticsRouter.post(
  '/patterns/:workspaceId/classify',
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params
    const { metricType, dailyAverage, currentDaily, recentTrend } = req.body

    const pattern = classifyPattern(workspaceId, metricType as MetricType, dailyAverage, currentDaily, recentTrend)

    res.json({
      workspaceId,
      metricType,
      classification: pattern.classification,
      confidence: `${pattern.confidence}%`,
      description: pattern.description,
      growthRate: `${pattern.growthRate.toFixed(1)}%/day`,
      triggers: pattern.triggers,
      currentDaily: pattern.currentDaily,
      baseline: pattern.dailyAverage,
    })
  })
)

/**
 * GET /api/ops/analytics/patterns/:workspaceId
 * Get current usage patterns for all metrics.
 */
phase47AnalyticsRouter.get(
  '/patterns/:workspaceId',
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params
    const metric = req.query.metric as MetricType | undefined

    const patterns = getPattern(workspaceId, metric)

    res.json({
      workspaceId,
      count: patterns.length,
      patterns: patterns.map((p) => ({
        metricType: p.metricType,
        classification: p.classification,
        confidence: `${p.confidence}%`,
        description: p.description,
        growthRate: `${p.growthRate.toFixed(1)}%/day`,
        triggers: p.triggers,
      })),
    })
  })
)

// ============================================================================
// Cost Attribution Endpoints
// ============================================================================

/**
 * POST /api/ops/analytics/costs/:workspaceId/calculate
 * Calculate cost attribution by consumer.
 */
phase47AnalyticsRouter.post(
  '/costs/:workspaceId/calculate',
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params
    const { totalCost, usageByConsumer, recentTrends } = req.body

    const trendMap = new Map(Object.entries(recentTrends || {}))
    // @ts-expect-error - type mismatch handled at runtime
    const attribution = calculateCostAttribution(workspaceId, totalCost, usageByConsumer, trendMap)

    res.json({
      workspaceId,
      totalCost: `$${totalCost.toFixed(2)}`,
      breakdown: Object.entries(attribution.breakdown).map(([id, cost]) => ({
        identifier: id,
        cost: `$${(cost as number).toFixed(2)}`,
        percentage: `${(((cost as number) / totalCost) * 100).toFixed(1)}%`,
      })),
      topConsumers: attribution.topConsumers.slice(0, 10).map((c) => ({
        identifier: c.identifier,
        usage: c.usage,
        cost: `$${c.cost.toFixed(2)}`,
        trend: c.trend,
        percentage: `${c.percentageOfTotal.toFixed(1)}%`,
      })),
      lastUpdated: attribution.lastUpdated.toISOString(),
    })
  })
)

/**
 * GET /api/ops/analytics/costs/:workspaceId/breakdown
 * Get current cost attribution for workspace.
 */
phase47AnalyticsRouter.get(
  '/costs/:workspaceId/breakdown',
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params

    const attribution = getCostAttribution(workspaceId)

    if (!attribution) {
      return res.json({
        workspaceId,
        message: 'No cost attribution data available yet. Call /calculate to generate.',
      })
    }

    res.json({
      workspaceId,
      totalCost: `$${attribution.totalCost.toFixed(2)}`,
      breakdown: Object.entries(attribution.breakdown).map(([id, cost]) => ({
        identifier: id,
        cost: `$${(cost as number).toFixed(2)}`,
        percentage: `${(((cost as number) / attribution.totalCost) * 100).toFixed(1)}%`,
      })),
      topConsumers: attribution.topConsumers.slice(0, 10).map((c) => ({
        identifier: c.identifier,
        usage: c.usage,
        cost: `$${c.cost.toFixed(2)}`,
        trend: c.trend,
        percentage: `${c.percentageOfTotal.toFixed(1)}%`,
      })),
      lastUpdated: attribution.lastUpdated.toISOString(),
    })
  })
)

// ============================================================================
// Optimization Recommendations Endpoints
// ============================================================================

/**
 * POST /api/ops/analytics/optimizations/:workspaceId
 * Create a cost optimization recommendation.
 */
phase47AnalyticsRouter.post(
  '/optimizations/:workspaceId',
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params
    const { title, description, potentialSavings, priority, optimizationType, actionItems, implementationComplexity } =
      req.body

    const opt = createOptimization(
      workspaceId,
      title,
      description,
      potentialSavings,
      priority,
      optimizationType as OptimizationType,
      actionItems,
      implementationComplexity
    )

    res.json({
      success: true,
      optimization: {
        id: opt.id,
        title: opt.title,
        savings: `$${opt.potentialSavings}`,
        priority: opt.priority,
        estimatedROI: `${opt.estimatedROI}%`,
        complexity: opt.implementationComplexity,
      },
      message: 'Cost optimization recommendation created',
    })
  })
)

/**
 * GET /api/ops/analytics/optimizations/:workspaceId
 * Get optimization recommendations.
 */
phase47AnalyticsRouter.get(
  '/optimizations/:workspaceId',
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params
    const type = req.query.type as OptimizationType | undefined
    const limit = parseInt(req.query.limit as string) || 50

    const optList = getOptimizations(workspaceId, type, limit)

    res.json({
      workspaceId,
      count: optList.length,
      optimizations: optList.map((o) => ({
        id: o.id,
        title: o.title,
        description: o.description,
        savings: `$${o.potentialSavings}`,
        priority: o.priority,
        type: o.optimizationType,
        complexity: o.implementationComplexity,
        estimatedROI: `${o.estimatedROI}%`,
        actionItems: o.actionItems,
        implemented: o.implementedAt ? true : false,
        implementedAt: o.implementedAt?.toISOString(),
      })),
      summary: {
        totalPotentialSavings: `$${optList.reduce((sum, o) => sum + (o.implementedAt ? 0 : o.potentialSavings), 0)}`,
        implemented: optList.filter((o) => o.implementedAt).length,
        pending: optList.filter((o) => !o.implementedAt).length,
      },
    })
  })
)

/**
 * PUT /api/ops/analytics/optimizations/:workspaceId/:optimizationId
 * Mark optimization as implemented.
 */
phase47AnalyticsRouter.put(
  '/optimizations/:workspaceId/:optimizationId',
  asyncHandler(async (req, res) => {
    const { workspaceId, optimizationId } = req.params

    const success = markOptimizationImplemented(workspaceId, optimizationId)

    if (!success) {
      return res.status(404).json({ error: 'Optimization not found' })
    }

    res.json({
      success: true,
      message: 'Optimization marked as implemented',
    })
  })
)

// ============================================================================
// Capacity Planning Endpoints
// ============================================================================

/**
 * GET /api/ops/analytics/capacity/:workspaceId/:metricType
 * Forecast when quota will be exceeded.
 */
phase47AnalyticsRouter.get(
  '/capacity/:workspaceId/:metricType',
  asyncHandler(async (req, res) => {
    const { workspaceId, metricType } = req.params
    const { current, limit, dailyAverage, growthRate } = req.query

    const forecast = forecastQuotaExceeded(
      metricType as MetricType,
      parseInt(current as string),
      parseInt(limit as string),
      parseInt(dailyAverage as string),
      parseFloat(growthRate as string)
    )

    res.json({
      workspaceId,
      metricType: forecast.metricType,
      current: forecast.current,
      limit: forecast.limit,
      percentageUsed: `${((forecast.current / forecast.limit) * 100).toFixed(1)}%`,
      dailyGrowthRate: `${forecast.dailyGrowthRate.toFixed(1)}%`,
      daysUntilExceeded: forecast.daysUntilQuotaExceeded,
      projectedDate: forecast.projectedDateExceeded?.toISOString() || null,
      confidence: `${forecast.confidence}%`,
      recommendation: forecast.recommendation,
      urgency:
        forecast.daysUntilQuotaExceeded <= 7
          ? 'critical'
          : forecast.daysUntilQuotaExceeded <= 14
            ? 'high'
            : forecast.daysUntilQuotaExceeded <= 30
              ? 'medium'
              : 'low',
    })
  })
)

/**
 * GET /api/ops/analytics/recommendations/:workspaceId
 * Get optimization recommendations for workspace.
 */
phase47AnalyticsRouter.get(
  '/recommendations/:workspaceId',
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params
    const { patterns, topConsumers, totalCost } = req.query

    // Parse patterns from query string
    const patternsList = (patterns as string)
      ? (JSON.parse(patterns as string) as Array<{ metricType: string; dailyAverage: number; growthRate: number }>)
      : []

    const consumersList = (topConsumers as string)
      ? (JSON.parse(topConsumers as string) as Array<{ name: string; cost: number }>)
      : []

    const recommendations = getOptimizationRecommendations(
    // @ts-expect-error - type mismatch handled at runtime
      workspaceId,
    // @ts-expect-error - type mismatch handled at runtime
      patternsList,
      consumersList,
      parseFloat(totalCost as string) || 0
    )

    res.json({
      workspaceId,
      count: recommendations.length,
      recommendations,
    })
  })
)

// ============================================================================
// Analytics Summary Endpoint
// ============================================================================

/**
 * GET /api/ops/analytics/summary/:workspaceId
 * Get complete analytics summary for workspace.
 */
phase47AnalyticsRouter.get(
  '/summary/:workspaceId',
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params

    const anomalyList = getAnomalies(workspaceId, 10)
    const patterns = getPattern(workspaceId)
    const costAttr = getCostAttribution(workspaceId)
    const opts = getOptimizations(workspaceId, undefined, 5)

    const unresolvedAnomalies = anomalyList.filter((a) => !a.resolvedAt).length
    const pendingOptimizations = opts.filter((o) => !o.implementedAt)
    const totalPotentialSavings = pendingOptimizations.reduce((sum, o) => sum + o.potentialSavings, 0)

    res.json({
      workspaceId,
      anomalies: {
        total: unresolvedAnomalies,
        critical: anomalyList.filter((a) => a.severity === 'critical' && !a.resolvedAt).length,
        concerning: anomalyList.filter((a) => a.severity === 'concerning' && !a.resolvedAt).length,
      },
      patterns: {
        total: patterns.length,
        anomalousCount: patterns.filter((p) => p.classification !== 'normal').length,
        topPattern: patterns.length > 0 ? patterns[0] : null,
      },
      costs: costAttr
        ? {
            total: `$${costAttr.totalCost.toFixed(2)}`,
            topConsumer: costAttr.topConsumers[0]?.identifier || 'N/A',
            topConsumerCost: costAttr.topConsumers[0]?.cost || 0,
          }
        : null,
      optimizations: {
        pending: pendingOptimizations.length,
        totalPotentialSavings: `$${totalPotentialSavings.toFixed(2)}`,
        highPriority: pendingOptimizations.filter((o) => o.priority === 'critical' || o.priority === 'high').length,
      },
      status:
        unresolvedAnomalies > 0 && unresolvedAnomalies <= 2
          ? 'warning'
          : unresolvedAnomalies > 2
            ? 'alert'
            : 'healthy',
    })
  })
)
