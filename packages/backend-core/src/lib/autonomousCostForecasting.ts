// Phase 11: Autonomous cloud cost forecasting and budget management.
// Predicts cloud costs and autonomously manages budgets to prevent overspend.

import { logger } from './logger.js'

export interface CostForecast {
  id: string
  organizationId: string
  agentId: string
  forecastPeriod: 'week' | 'month' | 'quarter' | 'year'
  forecastEndDate: Date
  baslineCost: number // historical average
  forecastedCost: number
  confidenceInterval: { lower: number; upper: number }
  confidenceLevel: number // 0-1
  driversByCategory: Record<string, number> // compute, storage, network, etc.
  costTrendPercentage: number // month-over-month or week-over-week % change
  seasonalityFactor: number // 0.8-1.2, seasonal adjustment
  anomalies: Array<{
    category: string
    expectedCost: number
    forecastedCost: number
    change: number // percentage
  }>
  forecastAccuracy?: number // historical accuracy
  generatedAt: Date
}

export interface BudgetAllocation {
  id: string
  organizationId: string
  agentId: string
  workspaceId?: string
  departmentId?: string
  budgetType: 'total' | 'compute' | 'storage' | 'network' | 'database' | 'services'
  period: 'monthly' | 'quarterly' | 'yearly'
  allocatedBudget: number
  currentSpend: number
  commitmentDiscounts: number // amount committed to reserved instances
  forecastedSpend: number
  burnRate: number // $ per day
  daysRemaining: number
  projectedSpendAtPaceMillis: number // $ that will be spent if pace continues
  budgetUtilizationRate: number // 0-1
  status: 'on_track' | 'at_risk' | 'exceeding' | 'under_spending'
  alerts: Array<{
    type: 'approaching_limit' | 'exceeding_limit' | 'unusual_spend'
    threshold: number
    currentValue: number
    alertedAt: Date
    dismissed: boolean
  }>
  lastUpdatedAt: Date
}

export interface SpendAnomalyDetection {
  id: string
  organizationId: string
  agentId: string
  anomalyType: 'spike' | 'trend' | 'outlier' | 'pattern_break'
  service: string
  expectedCost: number
  actualCost: number
  deviation: number // percentage
  severity: 'low' | 'medium' | 'high' | 'critical'
  detectionConfidence: number // 0-1
  possibleCauses: Array<{
    cause: string
    probability: number // 0-1
    suggestedAction: string
  }>
  rootCauseDiagnosed?: string
  automatedResponse?: {
    action: string
    resultingSpendReduction: number
    success: boolean
  }
  detectedAt: Date
  resolvedAt?: Date
}

export interface CostOptimizationRecommendation {
  id: string
  organizationId: string
  agentId: string
  title: string
  description: string
  category: 'reserved_instances' | 'commitment_discounts' | 'resource_elimination' | 'service_consolidation' | 'region_optimization'
  estimatedAnnualSavings: number
  estimatedImplementationCost: number
  paybackMonths: number
  implementationEffort: 'low' | 'medium' | 'high'
  riskLevel: 'low' | 'medium' | 'high'
  affectedServices: string[]
  priority: number // 1-100, derived from savings/effort/risk
  status: 'active' | 'implemented' | 'dismissed' | 'scheduled'
  approvedAt?: Date
  implementedAt?: Date
  actualSavings?: number
}

export interface CostOptimizationPlan {
  id: string
  organizationId: string
  agentId: string
  name: string
  targetMonthlySavings: number
  recommendations: string[] // recommendation IDs
  totalEstimatedSavings: number
  totalImplementationCost: number
  implementationTimeline: number // months
  expectedROIMonths: number
  status: 'proposed' | 'approved' | 'in_progress' | 'completed'
  approvalRequiredReason?: string
  startedAt?: Date
  completedAt?: Date
  actualSavingsToDate?: number
}

export interface BudgetGovernancePolicy {
  id: string
  organizationId: string
  name: string
  description: string
  budgetLimitPerWorkspace: number // monthly
  autoApprovalThreshold: number // under this amount, auto-approve without manual review
  requireApprovalThreshold: number // over this, requires manager approval
  escalationThreshold: number // over this, escalate to CFO
  overspendAction: 'warn' | 'throttle' | 'block'
  overspendThreshold: number // %, e.g., 110% of budget
  enabled: boolean
  createdAt: Date
}

