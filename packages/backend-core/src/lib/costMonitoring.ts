// Phase 7: Real-time cost monitoring with spike detection, budget pace tracking, and anomaly alerting.
// Enables live cost aggregation, baseline modeling, and cost change notifications.

import { logger } from './logger.js'

export interface CostDataPoint {
  timestamp: Date
  organizationId: string
  totalCost: number
  breakdown: Record<string, number> // by service/team/resource
}

export interface CostBaseline {
  organizationId: string
  metric: string // 'daily_cost', 'hourly_cost', etc.
  baselineValue: number
  standardDeviation: number
  trend: number // % change month-over-month
  seasonalFactor: number // 0.8-1.2x multiplier
  lastUpdated: Date
}

export interface CostSpike {
  id: string
  organizationId: string
  timestamp: Date
  currentCost: number
  expectedCost: number
  deviation: number // standard deviations above baseline
  percentageIncrease: number
  severity: 'low' | 'medium' | 'high' | 'critical' // based on deviation
  description: string
  affectedServices: string[]
  resolved: boolean
  resolvedAt?: Date
}

export interface BudgetPace {
  organizationId: string
  departmentId?: string
  teamId?: string
  periodStartDate: Date
  periodEndDate: Date
  budgetAmount: number
  spentAmount: number
  remainingAmount: number
  percentSpent: number
  percentElapsed: number
  onTrack: boolean // percentSpent <= percentElapsed
  daysRemaining: number
  projectedFinalCost: number
  projectedOverage: number
}

export interface CostChange {
  id: string
  organizationId: string
  periodStart: Date
  periodEnd: Date
  previousPeriodCost: number
  currentPeriodCost: number
  absoluteChange: number
  percentageChange: number
  direction: 'increase' | 'decrease' | 'stable'
  topContributors: Array<{ service: string; change: number }>
}

export interface LiveCostAggregate {
  organizationId: string
  timestamp: Date
  lastHourCost: number
  lastDayCost: number
  lastWeekCost: number
  lastMonthCost: number
  runningMonthCost: number
  costTrend: number // % change from last hour
}

export interface CostAlert {
  id: string
  organizationId: string
  type: 'spike' | 'budget_pace' | 'threshold' | 'anomaly'
  severity: 'low' | 'medium' | 'high' | 'critical'
  message: string
  triggeredAt: Date
  acknowledged: boolean
  acknowledgedAt?: Date
  acknowledgedBy?: string
}

// Storage
const costDataPoints = new Map<string, CostDataPoint[]>()
const costBaselines = new Map<string, CostBaseline[]>()
const costSpikes = new Map<string, CostSpike[]>()
const budgetPaces = new Map<string, BudgetPace>()
const costChanges = new Map<string, CostChange[]>()
const liveAggregates = new Map<string, LiveCostAggregate>()
const costAlerts = new Map<string, CostAlert[]>()

/**
 * Record cost data point.
 */
export function recordCostDataPoint(
  organizationId: string,
  totalCost: number,
  breakdown: Record<string, number>
): CostDataPoint {
  const dataPoint: CostDataPoint = {
    timestamp: new Date(),
    organizationId,
    totalCost,
    breakdown,
  }

  const list = costDataPoints.get(organizationId) || []
  list.push(dataPoint)

  // Keep last 90 days
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
  const filtered = list.filter((p) => p.timestamp >= cutoff)
  costDataPoints.set(organizationId, filtered)

  logger.info('cost data point recorded', {
    organizationId,
    totalCost,
    dataPointCount: filtered.length,
  })

  return dataPoint
}

/**
 * Get cost data points for organization.
 */
export function getCostDataPoints(organizationId: string, hours: number = 24): CostDataPoint[] {
  const list = costDataPoints.get(organizationId) || []
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000)
  return list.filter((p) => p.timestamp >= cutoff)
}

/**
 * Calculate cost baseline from historical data.
 */
