// Phase 5: Advanced cost optimization and FinOps intelligence endpoints.

import { Router } from 'express'
import { asyncHandler } from '../../lib/http.js'
import {
  createOptimization,
  getOptimization,
  applyOptimization,
  rollbackOptimization,
  recordOptimizationImpact,
  getOptimizationImpactHistory,
  calculateOptimizationROI,
  getOptimizationSuggestions,
  getTotalPotentialSavings,
  initializeDefaultTemplates as initOptTemplates,
  type OptimizationType,
  type ApprovalLevel,
} from '@acaos/backend-core/lib/costOptimization.js'
import {
  recordCostHistory,
  getScenarios,
  whatIfAnalysis,
  getConfidenceLevel,
  forecastNextPeriod,
} from '@acaos/backend-core/lib/advancedForecasting.js'
import {
  tagResource,
  createAllocationRule,
  createChargebackPolicy,
  getCostAttribution,
  createInternalBill,
  getInternalBills,
  getCostBreakdownByDimension,
  type AllocationModel,
  type ResourceType,
} from '@acaos/backend-core/lib/costAllocation.js'
import {
  createAutomationRule,
  getAutomationRules,
  updateAutomationRule,
  disableAutomationRule,
  enableAutomationRule,
  triggerEvent,
  getRuleExecutionHistory,
  initializeDefaultTemplates as initRuleTemplates,
  type EventType,
} from '@acaos/backend-core/lib/customRules.js'

export const phase5OptimizationRouter = Router()

// ============================================================================
// Cost Optimization Endpoints
// ============================================================================

/**
 * POST /api/ops/optimization/:workspaceId/recommendations — Get optimization recommendations.
 */
phase5OptimizationRouter.post(
  '/:workspaceId/recommendations',
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params
    const { limit = 10 } = req.body

    const recommendations = getOptimizationSuggestions(workspaceId, limit)

    res.json({
      workspaceId,
      count: recommendations.length,
      totalPotentialSavings: `$${getTotalPotentialSavings(workspaceId).toFixed(2)}`,
      recommendations: recommendations.map((r) => ({
        id: r.id,
        type: r.type,
        title: r.title,
        description: r.description,
        estimatedMonthlySavings: `$${r.estimatedMonthlySavings.toFixed(2)}`,
        confidenceScore: `${r.confidenceScore}%`,
        difficulty: r.difficulty,
        implementationHours: r.estimatedImplementationHours,
        roi: `${(r.estimatedMonthlySavings / (r.estimatedImplementationHours || 1)).toFixed(2)}/hour`,
      })),
    })
  })
)

/**
 * POST /api/ops/optimization/:workspaceId — Create optimization recommendation.
 */
phase5OptimizationRouter.post(
  '/:workspaceId',
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params
    const {
      type,
      title,
      description,
      estimatedMonthlySavings,
      confidenceScore,
      difficulty,
      estimatedImplementationHours,
      approvalLevel = 'auto',
    } = req.body

    const optimization = createOptimization(
      workspaceId,
      type as OptimizationType,
      title,
      description,
      estimatedMonthlySavings,
      confidenceScore,
      difficulty,
      estimatedImplementationHours,
      approvalLevel as ApprovalLevel
    )

    res.json({
      success: true,
      optimization: {
        id: optimization.id,
        type: optimization.type,
        title: optimization.title,
        estimatedMonthlySavings: `$${optimization.estimatedMonthlySavings.toFixed(2)}`,
        status: optimization.status,
        createdAt: optimization.createdAt.toISOString(),
      },
      message: 'Optimization recommendation created',
    })
  })
)

/**
 * GET /api/ops/optimization/:workspaceId/:optimizationId — Get optimization details.
 */
phase5OptimizationRouter.get(
  '/:workspaceId/:optimizationId',
  asyncHandler(async (req, res) => {
    const { optimizationId } = req.params

    const optimization = getOptimization(optimizationId)

    if (!optimization) {
      return res.status(404).json({ error: 'Optimization not found' })
    }

    const roi = calculateOptimizationROI(optimizationId)

    res.json({
      id: optimization.id,
      type: optimization.type,
      title: optimization.title,
      description: optimization.description,
      estimatedMonthlySavings: `$${optimization.estimatedMonthlySavings.toFixed(2)}`,
      status: optimization.status,
      difficulty: optimization.difficulty,
      roi: {
        totalEstimatedSavings: `$${roi.totalEstimatedSavings.toFixed(2)}`,
        totalActualSavings: `$${roi.totalActualSavings.toFixed(2)}`,
        averageMonthlyROI: `$${roi.averageMonthlyROI.toFixed(2)}`,
      },
      approvedBy: optimization.approvedBy,
      appliedAt: optimization.appliedAt?.toISOString(),
      createdAt: optimization.createdAt.toISOString(),
    })
  })
)

