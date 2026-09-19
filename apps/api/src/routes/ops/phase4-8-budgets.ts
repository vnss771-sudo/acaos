// Phase 4.8: Budget management and cost enforcement endpoints.

import { Router } from 'express'
import { asyncHandler } from '../../lib/http.js'
import {
  createBudget,
  getBudgets,
  updateBudget,
  deleteBudget,
  getBudgetStatus,
  getBudgetProjection,
  allocateTeamBudget,
  getTeamBudgetAllocation,
  recordEnforcementAction,
  getEnforcementHistory,
  createBudgetOverride,
  getActiveBudgetOverrides,
  isBudgetEnforced,
  recordDailySpending,
  getBudgetHistory,
  calculateBudgetVariance,
  getBudgetRecommendations,
  type EnforcementMode,
  type EnforcementAction,
  type BudgetPeriod,
} from '@acaos/backend-core/lib/budgetManagement.js'

export const phase48BudgetsRouter = Router()

// ============================================================================
// Budget Management Endpoints
// ============================================================================

/**
 * POST /api/ops/budgets/:workspaceId — Create a new budget.
 */
phase48BudgetsRouter.post(
  '/:workspaceId',
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params
    const {
      name,
      amount,
      period,
      enforcementMode = 'progressive',
      warningThresholds = [50, 75, 90],
      enforcementActions = ['warn', 'rate_limit', 'block_new'],
    } = req.body

    const budget = createBudget(
      workspaceId,
      name,
      amount,
      period as BudgetPeriod,
      enforcementMode as EnforcementMode,
      warningThresholds,
      enforcementActions as EnforcementAction[]
    )

    res.json({
      success: true,
      budget: {
        id: budget.id,
        name: budget.name,
        amount: `$${budget.amount}`,
        period: budget.period,
        enforcementMode: budget.enforcementMode,
        startDate: budget.startDate.toISOString(),
        endDate: budget.endDate.toISOString(),
      },
      message: 'Budget created successfully',
    })
  })
)

/**
 * GET /api/ops/budgets/:workspaceId — Get all budgets for workspace.
 */
phase48BudgetsRouter.get(
  '/:workspaceId',
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params
    const enabled = req.query.enabled ? req.query.enabled === 'true' : undefined

    const budgetList = getBudgets(workspaceId, enabled)

    res.json({
      workspaceId,
      count: budgetList.length,
      budgets: budgetList.map((b) => ({
        id: b.id,
        name: b.name,
        amount: `$${b.amount}`,
        period: b.period,
        enforcementMode: b.enforcementMode,
        enabled: b.enabled,
        startDate: b.startDate.toISOString(),
        endDate: b.endDate.toISOString(),
      })),
    })
  })
)

/**
 * PUT /api/ops/budgets/:workspaceId/:budgetId — Update budget.
 */
phase48BudgetsRouter.put(
  '/:workspaceId/:budgetId',
  asyncHandler(async (req, res) => {
    const { workspaceId, budgetId } = req.params
    const { name, amount, enforcementMode, warningThresholds, enforcementActions } = req.body

    const success = updateBudget(workspaceId, budgetId, {
      name,
      amount,
      enforcementMode: enforcementMode as EnforcementMode,
      warningThresholds,
      enforcementActions: enforcementActions as EnforcementAction[],
    })

    if (!success) {
      return res.status(404).json({ error: 'Budget not found' })
    }

    res.json({
      success: true,
      message: 'Budget updated',
    })
  })
)

/**
 * DELETE /api/ops/budgets/:workspaceId/:budgetId — Delete budget (soft delete).
 */
phase48BudgetsRouter.delete(
  '/:workspaceId/:budgetId',
  asyncHandler(async (req, res) => {
    const { workspaceId, budgetId } = req.params

    const success = deleteBudget(workspaceId, budgetId)

    if (!success) {
      return res.status(404).json({ error: 'Budget not found' })
    }

    res.json({
      success: true,
      message: 'Budget deleted',
    })
  })
)

