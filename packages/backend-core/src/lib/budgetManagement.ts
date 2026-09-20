// Phase 4.8: Budget management and cost enforcement.
// Tracks $ budgets per workspace with progressive enforcement and team allocation.

import { logger } from './logger.js'

export type EnforcementMode = 'soft' | 'hard' | 'progressive'
export type EnforcementAction = 'warn' | 'suggest_optimize' | 'rate_limit' | 'queue_excess' | 'disable_feature' | 'block_new' | 'create_ticket'
export type BudgetStatus = 'healthy' | 'warning' | 'alert' | 'exceeded' | 'critical'
export type BudgetPeriod = 'monthly' | 'quarterly' | 'annual'

export interface Budget {
  id: string
  workspaceId: string
  name: string
  amount: number // $ limit
  period: BudgetPeriod
  enforcementMode: EnforcementMode
  warningThresholds: number[] // [50, 75, 90]
  enforcementActions: EnforcementAction[]
  startDate: Date
  endDate: Date
  enabled: boolean
  createdAt: Date
  updatedAt: Date
}

export interface BudgetStatusInfo {
  budgetId: string
  spent: number
  percentageUsed: number
  remaining: number
  burnRate: number // $ per day
  daysRemaining: number
  projectedTotal: number
  status: BudgetStatus
  enforcementActive: boolean
  activeEnforcements: EnforcementAction[]
  lastEnforcementAt?: Date
}

export interface TeamBudgetAllocation {
  budgetId: string
  teamId: string
  allocatedAmount: number
  spent: number
  percentageUsed: number
  status: BudgetStatus
}

export interface EnforcementEvent {
  id: string
  budgetId: string
  workspaceId: string
  action: EnforcementAction
  threshold: number // % of budget when triggered
  reason: string
  result: { success: boolean; message: string }
  createdAt: Date
}

export interface BudgetOverride {
  id: string
  budgetId: string
  workspaceId: string
  approvedBy: string
  reason: string
  allowedOverage: number // amount allowed to exceed budget
  createdAt: Date
  expiresAt: Date
}

// Storage (would be DB in production)
const budgets = new Map<string, Budget[]>()
const budgetHistoryData = new Map<string, Array<{ date: Date; spent: number }>>()
const teamAllocations = new Map<string, TeamBudgetAllocation[]>()
const enforcementEvents = new Map<string, EnforcementEvent[]>()
const budgetOverrides = new Map<string, BudgetOverride[]>()
const MAX_EVENTS = 10000

/**
 * Create a budget for a workspace.
 */