/**
 * POST /api/ops/optimization/:workspaceId/:optimizationId/apply — Apply optimization.
 */
phase5OptimizationRouter.post(
  '/:workspaceId/:optimizationId/apply',
  asyncHandler(async (req, res) => {
    const { workspaceId, optimizationId } = req.params
    const { approvedBy, actualSavings = 0 } = req.body

    const success = applyOptimization(workspaceId, optimizationId, approvedBy, {
      success: true,
      actualSavings,
      message: 'Optimization applied successfully',
    })

    if (!success) {
      return res.status(404).json({ error: 'Optimization not found' })
    }

    res.json({
      success: true,
      message: 'Optimization applied',
      actualSavings: `$${actualSavings.toFixed(2)}`,
    })
  })
)

/**
 * POST /api/ops/optimization/:workspaceId/:optimizationId/rollback — Rollback optimization.
 */
phase5OptimizationRouter.post(
  '/:workspaceId/:optimizationId/rollback',
  asyncHandler(async (req, res) => {
    const { workspaceId, optimizationId } = req.params
    const { reason = 'Manual rollback' } = req.body

    const success = rollbackOptimization(workspaceId, optimizationId, reason)

    if (!success) {
      return res.status(404).json({ error: 'Optimization not found or not applied' })
    }

    res.json({
      success: true,
      message: 'Optimization rolled back',
    })
  })
)

/**
 * POST /api/ops/optimization/:workspaceId/:optimizationId/impact — Record optimization impact.
 */
phase5OptimizationRouter.post(
  '/:workspaceId/:optimizationId/impact',
  asyncHandler(async (req, res) => {
    const { optimizationId } = req.params
    const { estimatedCost, actualCost } = req.body

    const impact = recordOptimizationImpact(optimizationId, estimatedCost, actualCost)

    res.json({
      success: true,
      impact: {
        estimatedCost: `$${impact.estimatedCost.toFixed(2)}`,
        actualCost: `$${impact.actualCost.toFixed(2)}`,
        savingsAchieved: `$${impact.savingsAchieved.toFixed(2)}`,
        status: impact.status,
        date: impact.date.toISOString(),
      },
    })
  })
)

/**
 * GET /api/ops/optimization/:workspaceId/:optimizationId/history — Get impact history.
 */
phase5OptimizationRouter.get(
  '/:workspaceId/:optimizationId/history',
  asyncHandler(async (req, res) => {
    const { optimizationId } = req.params
    const { days = 30 } = req.query

    const history = getOptimizationImpactHistory(optimizationId, parseInt(days as string))

    res.json({
      optimizationId,
      count: history.length,
      days: parseInt(days as string),
      history: history.map((h) => ({
        date: h.date.toISOString(),
        estimatedCost: `$${h.estimatedCost.toFixed(2)}`,
        actualCost: `$${h.actualCost.toFixed(2)}`,
        savingsAchieved: `$${h.savingsAchieved.toFixed(2)}`,
        status: h.status,
      })),
    })
  })
)

// ============================================================================
// Advanced Forecasting Endpoints
// ============================================================================

/**
 * POST /api/ops/optimization/:workspaceId/cost-history — Record cost history.
 */
phase5OptimizationRouter.post(
  '/:workspaceId/cost-history',
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params
    const { cost, usageMetric } = req.body

    recordCostHistory(workspaceId, cost, usageMetric)

    res.json({
      success: true,
      message: 'Cost history recorded',
    })
  })
)

/**
 * GET /api/ops/optimization/:workspaceId/forecast — Forecast cost.
 */