export interface CostReport {
  id: string
  organizationId: string
  agentId: string
  reportType: 'daily' | 'weekly' | 'monthly'
  period: { startDate: Date; endDate: Date }
  totalSpend: number
  spendByCategory: Record<string, number>
  spendByWorkspace: Record<string, number>
  spendByDepartment: Record<string, number>
  monthOverMonthChange: number // percentage
  anomaliesDetected: number
  optimizationsImplemented: number
  costsSaved: number
  forecastedMonthEnd: number
  budgetVariance: number
  generatedAt: Date
}

// Storage
const forecasts = new Map<string, CostForecast[]>()
const budgets = new Map<string, BudgetAllocation[]>()
const anomalies = new Map<string, SpendAnomalyDetection[]>()
const recommendations = new Map<string, CostOptimizationRecommendation[]>()
const plans = new Map<string, CostOptimizationPlan[]>()
const policies = new Map<string, BudgetGovernancePolicy[]>()
const reports = new Map<string, CostReport[]>()

/**
 * Create cost forecast.
 */
export function createCostForecast(
  organizationId: string,
  agentId: string,
  forecastPeriod: CostForecast['forecastPeriod'],
  baslineCost: number,
  forecastedCost: number,
  driversByCategory: Record<string, number>,
  costTrendPercentage: number,
  seasonalityFactor: number,
  confidenceLevel: number,
  anomalies: CostForecast['anomalies'],
  forecastAccuracy?: number
): CostForecast {
  const daysInPeriod = forecastPeriod === 'week' ? 7 : forecastPeriod === 'month' ? 30 : forecastPeriod === 'quarter' ? 90 : 365
  const marginOfError = (forecastedCost * (1 - confidenceLevel)) / 2

  const forecast: CostForecast = {
    id: `forecast-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    organizationId,
    agentId,
    forecastPeriod,
    forecastEndDate: new Date(Date.now() + daysInPeriod * 24 * 60 * 60 * 1000),
    baslineCost,
    forecastedCost,
    confidenceInterval: {
      lower: Math.max(0, forecastedCost - marginOfError),
      upper: forecastedCost + marginOfError,
    },
    confidenceLevel,
    driversByCategory,
    costTrendPercentage,
    seasonalityFactor,
    anomalies,
    forecastAccuracy,
    generatedAt: new Date(),
  }

  const key = `${organizationId}:cost_forecasts`
  const list = forecasts.get(key) || []
  list.push(forecast)

  // Keep last 1000
  const filtered = list.slice(-1000)
  forecasts.set(key, filtered)

  logger.info('cost forecast created', {
    organizationId,
    agentId,
    forecastPeriod,
    forecastedCost,
    confidenceLevel,
    trendPercentage: costTrendPercentage.toFixed(1),
  })

  return forecast
}

/**
 * Get cost forecasts.
 */
export function getCostForecasts(organizationId: string, agentId?: string): CostForecast[] {
  const key = `${organizationId}:cost_forecasts`
  let list = forecasts.get(key) || []

  if (agentId) {
    list = list.filter((f) => f.agentId === agentId)
  }

  return list
}

/**
 * Create budget allocation.
 */
export function createBudgetAllocation(
  organizationId: string,
  agentId: string,
  budgetType: BudgetAllocation['budgetType'],
  period: BudgetAllocation['period'],
  allocatedBudget: number,
  forecastedSpend: number,
  commitmentDiscounts: number = 0,
  workspaceId?: string,
  departmentId?: string
): BudgetAllocation {
  const daysInPeriod = period === 'monthly' ? 30 : period === 'quarterly' ? 90 : 365
  const daysPassed = Math.floor((Date.now() - Date.now() + 1000) / (24 * 60 * 60 * 1000)) // Assume 0 days passed, adjust as needed
  const daysRemaining = Math.max(0, daysInPeriod - daysPassed)
  const burnRate = daysPassed > 0 ? 0 / daysPassed : 0 // Assume 0 spend so far
  const projectedSpendAtPace = burnRate * daysInPeriod

  const status =
    projectedSpendAtPace > allocatedBudget * 1.1
      ? 'exceeding'
      : projectedSpendAtPace > allocatedBudget * 0.95
        ? 'at_risk'
        : projectedSpendAtPace < allocatedBudget * 0.5
          ? 'under_spending'
          : 'on_track'

  const budget: BudgetAllocation = {
    id: `budget-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    organizationId,
    agentId,
    workspaceId,
    departmentId,
    budgetType,
    period,
    allocatedBudget,
    currentSpend: 0,
    commitmentDiscounts,
    forecastedSpend,
    burnRate,
    daysRemaining,
    projectedSpendAtPaceMillis: projectedSpendAtPace,
    budgetUtilizationRate: allocatedBudget > 0 ? forecastedSpend / allocatedBudget : 0,
    status,
    alerts: [],
    lastUpdatedAt: new Date(),
  }

  const key = `${organizationId}:budgets`
  const list = budgets.get(key) || []
  list.push(budget)

  // Keep last 2000
  const filtered = list.slice(-2000)
  budgets.set(key, filtered)

  logger.info('budget allocation created', {
    organizationId,
    agentId,
    budgetType,
    allocatedBudget,
    forecastedSpend,
    status,
  })

  return budget
}