export function createBudget(
  workspaceId: string,
  name: string,
  amount: number,
  period: BudgetPeriod,
  enforcementMode: EnforcementMode = 'progressive',
  warningThresholds: number[] = [50, 75, 90],
  enforcementActions: EnforcementAction[] = ['warn', 'rate_limit', 'block_new']
): Budget {
  const now = new Date()
  const endDate = new Date(now)

  if (period === 'monthly') {
    endDate.setMonth(endDate.getMonth() + 1)
  } else if (period === 'quarterly') {
    endDate.setMonth(endDate.getMonth() + 3)
  } else if (period === 'annual') {
    endDate.setFullYear(endDate.getFullYear() + 1)
  }

  const budget: Budget = {
    id: `budget-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    workspaceId,
    name,
    amount,
    period,
    enforcementMode,
    warningThresholds: warningThresholds.sort((a, b) => a - b),
    enforcementActions,
    startDate: now,
    endDate,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  }

  const list = budgets.get(workspaceId) || []
  list.push(budget)
  budgets.set(workspaceId, list)

  // Initialize history
  budgetHistoryData.set(budget.id, [{ date: now, spent: 0 }])

  logger.info('budget created', {
    workspaceId,
    budgetId: budget.id,
    name,
    amount,
    period,
  })

  return budget
}

/**
 * Get budgets for a workspace.
 */
export function getBudgets(workspaceId: string, enabled?: boolean): Budget[] {
  let list = budgets.get(workspaceId) || []
  if (enabled !== undefined) {
    list = list.filter((b) => b.enabled === enabled)
  }
  return list
}

/**
 * Update a budget.
 */
export function updateBudget(workspaceId: string, budgetId: string, updates: Partial<Budget>): boolean {
  const list = budgets.get(workspaceId)
  if (!list) return false

  const idx = list.findIndex((b) => b.id === budgetId)
  if (idx < 0) return false

  const budget = list[idx]
  Object.assign(budget, updates, { updatedAt: new Date() })
  return true
}

/**
 * Delete a budget (soft delete).
 */
export function deleteBudget(workspaceId: string, budgetId: string): boolean {
  return updateBudget(workspaceId, budgetId, { enabled: false })
}

/**
 * Get current budget status.
 */
export function getBudgetStatus(budgetId: string, currentSpent: number): BudgetStatusInfo {
  // Find budget by ID across all workspaces
  let budget: Budget | undefined
  for (const list of budgets.values()) {
    budget = list.find((b) => b.id === budgetId)
    if (budget) break
  }

  if (!budget) {
    return {
      budgetId,
      spent: 0,
      percentageUsed: 0,
      remaining: 0,
      burnRate: 0,
      daysRemaining: 0,
      projectedTotal: 0,
      status: 'healthy',
      enforcementActive: false,
      activeEnforcements: [],
    }
  }

  const now = new Date()
  const percentageUsed = (currentSpent / budget.amount) * 100
  const remaining = Math.max(0, budget.amount - currentSpent)

  // Calculate burn rate
  const totalDays = (budget.endDate.getTime() - budget.startDate.getTime()) / (24 * 60 * 60 * 1000)
  const elapsedDays = (now.getTime() - budget.startDate.getTime()) / (24 * 60 * 60 * 1000)
  const burnRate = elapsedDays > 0 ? currentSpent / elapsedDays : 0
  const daysRemaining = Math.max(0, totalDays - elapsedDays)

  // Project end-of-period spending
  const projectedTotal = burnRate * totalDays

  // Determine status and active enforcements
  let status: BudgetStatus = 'healthy'
  const activeEnforcements: EnforcementAction[] = []

  if (percentageUsed >= 100) {
    status = 'exceeded'
    activeEnforcements.push('block_new', 'create_ticket')
  } else if (percentageUsed >= 90) {
    status = 'critical'
    activeEnforcements.push('rate_limit', 'create_ticket')
  } else if (percentageUsed >= 75) {
    status = 'alert'
    activeEnforcements.push('rate_limit')
  } else if (percentageUsed >= 50) {
    status = 'warning'
    activeEnforcements.push('warn', 'suggest_optimize')
  }

  return {
    budgetId,
    spent: currentSpent,
    percentageUsed: Math.round(percentageUsed * 100) / 100,
    remaining,
    burnRate: Math.round(burnRate * 100) / 100,
    daysRemaining: Math.round(daysRemaining),
    projectedTotal: Math.round(projectedTotal * 100) / 100,
    status,
    enforcementActive: percentageUsed >= 50,
    activeEnforcements: Array.from(new Set(activeEnforcements)), // dedup
  }
}

/**
 * Get budget projection (what will we spend by end of period?).
 */
export function getBudgetProjection(budgetId: string, currentSpent: number, dailyAverage: number): {
  projectedTotal: number
  projectedOverage: number
  confidence: number
  recommendation: string
} {
  // Find budget
  let budget: Budget | undefined
  for (const list of budgets.values()) {
    budget = list.find((b) => b.id === budgetId)
    if (budget) break
  }

  if (!budget) {
    return {
      projectedTotal: 0,
      projectedOverage: 0,
      confidence: 0,
      recommendation: 'Budget not found',
    }
  }

  const now = new Date()
  const totalDays = (budget.endDate.getTime() - budget.startDate.getTime()) / (24 * 60 * 60 * 1000)
  const elapsedDays = (now.getTime() - budget.startDate.getTime()) / (24 * 60 * 60 * 1000)
  const remainingDays = totalDays - elapsedDays

  const projectedTotal = currentSpent + dailyAverage * remainingDays
  const projectedOverage = Math.max(0, projectedTotal - budget.amount)

  // Confidence based on how far into period we are
  const confidence = Math.min(95, (elapsedDays / totalDays) * 100)

  let recommendation = ''
  if (projectedOverage === 0) {
    recommendation = `On track. Projected to spend $${projectedTotal.toFixed(0)} of $${budget.amount.toFixed(0)} budget.`
  } else {
    recommendation = `WARNING: Projected to exceed budget by $${projectedOverage.toFixed(0)}. Consider reducing costs or requesting budget increase.`
  }

  return {
    projectedTotal: Math.round(projectedTotal * 100) / 100,
    projectedOverage: Math.round(projectedOverage * 100) / 100,
    confidence: Math.round(confidence),
    recommendation,
  }
}

/**
 * Allocate portion of budget to a team.
 */
export function allocateTeamBudget(budgetId: string, teamId: string, allocatedAmount: number): TeamBudgetAllocation {
  const allocation: TeamBudgetAllocation = {
    budgetId,
    teamId,
    allocatedAmount,
    spent: 0,
    percentageUsed: 0,
    status: 'healthy',
  }

  const list = teamAllocations.get(budgetId) || []
  const existing = list.findIndex((a) => a.teamId === teamId)

  if (existing >= 0) {
    list[existing] = allocation
  } else {
    list.push(allocation)
  }

  teamAllocations.set(budgetId, list)

  logger.info('team budget allocated', {
    budgetId,
    teamId,
    amount: allocatedAmount,
  })

  return allocation
}

/**
 * Get team budget allocation.
 */
export function getTeamBudgetAllocation(budgetId: string, teamId?: string): TeamBudgetAllocation[] {
  const list = teamAllocations.get(budgetId) || []
  if (teamId) {
    return list.filter((a) => a.teamId === teamId)
  }
  return list
}

/**
 * Record enforcement action.
 */
export function recordEnforcementAction(
  budgetId: string,
  workspaceId: string,
  action: EnforcementAction,
  threshold: number,
  reason: string,
  result: { success: boolean; message: string }
): EnforcementEvent {
  const event: EnforcementEvent = {
    id: `enforce-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    budgetId,
    workspaceId,
    action,
    threshold,
    reason,
    result,
    createdAt: new Date(),
  }

  const list = enforcementEvents.get(budgetId) || []
  list.push(event)
  enforcementEvents.set(budgetId, list)

  if (list.length > MAX_EVENTS) {
    list.splice(0, list.length - 5000)
  }

  logger.info('enforcement action recorded', {
    budgetId,
    action,
    threshold,
    success: result.success,
  })

  return event
}