export function calculateCostBaseline(
  organizationId: string,
  metric: string,
  historicalDays: number = 30
): CostBaseline {
  const list = costDataPoints.get(organizationId) || []
  const cutoff = new Date(Date.now() - historicalDays * 24 * 60 * 60 * 1000)
  const historical = list.filter((p) => p.timestamp >= cutoff)

  let baselineValue = 0
  let sum = 0
  let sumSquares = 0

  for (const point of historical) {
    sum += point.totalCost
    sumSquares += point.totalCost * point.totalCost
  }

  const count = historical.length || 1
  baselineValue = sum / count
  const variance = sumSquares / count - baselineValue * baselineValue
  const standardDeviation = Math.sqrt(Math.max(0, variance))

  // Calculate trend: month-over-month
  const prevMonthCutoff = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)
  const prevMonth = list.filter((p) => p.timestamp >= prevMonthCutoff && p.timestamp < cutoff)
  const prevMonthAvg = prevMonth.length > 0 ? prevMonth.reduce((sum, p) => sum + p.totalCost, 0) / prevMonth.length : baselineValue

  const trend = ((baselineValue - prevMonthAvg) / prevMonthAvg) * 100

  // Seasonal factor (weekday vs weekend, morning vs evening)
  const hour = new Date().getHours()
  const seasonalFactor = hour >= 9 && hour <= 17 ? 1.1 : 0.9

  const baseline: CostBaseline = {
    organizationId,
    metric,
    baselineValue,
    standardDeviation,
    trend,
    seasonalFactor,
    lastUpdated: new Date(),
  }

  const baselineList = costBaselines.get(organizationId) || []
  const index = baselineList.findIndex((b) => b.metric === metric)
  if (index >= 0) {
    baselineList[index] = baseline
  } else {
    baselineList.push(baseline)
  }
  costBaselines.set(organizationId, baselineList)

  return baseline
}

/**
 * Get cost baseline.
 */
export function getCostBaseline(organizationId: string, metric: string): CostBaseline | null {
  const list = costBaselines.get(organizationId) || []
  return list.find((b) => b.metric === metric) || null
}

/**
 * Detect cost spikes.
 */