// ============================================================================
// Budget Status Endpoints
// ============================================================================

/**
 * GET /api/ops/budgets/:workspaceId/:budgetId/status — Get budget status.
 */
phase48BudgetsRouter.get(
  '/:workspaceId/:budgetId/status',
  asyncHandler(async (req, res) => {
    const { budgetId } = req.params
    const currentSpent = parseFloat(req.query.spent as string) || 0

    const status = getBudgetStatus(budgetId, currentSpent)

    res.json({
      budgetId: status.budgetId,
      spent: `$${status.spent.toFixed(2)}`,
      percentageUsed: `${status.percentageUsed}%`,
      remaining: `$${status.remaining.toFixed(2)}`,
      burnRate: `$${status.burnRate.toFixed(2)}/day`,
      daysRemaining: status.daysRemaining,
      projectedTotal: `$${status.projectedTotal.toFixed(2)}`,
      status: status.status,
      enforcementActive: status.enforcementActive,
      activeEnforcements: status.activeEnforcements,
      lastEnforcementAt: status.lastEnforcementAt?.toISOString(),
    })
  })
)

/**
 * GET /api/ops/budgets/:workspaceId/:budgetId/projection — Get budget projection.
 */
phase48BudgetsRouter.get(
  '/:workspaceId/:budgetId/projection',
  asyncHandler(async (req, res) => {
    const { budgetId } = req.params
    const currentSpent = parseFloat(req.query.spent as string) || 0
    const dailyAverage = parseFloat(req.query.dailyAverage as string) || 0

    const projection = getBudgetProjection(budgetId, currentSpent, dailyAverage)

    res.json({
      budgetId,
      projectedTotal: `$${projection.projectedTotal.toFixed(2)}`,
      projectedOverage: `$${projection.projectedOverage.toFixed(2)}`,
      confidence: `${projection.confidence}%`,
      recommendation: projection.recommendation,
    })
  })
)

// ============================================================================
// Team Budget Allocation Endpoints
// ============================================================================

/**
 * POST /api/ops/budgets/:workspaceId/:budgetId/allocate-teams — Allocate to team.
 */
phase48BudgetsRouter.post(
  '/:workspaceId/:budgetId/allocate-teams',
  asyncHandler(async (req, res) => {
    const { budgetId } = req.params
    const { teamId, allocatedAmount } = req.body

    const allocation = allocateTeamBudget(budgetId, teamId, allocatedAmount)

    res.json({
      success: true,
      allocation: {
        budgetId,
        teamId,
        allocatedAmount: `$${allocatedAmount}`,
      },
      message: 'Team budget allocated',
    })
  })
)

/**
 * GET /api/ops/budgets/:workspaceId/:budgetId/team-breakdown — Get team allocations.
 */
phase48BudgetsRouter.get(
  '/:workspaceId/:budgetId/team-breakdown',
  asyncHandler(async (req, res) => {
    const { budgetId } = req.params

    const allocations = getTeamBudgetAllocation(budgetId)

    res.json({
      budgetId,
      count: allocations.length,
      allocations: allocations.map((a) => ({
        teamId: a.teamId,
        allocatedAmount: `$${a.allocatedAmount}`,
        spent: `$${a.spent}`,
        percentageUsed: `${a.percentageUsed}%`,
        status: a.status,
      })),
    })
  })
)

/**
 * GET /api/ops/budgets/:workspaceId/team/:teamId — Get team budget status.
 */