/**
 * Get enforcement history for budget.
 */
export function getEnforcementHistory(budgetId: string, limit: number = 50): EnforcementEvent[] {
  const list = enforcementEvents.get(budgetId) || []
  return list.slice(-limit).reverse()
}

/**
 * Create budget override (allow exceeding budget).
 */
export function createBudgetOverride(
  budgetId: string,
  workspaceId: string,
  approvedBy: string,
  reason: string,
  allowedOverage: number,
  durationDays: number = 7
): BudgetOverride {
  const override: BudgetOverride = {
    id: `override-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    budgetId,
    workspaceId,
    approvedBy,
    reason,
    allowedOverage,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000),
  }

  const list = budgetOverrides.get(budgetId) || []
  list.push(override)
  budgetOverrides.set(budgetId, list)

  logger.info('budget override created', {
    budgetId,
    approvedBy,
    allowedOverage,
    expiresAt: override.expiresAt.toISOString(),
  })

  return override
}

/**
 * Get active budget overrides.
 */
export function getActiveBudgetOverrides(budgetId: string): BudgetOverride[] {
  const list = budgetOverrides.get(budgetId) || []
  const now = new Date()
  return list.filter((o) => o.expiresAt > now)
}

/**
 * Check if budget spending is allowed (considering overrides).
 */
export function isBudgetEnforced(budgetId: string, currentSpent: number): boolean {
  // Find budget
  let budget: Budget | undefined
  for (const list of budgets.values()) {
    budget = list.find((b) => b.id === budgetId)
    if (budget) break
  }

  if (!budget || !budget.enabled) {
    return false
  }

  // Check if currently at/over hard limit
  if (currentSpent < budget.amount) {
    return false
  }

  // Check if there's an active override
  const overrides = getActiveBudgetOverrides(budgetId)
  const totalOverageAllowed = overrides.reduce((sum, o) => sum + o.allowedOverage, 0)

  return currentSpent > budget.amount + totalOverageAllowed
}

/**
 * Record daily spending for history.
 */
export function recordDailySpending(budgetId: string, spent: number): void {
  const history = budgetHistoryData.get(budgetId) || []
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const existingIndex = history.findIndex((h) => h.date.getTime() === today.getTime())

  if (existingIndex >= 0) {
    history[existingIndex].spent = spent
  } else {
    history.push({ date: today, spent })
  }

  budgetHistoryData.set(budgetId, history)
}

/**
 * Get budget spending history.
 */
export function getBudgetHistory(budgetId: string, days: number = 30): Array<{ date: Date; spent: number }> {
  const history = budgetHistoryData.get(budgetId) || []
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - days)

  return history.filter((h) => h.date >= cutoff)
}

/**
 * Calculate budget variance (projected vs actual).
 */
export function calculateBudgetVariance(budgetId: string, actualSpent: number, budgetedAmount: number): {
  variance: number
  variancePercent: number
  status: 'under_budget' | 'on_budget' | 'over_budget'
} {
  const variance = actualSpent - budgetedAmount
  const variancePercent = (variance / budgetedAmount) * 100

  let status: 'under_budget' | 'on_budget' | 'over_budget' = 'on_budget'
  if (variance < -50) {
    status = 'under_budget'
  } else if (variance > 50) {
    status = 'over_budget'
  }

  return {
    variance: Math.round(variance * 100) / 100,
    variancePercent: Math.round(variancePercent * 100) / 100,
    status,
  }
}

/**
 * Get budget recommendations based on historical spending.
 */
export function getBudgetRecommendations(budgetId: string, currentSpent: number): string[] {
  const recommendations: string[] = []

  const history = getBudgetHistory(budgetId, 30)
  if (history.length > 0) {
    const avgDailySpend = history.reduce((sum, h) => sum + h.spent, 0) / history.length
    const trend = history[history.length - 1].spent - history[0].spent

    if (trend > avgDailySpend * 0.2) {
      recommendations.push('Spending is trending upward. Consider investigating cost drivers.')
    }

    if (avgDailySpend > 50) {
      recommendations.push('Daily spending is high. Review top consumers and optimization opportunities.')
    }
  }

  // Find budget to get threshold info
  let budget: Budget | undefined
  for (const list of budgets.values()) {
    budget = list.find((b) => b.id === budgetId)
    if (budget) break
  }

  if (budget) {
    const percentUsed = (currentSpent / budget.amount) * 100
    if (percentUsed > 75) {
      recommendations.push('At 75%+ of budget. Recommend implementing cost controls or requesting budget increase.')
    }
  }

  return recommendations
}

/**
 * Clear budget data (for testing).
 */
export function clearBudgets(): void {
  budgets.clear()
  budgetHistoryData.clear()
  teamAllocations.clear()
  enforcementEvents.clear()
  budgetOverrides.clear()
}