/**
 * Get budget allocations.
 */
export function getBudgetAllocations(organizationId: string, status?: string): BudgetAllocation[] {
  const key = `${organizationId}:budgets`
  let list = budgets.get(key) || []

  if (status) {
    list = list.filter((b) => b.status === status)
  }

  return list
}

/**
 * Update budget utilization.
 */
export function updateBudgetUtilization(organizationId: string, budgetId: string, currentSpend: number, forecastedSpend: number): boolean {
  const key = `${organizationId}:budgets`
  const list = budgets.get(key) || []
  const budget = list.find((b) => b.id === budgetId)

  if (!budget) return false

  budget.currentSpend = currentSpend
  budget.forecastedSpend = forecastedSpend
  budget.budgetUtilizationRate = budget.allocatedBudget > 0 ? currentSpend / budget.allocatedBudget : 0
  budget.status =
    budget.projectedSpendAtPaceMillis > budget.allocatedBudget * 1.1
      ? 'exceeding'
      : budget.projectedSpendAtPaceMillis > budget.allocatedBudget * 0.95
        ? 'at_risk'
        : budget.projectedSpendAtPaceMillis < budget.allocatedBudget * 0.5
          ? 'under_spending'
          : 'on_track'
  budget.lastUpdatedAt = new Date()

  if (budget.status === 'exceeding' || budget.status === 'at_risk') {
    budget.alerts.push({
      type: budget.status === 'exceeding' ? 'exceeding_limit' : 'approaching_limit',
      threshold: budget.allocatedBudget,
      currentValue: budget.projectedSpendAtPaceMillis,
      alertedAt: new Date(),
      dismissed: false,
    })
  }

  return true
}

/**
 * Detect spend anomaly.
 */