phase48BudgetsRouter.get(
  '/:workspaceId/team/:teamId',
  asyncHandler(async (req, res) => {
    const { workspaceId, teamId } = req.params

    const budgetList = getBudgets(workspaceId, true)
    const teamAllocations: Array<{
      budgetId: string
      budgetName: string
      allocatedAmount: number
      spent: number
      percentageUsed: number
      status: string
    }> = []

    for (const budget of budgetList) {
      const allocations = getTeamBudgetAllocation(budget.id, teamId)
      if (allocations.length > 0) {
        teamAllocations.push({
          budgetId: budget.id,
          budgetName: budget.name,
          allocatedAmount: allocations[0].allocatedAmount,
          spent: allocations[0].spent,
          percentageUsed: allocations[0].percentageUsed,
          status: allocations[0].status,
        })
      }
    }

    res.json({
      workspaceId,
      teamId,
      count: teamAllocations.length,
      allocations: teamAllocations,
    })
  })
)

// ============================================================================
// Enforcement Endpoints
// ============================================================================

/**
 * POST /api/ops/budgets/:workspaceId/:budgetId/enforce — Trigger enforcement action.
 */
phase48BudgetsRouter.post(
  '/:workspaceId/:budgetId/enforce',
  asyncHandler(async (req, res) => {
    const { workspaceId, budgetId } = req.params
    const { action, threshold, reason } = req.body

    const result = {
      success: true,
      message: `Enforcement action '${action}' triggered at ${threshold}% budget usage`,
    }

    recordEnforcementAction(budgetId, workspaceId, action, threshold, reason, result)

    res.json({
      success: true,
      enforcement: {
        action,
        threshold,
        message: result.message,
      },
    })
  })
)

/**
 * GET /api/ops/budgets/:workspaceId/:budgetId/enforcement-history — Get enforcement history.
 */
phase48BudgetsRouter.get(
  '/:workspaceId/:budgetId/enforcement-history',
  asyncHandler(async (req, res) => {
    const { budgetId } = req.params
    const limit = parseInt(req.query.limit as string) || 50

    const history = getEnforcementHistory(budgetId, limit)

    res.json({
      budgetId,
      count: history.length,
      events: history.map((e) => ({
        id: e.id,
        action: e.action,
        threshold: `${e.threshold}%`,
        reason: e.reason,
        success: e.result.success,
        message: e.result.message,
        createdAt: e.createdAt.toISOString(),
      })),
    })
  })
)

// ============================================================================
// Budget Override Endpoints
// ============================================================================

/**
 * POST /api/ops/budgets/:workspaceId/:budgetId/override — Create budget override.
 */
phase48BudgetsRouter.post(
  '/:workspaceId/:budgetId/override',
  asyncHandler(async (req, res) => {
    const { workspaceId, budgetId } = req.params
    const { approvedBy, reason, allowedOverage, durationDays = 7 } = req.body

    const override = createBudgetOverride(budgetId, workspaceId, approvedBy, reason, allowedOverage, durationDays)

    res.json({
      success: true,
      override: {
        id: override.id,
        approvedBy,
        reason,
        allowedOverage: `$${allowedOverage}`,
        expiresAt: override.expiresAt.toISOString(),
      },
      message: 'Budget override created',
    })
  })
)

/**
 * GET /api/ops/budgets/:workspaceId/:budgetId/overrides — Get active overrides.
 */
phase48BudgetsRouter.get(
  '/:workspaceId/:budgetId/overrides',
  asyncHandler(async (req, res) => {
    const { budgetId } = req.params

    const overrides = getActiveBudgetOverrides(budgetId)

    res.json({
      budgetId,
      count: overrides.length,
      overrides: overrides.map((o) => ({
        id: o.id,
        approvedBy: o.approvedBy,
        reason: o.reason,
        allowedOverage: `$${o.allowedOverage}`,
        createdAt: o.createdAt.toISOString(),
        expiresAt: o.expiresAt.toISOString(),
      })),
    })
  })
)

// ============================================================================
// Budget Analytics Endpoints
// ============================================================================

/**
 * POST /api/ops/budgets/:workspaceId/:budgetId/record-spending — Record daily spending.
 */
phase48BudgetsRouter.post(
  '/:workspaceId/:budgetId/record-spending',
  asyncHandler(async (req, res) => {
    const { budgetId } = req.params
    const { spent } = req.body

    recordDailySpending(budgetId, spent)

    res.json({
      success: true,
      message: 'Daily spending recorded',
    })
  })
)