export function detectCostSpike(
  organizationId: string,
  currentCost: number,
  affectedServices: string[] = []
): CostSpike | null {
  const baseline = getCostBaseline(organizationId, 'daily_cost')
  if (!baseline || baseline.standardDeviation === 0) return null

  const expectedCost = baseline.baselineValue * baseline.seasonalFactor
  const deviation = (currentCost - expectedCost) / baseline.standardDeviation
  const percentageIncrease = ((currentCost - expectedCost) / expectedCost) * 100

  // Only report if > 1.5 standard deviations above baseline
  if (deviation <= 1.5) return null

  const severity: 'low' | 'medium' | 'high' | 'critical' =
    deviation >= 3 ? 'critical' : deviation >= 2.5 ? 'high' : deviation >= 2 ? 'medium' : 'low'

  const spike: CostSpike = {
    id: `spike-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    organizationId,
    timestamp: new Date(),
    currentCost,
    expectedCost,
    deviation,
    percentageIncrease,
    severity,
    description: `Cost spike: ${percentageIncrease.toFixed(1)}% above baseline (${deviation.toFixed(1)}σ)`,
    affectedServices,
    resolved: false,
  }

  const list = costSpikes.get(organizationId) || []
  list.push(spike)
  costSpikes.set(organizationId, list)

  logger.warn('cost spike detected', {
    organizationId,
    severity,
    deviation,
    percentageIncrease,
  })

  return spike
}

/**
 * Get active cost spikes.
 */
export function getActiveSpikes(organizationId: string): CostSpike[] {
  const list = costSpikes.get(organizationId) || []
  return list.filter((s) => !s.resolved)
}

/**
 * Resolve cost spike.
 */
export function resolveSpike(organizationId: string, spikeId: string): boolean {
  const list = costSpikes.get(organizationId) || []
  const spike = list.find((s) => s.id === spikeId)

  if (!spike) return false

  spike.resolved = true
  spike.resolvedAt = new Date()

  return true
}

/**
 * Calculate budget pace.
 */
export function calculateBudgetPace(
  organizationId: string,
  budgetAmount: number,
  spentAmount: number,
  periodStartDate: Date,
  periodEndDate: Date,
  departmentId?: string,
  teamId?: string
): BudgetPace {
  const now = new Date()
  const totalDays = Math.ceil((periodEndDate.getTime() - periodStartDate.getTime()) / (24 * 60 * 60 * 1000))
  const elapsedDays = Math.ceil((now.getTime() - periodStartDate.getTime()) / (24 * 60 * 60 * 1000))
  const daysRemaining = Math.max(0, totalDays - elapsedDays)

  const percentSpent = (spentAmount / budgetAmount) * 100
  const percentElapsed = (elapsedDays / totalDays) * 100

  const onTrack = percentSpent <= percentElapsed
  const projectedFinalCost = elapsedDays > 0 ? (spentAmount / elapsedDays) * totalDays : 0
  const projectedOverage = Math.max(0, projectedFinalCost - budgetAmount)

  const pace: BudgetPace = {
    organizationId,
    departmentId,
    teamId,
    periodStartDate,
    periodEndDate,
    budgetAmount,
    spentAmount,
    remainingAmount: budgetAmount - spentAmount,
    percentSpent,
    percentElapsed,
    onTrack,
    daysRemaining,
    projectedFinalCost,
    projectedOverage,
  }

  const key = [organizationId, departmentId, teamId].filter(Boolean).join(':')
  budgetPaces.set(key, pace)

  return pace
}

/**
 * Get budget pace.
 */
export function getBudgetPace(
  organizationId: string,
  departmentId?: string,
  teamId?: string
): BudgetPace | null {
  const key = [organizationId, departmentId, teamId].filter(Boolean).join(':')
  return budgetPaces.get(key) || null
}

/**
 * Calculate cost change (period-over-period).
 */
export function calculateCostChange(
  organizationId: string,
  currentPeriodStart: Date,
  currentPeriodEnd: Date,
  previousPeriodDays: number = 7
): CostChange {
  // Get current period cost
  const currentData = getCostDataPoints(organizationId, 24)
  const currentCost = currentData.reduce((sum, p) => sum + p.totalCost, 0)

  // Get previous period cost
  const prevList = costDataPoints.get(organizationId) || []
  const prevCutoff = new Date(Date.now() - (previousPeriodDays + 7) * 24 * 60 * 60 * 1000)
  const prevData = prevList.filter((p) => p.timestamp >= prevCutoff && p.timestamp < new Date(Date.now() - 7 * 24 * 60 * 60 * 1000))
  const previousCost = prevData.reduce((sum, p) => sum + p.totalCost, 0)

  const absoluteChange = currentCost - previousCost
  const percentageChange = previousCost > 0 ? (absoluteChange / previousCost) * 100 : 0
  const direction: 'increase' | 'decrease' | 'stable' =
    Math.abs(percentageChange) < 5 ? 'stable' : percentageChange > 0 ? 'increase' : 'decrease'

  // Top contributors
  const topContributors: Array<{ service: string; change: number }> = []
  const serviceChanges: Record<string, number> = {}

  for (const point of currentData) {
    for (const [service, cost] of Object.entries(point.breakdown)) {
      serviceChanges[service] = (serviceChanges[service] || 0) + cost
    }
  }

  const sorted = Object.entries(serviceChanges)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)

  for (const [service, cost] of sorted) {
    topContributors.push({ service, change: cost })
  }

  const change: CostChange = {
    id: `change-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    organizationId,
    periodStart: currentPeriodStart,
    periodEnd: currentPeriodEnd,
    previousPeriodCost: previousCost,
    currentPeriodCost: currentCost,
    absoluteChange,
    percentageChange,
    direction,
    topContributors,
  }

  const list = costChanges.get(organizationId) || []
  list.push(change)
  costChanges.set(organizationId, list)

  return change
}

/**
 * Get cost changes.
 */
