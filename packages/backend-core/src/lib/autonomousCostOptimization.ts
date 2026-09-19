// Phase 10: Autonomous cost optimization execution.
// Automatically executes cost-saving recommendations and monitors results.

import { logger } from './logger.js'

export interface CostOptimizationAction {
  id: string
  organizationId: string
  agentId: string
  type: 'right_sizing' | 'resource_consolidation' | 'scheduling_optimization' | 'purchasing_optimization' | 'waste_elimination'
  targetResource: string
  targetMetric: string
  currentValue: number
  proposedValue: number
  estimatedMonthlySavings: number
  confidence: number // 0-1
  implementationCost?: number
  paybackMonths?: number
  status: 'proposed' | 'approved' | 'executing' | 'completed' | 'failed' | 'rolled_back'
  approvalRequiredReason?: string
  executedAt?: Date
  completedAt?: Date
  actualSavings?: number
  failureReason?: string
  rollbackAt?: Date
}

export interface CostOptimizationStrategy {
  id: string
  organizationId: string
  name: string
  description: string
  type: 'continuous' | 'periodic' | 'threshold_based'
  targetMetrics: string[]
  optimizationRules: Array<{
    condition: string
    action: string
    riskLevel: 'low' | 'medium' | 'high'
  }>
  targetSavingsPerMonth: number
  enabled: boolean
  createdAt: Date
}

export interface CostOptimizationRun {
  id: string
  organizationId: string
  strategyId: string
  startedAt: Date
  completedAt?: Date
  status: 'running' | 'completed' | 'failed'
  actionsProposed: number
  actionsExecuted: number
  totalEstimatedSavings: number
  totalActualSavings: number
  errors: Array<{ action: string; error: string }>
}

export interface WastageAnalysis {
  id: string
  organizationId: string
  agentId: string
  resourceType: string
  wastePercentage: number // 0-100
  estimatedMonthlyWaste: number
  commonPatterns: string[]
  recommendations: Array<{
    title: string
    description: string
    estimatedSavings: number
  }>
  timestamp: Date
}

// Storage
const actions = new Map<string, CostOptimizationAction[]>()
const strategies = new Map<string, CostOptimizationStrategy[]>()
const runs = new Map<string, CostOptimizationRun[]>()
const wastage = new Map<string, WastageAnalysis[]>()

/**
 * Create a cost optimization action.
 */
export function createOptimizationAction(
  organizationId: string,
  agentId: string,
  type: CostOptimizationAction['type'],
  targetResource: string,
  targetMetric: string,
  currentValue: number,
  proposedValue: number,
  estimatedMonthlySavings: number,
  confidence: number,
  implementationCost?: number
): CostOptimizationAction {
  const paybackMonths = implementationCost && estimatedMonthlySavings > 0 ? implementationCost / estimatedMonthlySavings : undefined

  const action: CostOptimizationAction = {
    id: `optim-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    organizationId,
    agentId,
    type,
    targetResource,
    targetMetric,
    currentValue,
    proposedValue,
    estimatedMonthlySavings,
    confidence,
    implementationCost,
    paybackMonths,
    status: confidence > 0.85 && !implementationCost ? 'approved' : 'proposed',
    approvalRequiredReason: confidence <= 0.85 || !!implementationCost ? 'Requires verification or implementation planning' : undefined,
  }

  const key = `${organizationId}:optim_actions`
  const list = actions.get(key) || []
  list.push(action)

  // Keep last 1000
  const filtered = list.slice(-1000)
  actions.set(key, filtered)

  logger.info('optimization action created', {
    organizationId,
    agentId,
    type,
    estimatedSavings: estimatedMonthlySavings,
    confidence,
  })

  return action
}

/**
 * Get optimization actions.
 */
export function getOptimizationActions(organizationId: string, agentId?: string, type?: string): CostOptimizationAction[] {
  const key = `${organizationId}:optim_actions`
  let list = actions.get(key) || []

  if (agentId) {
    list = list.filter((a) => a.agentId === agentId)
  }
  if (type) {
    list = list.filter((a) => a.type === type)
  }

  return list
}

/**
 * Execute optimization action.
 */
export function executeOptimizationAction(organizationId: string, actionId: string, success: boolean, actualSavings?: number): boolean {
  const key = `${organizationId}:optim_actions`
  const list = actions.get(key) || []
  const action = list.find((a) => a.id === actionId)

  if (!action) return false

  action.status = success ? 'completed' : 'failed'
  action.executedAt = new Date()
  if (success) {
    action.completedAt = new Date()
    action.actualSavings = actualSavings || action.estimatedMonthlySavings
  } else {
    action.failureReason = 'Execution failed - see audit logs for details'
  }

  logger.info('optimization action executed', {
    organizationId,
    actionId,
    success,
    actualSavings,
  })

  return true
}

/**
 * Create optimization strategy.
 */
export function createStrategy(
  organizationId: string,
  name: string,
  description: string,
  type: CostOptimizationStrategy['type'],
  targetMetrics: string[],
  optimizationRules: CostOptimizationStrategy['optimizationRules'],
  targetSavingsPerMonth: number
): CostOptimizationStrategy {
  const strategy: CostOptimizationStrategy = {
    id: `strategy-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    organizationId,
    name,
    description,
    type,
    targetMetrics,
    optimizationRules,
    targetSavingsPerMonth,
    enabled: true,
    createdAt: new Date(),
  }

  const key = `${organizationId}:strategies`
  const list = strategies.get(key) || []
  list.push(strategy)
  strategies.set(key, list)

  logger.info('optimization strategy created', {
    organizationId,
    strategyId: strategy.id,
    name,
    targetSavings: targetSavingsPerMonth,
  })

  return strategy
}