/**
 * GET /api/ops/budgets/:workspaceId/:budgetId/history — Get spending history.
 */
phase48BudgetsRouter.get(
  '/:workspaceId/:budgetId/history',
  asyncHandler(async (req, res) => {
    const { budgetId } = req.params
    const days = parseInt(req.query.days as string) || 30

    const history = getBudgetHistory(budgetId, days)

    res.json({
      budgetId,
      days,
      count: history.length,
      history: history.map((h) => ({
        date: h.date.toISOString(),
        spent: `$${h.spent.toFixed(2)}`,
      })),
    })
  })
)

/**
 * GET /api/ops/budgets/:workspaceId/:budgetId/comparison — Budget vs actual.
 */
phase48BudgetsRouter.get(
  '/:workspaceId/:budgetId/comparison',
  asyncHandler(async (req, res) => {
    const { budgetId } = req.params
    const actualSpent = parseFloat(req.query.spent as string) || 0

    const budgetList = getBudgets(req.params.workspaceId, true)
    const budget = budgetList.find((b) => b.id === budgetId)

    if (!budget) {
      return res.status(404).json({ error: 'Budget not found' })
    }

    const variance = calculateBudgetVariance(budgetId, actualSpent, budget.amount)

    res.json({
      budgetId,
      budgetName: budget.name,
      budgetAmount: `$${budget.amount}`,
      actualSpent: `$${actualSpent}`,
      variance: `$${variance.variance}`,
      variancePercent: `${variance.variancePercent}%`,
      status: variance.status,
    })
  })
)

/**
 * GET /api/ops/budgets/:workspaceId/:budgetId/recommendations — Get recommendations.
 */
phase48BudgetsRouter.get(
  '/:workspaceId/:budgetId/recommendations',
  asyncHandler(async (req, res) => {
    const { budgetId } = req.params
    const currentSpent = parseFloat(req.query.spent as string) || 0

    const recommendations = getBudgetRecommendations(budgetId, currentSpent)

    res.json({
      budgetId,
      count: recommendations.length,
      recommendations,
    })
  })
)

/**
 * GET /api/ops/budgets/:workspaceId/summary — Budget summary for workspace.
 */
phase48BudgetsRouter.get(
  '/:workspaceId/summary',
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params

    const budgetList = getBudgets(workspaceId, true)
    const totalBudget = budgetList.reduce((sum, b) => sum + b.amount, 0)

    const budgets_ = budgetList.map((b) => {
      const status = getBudgetStatus(b.id, 0)
      return {
        id: b.id,
        name: b.name,
        amount: `$${b.amount}`,
        spent: `$${status.spent}`,
        percentageUsed: `${status.percentageUsed}%`,
        status: status.status,
      }
    })

    res.json({
      workspaceId,
      totalBudgets: budgetList.length,
      totalBudgetAmount: `$${totalBudget}`,
      budgets: budgets_,
      status:
        budgets_.some((b) => b.status === 'exceeded')
          ? 'critical'
          : budgets_.some((b) => b.status === 'alert')
            ? 'alert'
            : budgets_.some((b) => b.status === 'warning')
              ? 'warning'
              : 'healthy',
    })
  })
)

/**
 * GET /api/ops/budgets/:workspaceId/:budgetId/enforcement-check — Check if budget is enforced.
 */
phase48BudgetsRouter.get(
  '/:workspaceId/:budgetId/enforcement-check',
  asyncHandler(async (req, res) => {
    const { budgetId } = req.params
    const currentSpent = parseFloat(req.query.spent as string) || 0

    const isEnforced = isBudgetEnforced(budgetId, currentSpent)

    res.json({
      budgetId,
      currentSpent: `$${currentSpent}`,
      isEnforced,
      message: isEnforced ? 'Budget enforcement is active' : 'Budget enforcement is not active',
    })
  })
)