phase5OptimizationRouter.get(
  '/:workspaceId/forecast',
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params
    const { daysAhead = 30 } = req.query

    const forecast = forecastNextPeriod(workspaceId, parseInt(daysAhead as string))
    const confidence = getConfidenceLevel(workspaceId)

    res.json({
      workspaceId,
      daysAhead: parseInt(daysAhead as string),
      model: forecast.model,
      projectedCost: `$${forecast.projectedCost.toFixed(2)}`,
      confidenceInterval: {
        lower: `$${forecast.confidenceInterval.lower.toFixed(2)}`,
        upper: `$${forecast.confidenceInterval.upper.toFixed(2)}`,
      },
      trendDirection: forecast.trendDirection,
      volatility: `$${forecast.volatility.toFixed(2)}`,
      accuracy: `${forecast.accuracy}%`,
      dataQuality: {
        dataPoints: confidence.dataPoints,
        daysCovered: confidence.daysCovered,
        confidence: `${confidence.confidence}%`,
        recommendation: confidence.recommendation,
      },
    })
  })
)

/**
 * POST /api/ops/optimization/:workspaceId/scenarios/plan-upgrade — Scenario: plan upgrade.
 */
phase5OptimizationRouter.post(
  '/:workspaceId/scenarios/plan-upgrade',
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params
    const { fromTier, toTier, currentCost } = req.body

    const scenario = scenarioPlanUpgrade(workspaceId, fromTier, toTier, currentCost)

    res.json({
      success: true,
      scenario: {
        id: scenario.id,
        name: scenario.name,
        costImpact: `$${scenario.costImpact.toFixed(2)}`,
        impactPercentage: `${scenario.impactPercentage.toFixed(1)}%`,
        projectedCost: `$${scenario.projectedCost.toFixed(2)}`,
        confidence: `${scenario.confidence}%`,
      },
    })
  })
)

/**
 * POST /api/ops/optimization/:workspaceId/scenarios/user-growth — Scenario: user growth.
 */
phase5OptimizationRouter.post(
  '/:workspaceId/scenarios/user-growth',
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params
    const { currentUsers, targetUsers, costPerUser, currentCost } = req.body

    const scenario = scenarioUserGrowth(
      workspaceId,
      currentUsers,
      targetUsers,
      costPerUser,
      currentCost
    )

    res.json({
      success: true,
      scenario: {
        id: scenario.id,
        name: scenario.name,
        costImpact: `$${scenario.costImpact.toFixed(2)}`,
        projectedCost: `$${scenario.projectedCost.toFixed(2)}`,
      },
    })
  })
)

/**
 * POST /api/ops/optimization/:workspaceId/what-if — What-if analysis.
 */
phase5OptimizationRouter.post(
  '/:workspaceId/what-if',
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params
    const { baseCost, changes } = req.body

    const result = whatIfAnalysis(baseCost, changes)

    res.json({
      baseCost: `$${result.baseCost.toFixed(2)}`,
      projectedCost: `$${result.projectedCost.toFixed(2)}`,
      totalImpact: `$${result.totalImpact.toFixed(2)}`,
      impactPercentage: `${((result.totalImpact / result.baseCost) * 100).toFixed(1)}%`,
      breakdown: result.impactByChange.map((c) => ({
        type: c.type,
        impact: `$${c.impact.toFixed(2)}`,
      })),
    })
  })
)

/**
 * GET /api/ops/optimization/:workspaceId/scenarios — Get scenarios.
 */
phase5OptimizationRouter.get(
  '/:workspaceId/scenarios',
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params

    const scenarios = getScenarios(workspaceId)

    res.json({
      workspaceId,
      count: scenarios.length,
      scenarios: scenarios.map((s) => ({
        id: s.id,
        name: s.name,
        type: s.type,
        costImpact: `$${s.costImpact.toFixed(2)}`,
        projectedCost: `$${s.projectedCost.toFixed(2)}`,
        confidence: `${s.confidence}%`,
      })),
    })
  })
)

// ============================================================================
// Cost Allocation Endpoints
// ============================================================================

/**
 * POST /api/ops/optimization/:workspaceId/resources/tag — Tag a resource.
 */
phase5OptimizationRouter.post(
  '/:workspaceId/resources/tag',
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params
    const { resourceId, resourceType, key, value } = req.body

    const tag = tagResource(workspaceId, resourceId, resourceType as ResourceType, key, value)

    res.json({
      success: true,
      tag: {
        resourceId: tag.resourceId,
        resourceType: tag.resourceType,
        key: tag.key,
        value: tag.value,
      },
      message: 'Resource tagged',
    })
  })
)

/**
 * POST /api/ops/optimization/:workspaceId/allocation-rules — Create allocation rule.
 */