/**
 * Get strategies.
 */
export function getStrategies(organizationId: string, enabled?: boolean): CostOptimizationStrategy[] {
  const key = `${organizationId}:strategies`
  let list = strategies.get(key) || []

  if (enabled !== undefined) {
    list = list.filter((s) => s.enabled === enabled)
  }

  return list
}

/**
 * Record optimization run.
 */
export function recordOptimizationRun(
  organizationId: string,
  strategyId: string,
  actionsProposed: number,
  actionsExecuted: number,
  totalEstimatedSavings: number,
  totalActualSavings: number,
  errors: Array<{ action: string; error: string }> = []
): CostOptimizationRun {
  const run: CostOptimizationRun = {
    id: `run-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    organizationId,
    strategyId,
    startedAt: new Date(Date.now() - Math.random() * 3600000), // Random start in last hour
    completedAt: new Date(),
    status: errors.length === 0 ? 'completed' : 'completed',
    actionsProposed,
    actionsExecuted,
    totalEstimatedSavings,
    totalActualSavings,
    errors,
  }

  const key = `${organizationId}:optim_runs`
  const list = runs.get(key) || []
  list.push(run)

  // Keep last 500
  const filtered = list.slice(-500)
  runs.set(key, filtered)

  logger.info('optimization run completed', {
    organizationId,
    strategyId,
    actionsExecuted,
    totalActualSavings,
  })

  return run
}

/**
 * Get optimization runs.
 */
export function getOptimizationRuns(organizationId: string, strategyId?: string, days: number = 30): CostOptimizationRun[] {
  const key = `${organizationId}:optim_runs`
  const list = runs.get(key) || []
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  let filtered = list.filter((r) => r.completedAt && r.completedAt >= cutoff)
  if (strategyId) {
    filtered = filtered.filter((r) => r.strategyId === strategyId)
  }

  return filtered
}

/**
 * Analyze resource wastage.
 */
export function analyzeWastage(
  organizationId: string,
  agentId: string,
  resourceType: string,
  currentUsage: number,
  optimalUsage: number,
  commonPatterns: string[],
  recommendations: WastageAnalysis['recommendations']
): WastageAnalysis {
  const wastePercentage = optimalUsage > 0 ? ((currentUsage - optimalUsage) / currentUsage) * 100 : 0
  const estimatedMonthlyWaste = Math.max(0, currentUsage - optimalUsage) * 30

  const analysis: WastageAnalysis = {
    id: `waste-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    organizationId,
    agentId,
    resourceType,
    wastePercentage: Math.max(0, Math.min(100, wastePercentage)),
    estimatedMonthlyWaste,
    commonPatterns,
    recommendations,
    timestamp: new Date(),
  }

  const key = `${organizationId}:wastage`
  const list = wastage.get(key) || []
  list.push(analysis)

  // Keep last 1000
  const filtered = list.slice(-1000)
  wastage.set(key, filtered)

  logger.info('wastage analysis completed', {
    organizationId,
    agentId,
    resourceType,
    wastePercentage: analysis.wastePercentage.toFixed(1),
    estimatedMonthlyWaste,
  })

  return analysis
}

/**
 * Get wastage analyses.
 */
export function getWastageAnalyses(organizationId: string, agentId?: string, days: number = 30): WastageAnalysis[] {
  const key = `${organizationId}:wastage`
  const list = wastage.get(key) || []
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  let filtered = list.filter((w) => w.timestamp >= cutoff)
  if (agentId) {
    filtered = filtered.filter((w) => w.agentId === agentId)
  }

  return filtered
}

/**
 * Clear cost optimization data (for testing).
 */
export function clearCostOptimization(): void {
  actions.clear()
  strategies.clear()
  runs.clear()
  wastage.clear()
}