export function detectSpendAnomaly(
  organizationId: string,
  agentId: string,
  service: string,
  expectedCost: number,
  actualCost: number,
  severity: SpendAnomalyDetection['severity'],
  detectionConfidence: number,
  possibleCauses: SpendAnomalyDetection['possibleCauses']
): SpendAnomalyDetection {
  const deviation = ((actualCost - expectedCost) / expectedCost) * 100
  const anomalyType =
    actualCost > expectedCost * 1.5
      ? 'spike'
      : actualCost < expectedCost * 0.5
        ? 'trend'
        : Math.abs(deviation) > 30
          ? 'outlier'
          : 'pattern_break'

  const anomaly: SpendAnomalyDetection = {
    id: `anomaly-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    organizationId,
    agentId,
    anomalyType,
    service,
    expectedCost,
    actualCost,
    deviation,
    severity,
    detectionConfidence,
    possibleCauses,
    detectedAt: new Date(),
  }

  const key = `${organizationId}:spend_anomalies`
  const list = anomalies.get(key) || []
  list.push(anomaly)

  // Keep last 1000
  const filtered = list.slice(-1000)
  anomalies.set(key, filtered)

  logger.info('spend anomaly detected', {
    organizationId,
    agentId,
    service,
    deviation: deviation.toFixed(1),
    severity,
    detectionConfidence,
  })

  return anomaly
}

/**
 * Get spend anomalies.
 */
export function getSpendAnomalies(organizationId: string, agentId?: string, severity?: string): SpendAnomalyDetection[] {
  const key = `${organizationId}:spend_anomalies`
  let list = anomalies.get(key) || []

  if (agentId) {
    list = list.filter((a) => a.agentId === agentId)
  }
  if (severity) {
    list = list.filter((a) => a.severity === severity)
  }

  return list
}

/**
 * Create cost optimization recommendation.
 */
export function createCostOptimizationRecommendation(
  organizationId: string,
  agentId: string,
  title: string,
  description: string,
  category: CostOptimizationRecommendation['category'],
  estimatedAnnualSavings: number,
  estimatedImplementationCost: number,
  implementationEffort: CostOptimizationRecommendation['implementationEffort'],
  riskLevel: CostOptimizationRecommendation['riskLevel'],
  affectedServices: string[]
): CostOptimizationRecommendation {
  const paybackMonths = estimatedImplementationCost > 0 ? (estimatedImplementationCost * 12) / estimatedAnnualSavings : 0
  const effortScore = implementationEffort === 'low' ? 3 : implementationEffort === 'medium' ? 2 : 1
  const riskScore = riskLevel === 'low' ? 3 : riskLevel === 'medium' ? 2 : 1
  const priority = Math.round(((estimatedAnnualSavings / 100000) * effortScore * riskScore) / 0.27) // Normalize to 1-100

  const recommendation: CostOptimizationRecommendation = {
    id: `rec-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    organizationId,
    agentId,
    title,
    description,
    category,
    estimatedAnnualSavings,
    estimatedImplementationCost,
    paybackMonths,
    implementationEffort,
    riskLevel,
    affectedServices,
    priority: Math.min(100, Math.max(1, priority)),
    status: 'active',
  }

  const key = `${organizationId}:cost_recs`
  const list = recommendations.get(key) || []
  list.push(recommendation)

  // Keep last 500
  const filtered = list.slice(-500)
  recommendations.set(key, filtered)

  logger.info('cost optimization recommendation created', {
    organizationId,
    agentId,
    title,
    estimatedSavings: estimatedAnnualSavings,
    priority: recommendation.priority,
  })

  return recommendation
}

/**
 * Get cost optimization recommendations.
 */
export function getCostOptimizationRecommendations(organizationId: string, status?: string): CostOptimizationRecommendation[] {
  const key = `${organizationId}:cost_recs`
  let list = recommendations.get(key) || []

  if (status) {
    list = list.filter((r) => r.status === status)
  }

  return list.sort((a, b) => b.priority - a.priority)
}

/**
 * Create cost optimization plan.
 */