phase5OptimizationRouter.post(
  '/:workspaceId/allocation-rules',
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params
    const { name, model, fromCostCenter, toCostCenters, conditions } = req.body

    const rule = createAllocationRule(
      workspaceId,
      name,
      model as AllocationModel,
      fromCostCenter,
      toCostCenters,
      conditions
    )

    res.json({
      success: true,
      rule: {
        id: rule.id,
        name: rule.name,
        model: rule.model,
        fromCostCenter: rule.fromCostCenter,
        toCostCentersCount: rule.toCostCenters.length,
      },
      message: 'Allocation rule created',
    })
  })
)

/**
 * GET /api/ops/optimization/:workspaceId/cost-attribution/:costCenter — Get cost attribution.
 */
phase5OptimizationRouter.get(
  '/:workspaceId/cost-attribution/:costCenter',
  asyncHandler(async (req, res) => {
    const { costCenter } = req.params

    const attribution = getCostAttribution(req.params.workspaceId, costCenter)

    if (!attribution) {
      return res.status(404).json({ error: 'Cost attribution not found' })
    }

    res.json({
      costCenter: attribution.costCenter,
      totalCost: `$${attribution.totalCost.toFixed(2)}`,
      chargedAmount: `$${attribution.chargedAmount.toFixed(2)}`,
      breakdown: attribution.breakdown.map((b) => ({
        resourceType: b.resourceType,
        cost: `$${b.cost.toFixed(2)}`,
        percentage: `${b.percentage.toFixed(1)}%`,
      })),
      lastUpdated: attribution.lastUpdated.toISOString(),
    })
  })
)

/**
 * POST /api/ops/optimization/:workspaceId/internal-bills — Create internal bill.
 */
phase5OptimizationRouter.post(
  '/:workspaceId/internal-bills',
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params
    const { costCenter, period, lineItems } = req.body

    const bill = createInternalBill(workspaceId, costCenter, period, lineItems)

    res.json({
      success: true,
      bill: {
        billId: bill.billId,
        costCenter: bill.costCenter,
        period: bill.period,
        totalCost: `$${bill.totalCost.toFixed(2)}`,
        chargedAmount: `$${bill.chargedAmount.toFixed(2)}`,
        lineItemCount: bill.lineItems.length,
      },
      message: 'Internal bill created',
    })
  })
)

/**
 * GET /api/ops/optimization/:workspaceId/internal-bills/:costCenter — Get bills.
 */
phase5OptimizationRouter.get(
  '/:workspaceId/internal-bills/:costCenter',
  asyncHandler(async (req, res) => {
    const { workspaceId, costCenter } = req.params
    const { limit = 12 } = req.query

    const bills = getInternalBills(workspaceId, costCenter, parseInt(limit as string))

    res.json({
      costCenter,
      count: bills.length,
      bills: bills.map((b) => ({
        billId: b.billId,
        period: b.period,
        totalCost: `$${b.totalCost.toFixed(2)}`,
        chargedAmount: `$${b.chargedAmount.toFixed(2)}`,
        lineItemCount: b.lineItems.length,
        createdAt: b.createdAt.toISOString(),
      })),
    })
  })
)

/**
 * GET /api/ops/optimization/:workspaceId/cost-breakdown/:dimension — Get cost breakdown by dimension.
 */
phase5OptimizationRouter.get(
  '/:workspaceId/cost-breakdown/:dimension',
  asyncHandler(async (req, res) => {
    const { workspaceId, dimension } = req.params

    const breakdown = getCostBreakdownByDimension(workspaceId, dimension)

    res.json({
      workspaceId,
      dimension,
      count: breakdown.length,
      breakdown: breakdown.map((b) => ({
        dimensionValue: b.dimensionValue,
        cost: `$${b.cost.toFixed(2)}`,
        percentage: `${b.percentage.toFixed(1)}%`,
      })),
    })
  })
)

// ============================================================================
// Custom Rules & Automation Endpoints
// ============================================================================

/**
 * POST /api/ops/optimization/:workspaceId/rules — Create automation rule.
 */
phase5OptimizationRouter.post(
  '/:workspaceId/rules',
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params
    const { name, description, eventType, conditions, actions, priority = 5 } = req.body

    const rule = createAutomationRule(
      workspaceId,
      name,
      description,
      eventType as EventType,
      conditions,
      actions,
      priority
    )

    res.json({
      success: true,
      rule: {
        id: rule.id,
        name: rule.name,
        eventType: rule.trigger.eventType,
        enabled: rule.enabled,
        priority: rule.priority,
        conditionCount: rule.trigger.conditions.length,
        actionCount: rule.actions.length,
      },
      message: 'Automation rule created',
    })
  })
)