export function getCostChanges(organizationId: string, days: number = 30): CostChange[] {
  const list = costChanges.get(organizationId) || []
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  return list.filter((c) => c.periodStart >= cutoff)
}

/**
 * Update live cost aggregate.
 */
export function updateLiveAggregate(organizationId: string): LiveCostAggregate {
  const allData = costDataPoints.get(organizationId) || []
  const now = Date.now()

  const lastHour = allData.filter((p) => p.timestamp.getTime() > now - 60 * 60 * 1000)
  const lastDay = allData.filter((p) => p.timestamp.getTime() > now - 24 * 60 * 60 * 1000)
  const lastWeek = allData.filter((p) => p.timestamp.getTime() > now - 7 * 24 * 60 * 60 * 1000)
  const lastMonth = allData.filter((p) => p.timestamp.getTime() > now - 30 * 24 * 60 * 60 * 1000)

  const lastHourCost = lastHour.reduce((sum, p) => sum + p.totalCost, 0)
  const lastDayCost = lastDay.reduce((sum, p) => sum + p.totalCost, 0)
  const lastWeekCost = lastWeek.reduce((sum, p) => sum + p.totalCost, 0)
  const lastMonthCost = lastMonth.reduce((sum, p) => sum + p.totalCost, 0)

  // Current month cost (from 1st to today)
  const monthStart = new Date(now)
  monthStart.setDate(1)
  monthStart.setHours(0, 0, 0, 0)
  const runningMonthData = allData.filter((p) => p.timestamp >= monthStart)
  const runningMonthCost = runningMonthData.reduce((sum, p) => sum + p.totalCost, 0)

  // Trend from previous hour
  const prevHour = allData.filter((p) => p.timestamp.getTime() > now - 2 * 60 * 60 * 1000 && p.timestamp.getTime() <= now - 60 * 60 * 1000)
  const prevHourCost = prevHour.reduce((sum, p) => sum + p.totalCost, 0)
  const costTrend = prevHourCost > 0 ? ((lastHourCost - prevHourCost) / prevHourCost) * 100 : 0

  const aggregate: LiveCostAggregate = {
    organizationId,
    timestamp: new Date(),
    lastHourCost,
    lastDayCost,
    lastWeekCost,
    lastMonthCost,
    runningMonthCost,
    costTrend,
  }

  liveAggregates.set(organizationId, aggregate)

  return aggregate
}

/**
 * Get live cost aggregate.
 */
export function getLiveAggregate(organizationId: string): LiveCostAggregate | null {
  return liveAggregates.get(organizationId) || null
}

/**
 * Create cost alert.
 */
export function createAlert(
  organizationId: string,
  type: 'spike' | 'budget_pace' | 'threshold' | 'anomaly',
  severity: 'low' | 'medium' | 'high' | 'critical',
  message: string
): CostAlert {
  const alert: CostAlert = {
    id: `alert-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    organizationId,
    type,
    severity,
    message,
    triggeredAt: new Date(),
    acknowledged: false,
  }

  const list = costAlerts.get(organizationId) || []
  list.push(alert)
  costAlerts.set(organizationId, list)

  logger.info('cost alert created', {
    organizationId,
    type,
    severity,
  })

  return alert
}

/**
 * Get active alerts.
 */
export function getActiveAlerts(organizationId: string): CostAlert[] {
  const list = costAlerts.get(organizationId) || []
  return list.filter((a) => !a.acknowledged)
}

/**
 * Acknowledge alert.
 */
export function acknowledgeAlert(organizationId: string, alertId: string, userId?: string): boolean {
  const list = costAlerts.get(organizationId) || []
  const alert = list.find((a) => a.id === alertId)

  if (!alert) return false

  alert.acknowledged = true
  alert.acknowledgedAt = new Date()
  alert.acknowledgedBy = userId

  return true
}

/**
 * Clear monitoring data (for testing).
 */
export function clearMonitoring(): void {
  costDataPoints.clear()
  costBaselines.clear()
  costSpikes.clear()
  budgetPaces.clear()
  costChanges.clear()
  liveAggregates.clear()
  costAlerts.clear()
}