export function createCostOptimizationPlan(
  organizationId: string,
  agentId: string,
  name: string,
  targetMonthlySavings: number,
  recommendationIds: string[]
): CostOptimizationPlan {
  // Estimate total savings and cost from recommendations
  const key = `${organizationId}:cost_recs`
  const recList = recommendations.get(key) || []
  const selectedRecs = recList.filter((r) => recommendationIds.includes(r.id))

  const totalEstimatedSavings = selectedRecs.reduce((sum, r) => sum + r.estimatedAnnualSavings, 0)
  const totalImplementationCost = selectedRecs.reduce((sum, r) => sum + r.estimatedImplementationCost, 0)
  const maxPaybackMonths = Math.max(...selectedRecs.map((r) => r.paybackMonths))

  const plan: CostOptimizationPlan = {
    id: `plan-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    organizationId,
    agentId,
    name,
    targetMonthlySavings,
    recommendations: recommendationIds,
    totalEstimatedSavings,
    totalImplementationCost,
    implementationTimeline: 0, // Placeholder
    expectedROIMonths: totalImplementationCost > 0 ? (totalImplementationCost / (totalEstimatedSavings / 12)) : 0,
    status: 'proposed',
  }

  const plansKey = `${organizationId}:cost_plans`
  const plansList = plans.get(plansKey) || []
  plansList.push(plan)

  const planFiltered = plansList.slice(-500)
  plans.set(plansKey, planFiltered)

  logger.info('cost optimization plan created', {
    organizationId,
    agentId,
    name,
    recommendations: recommendationIds.length,
    totalSavings: totalEstimatedSavings,
  })

  return plan
}

/**
 * Get cost optimization plans.
 */
export function getCostOptimizationPlans(organizationId: string, status?: string): CostOptimizationPlan[] {
  const key = `${organizationId}:cost_plans`
  let list = plans.get(key) || []

  if (status) {
    list = list.filter((p) => p.status === status)
  }

  return list
}

/**
 * Create budget governance policy.
 */
export function createBudgetGovernancePolicy(
  organizationId: string,
  name: string,
  description: string,
  budgetLimitPerWorkspace: number,
  autoApprovalThreshold: number,
  requireApprovalThreshold: number,
  escalationThreshold: number,
  overspendAction: BudgetGovernancePolicy['overspendAction'],
  overspendThreshold: number
): BudgetGovernancePolicy {
  const policy: BudgetGovernancePolicy = {
    id: `policy-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    organizationId,
    name,
    description,
    budgetLimitPerWorkspace,
    autoApprovalThreshold,
    requireApprovalThreshold,
    escalationThreshold,
    overspendAction,
    overspendThreshold,
    enabled: true,
    createdAt: new Date(),
  }

  const key = `${organizationId}:policies`
  const list = policies.get(key) || []
  list.push(policy)
  policies.set(key, list)

  logger.info('budget governance policy created', {
    organizationId,
    name,
    autoApprovalThreshold,
  })

  return policy
}

/**
 * Get budget governance policies.
 */
export function getBudgetGovernancePolicies(organizationId: string): BudgetGovernancePolicy[] {
  const key = `${organizationId}:policies`
  return policies.get(key) || []
}

/**
 * Generate cost report.
 */
export function generateCostReport(
  organizationId: string,
  agentId: string,
  reportType: CostReport['reportType'],
  startDate: Date,
  endDate: Date,
  totalSpend: number,
  spendByCategory: Record<string, number>,
  spendByWorkspace: Record<string, number>,
  spendByDepartment: Record<string, number>,
  anomaliesDetected: number,
  optimizationsImplemented: number,
  costsSaved: number,
  forecastedMonthEnd: number,
  budgetVariance: number
): CostReport {
  const report: CostReport = {
    id: `report-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    organizationId,
    agentId,
    reportType,
    period: { startDate, endDate },
    totalSpend,
    spendByCategory,
    spendByWorkspace,
    spendByDepartment,
    monthOverMonthChange: 0, // Placeholder
    anomaliesDetected,
    optimizationsImplemented,
    costsSaved,
    forecastedMonthEnd,
    budgetVariance,
    generatedAt: new Date(),
  }

  const key = `${organizationId}:cost_reports`
  const list = reports.get(key) || []
  list.push(report)

  // Keep last 500
  const filtered = list.slice(-500)
  reports.set(key, filtered)

  logger.info('cost report generated', {
    organizationId,
    agentId,
    reportType,
    totalSpend,
    costsSaved,
  })

  return report
}

/**
 * Get cost reports.
 */
export function getCostReports(organizationId: string, reportType?: string, days: number = 90): CostReport[] {
  const key = `${organizationId}:cost_reports`
  const list = reports.get(key) || []
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  let filtered = list.filter((r) => r.generatedAt >= cutoff)
  if (reportType) {
    filtered = filtered.filter((r) => r.reportType === reportType)
  }

  return filtered
}

/**
 * Clear cost forecasting data (for testing).
 */
export function clearCostForecasting(): void {
  forecasts.clear()
  budgets.clear()
  anomalies.clear()
  recommendations.clear()
  plans.clear()
  policies.clear()
  reports.clear()
}