/**
 * GET /api/ops/optimization/:workspaceId/rules — Get automation rules.
 */
phase5OptimizationRouter.get(
  '/:workspaceId/rules',
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params
    const { enabled } = req.query

    const rules = getAutomationRules(workspaceId, enabled === 'true' ? true : undefined)

    res.json({
      workspaceId,
      count: rules.length,
      rules: rules.map((r) => ({
        id: r.id,
        name: r.name,
        eventType: r.trigger.eventType,
        enabled: r.enabled,
        priority: r.priority,
        actionCount: r.actions.length,
        createdAt: r.createdAt.toISOString(),
      })),
    })
  })
)

/**
 * PUT /api/ops/optimization/:workspaceId/rules/:ruleId — Update automation rule.
 */
phase5OptimizationRouter.put(
  '/:workspaceId/rules/:ruleId',
  asyncHandler(async (req, res) => {
    const { workspaceId, ruleId } = req.params
    const { name, description, conditions, actions, priority } = req.body

    const success = updateAutomationRule(workspaceId, ruleId, {
      name,
      description,
      trigger: { eventType: undefined as any, conditions },
      actions,
      priority,
    })

    if (!success) {
      return res.status(404).json({ error: 'Rule not found' })
    }

    res.json({
      success: true,
      message: 'Rule updated',
    })
  })
)

/**
 * POST /api/ops/optimization/:workspaceId/rules/:ruleId/enable — Enable rule.
 */
phase5OptimizationRouter.post(
  '/:workspaceId/rules/:ruleId/enable',
  asyncHandler(async (req, res) => {
    const { workspaceId, ruleId } = req.params

    const success = enableAutomationRule(workspaceId, ruleId)

    if (!success) {
      return res.status(404).json({ error: 'Rule not found' })
    }

    res.json({
      success: true,
      message: 'Rule enabled',
    })
  })
)

/**
 * POST /api/ops/optimization/:workspaceId/rules/:ruleId/disable — Disable rule.
 */
phase5OptimizationRouter.post(
  '/:workspaceId/rules/:ruleId/disable',
  asyncHandler(async (req, res) => {
    const { workspaceId, ruleId } = req.params

    const success = disableAutomationRule(workspaceId, ruleId)

    if (!success) {
      return res.status(404).json({ error: 'Rule not found' })
    }

    res.json({
      success: true,
      message: 'Rule disabled',
    })
  })
)

/**
 * POST /api/ops/optimization/:workspaceId/events/trigger — Trigger event.
 */
phase5OptimizationRouter.post(
  '/:workspaceId/events/trigger',
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params
    const { eventType, eventData } = req.body

    const executions = triggerEvent(workspaceId, eventType as EventType, eventData)

    res.json({
      success: true,
      eventType,
      rulesTriggered: executions.length,
      executions: executions.map((e) => ({
        ruleId: e.ruleId,
        actionsExecuted: e.actionsExecuted.length,
        success: e.actionsExecuted.every((a) => a.success),
      })),
    })
  })
)

/**
 * GET /api/ops/optimization/:workspaceId/rules/executions — Get rule execution history.
 */
phase5OptimizationRouter.get(
  '/:workspaceId/rules/executions',
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params
    const { days = 30, limit = 50 } = req.query

    const executions = getRuleExecutionHistory(workspaceId, parseInt(days as string))

    res.json({
      workspaceId,
      count: executions.slice(0, parseInt(limit as string)).length,
      days: parseInt(days as string),
      executions: executions
        .slice(0, parseInt(limit as string))
        .map((e) => ({
          id: e.id,
          ruleId: e.ruleId,
          eventType: e.eventType,
          triggeredAt: e.triggeredAt.toISOString(),
          conditionsMet: e.conditionsMet,
          actionsExecuted: e.actionsExecuted.length,
          success: e.actionsExecuted.every((a) => a.success),
        })),
    })
  })
)

// ============================================================================
// Initialization Endpoints
// ============================================================================

/**
 * POST /api/ops/optimization/initialize — Initialize Phase 5 templates.
 */
phase5OptimizationRouter.post(
  '/initialize',
  asyncHandler(async (req, res) => {
    initOptTemplates()
    initRuleTemplates()

    res.json({
      success: true,
      message: 'Phase 5 templates and rules initialized',
    })
  })
)
