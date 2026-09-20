// Phase 6: Organizational analytics with hierarchical KPIs, benchmarking, and trend analysis.
// Enables cost analytics across teams, projects, and custom dimensions with trend tracking.

import { logger } from './logger.js'

export interface CostMetric {
  entityId: string
  entityType: 'organization' | 'department' | 'team' | 'project' | 'customer'
  period: string // YYYY-MM-DD
  totalCost: number
  breakdown: Record<string, number> // by resource type or dimension
  trend: number // % change from previous period
}

export interface PerformanceKPI {
  id: string
  organizationId: string
  name: string
  description?: string
  metric: string // cost per seat, cost per transaction, cost per unit, etc.
  targetValue: number
  actualValue: number
  percentOfTarget: number // actual / target * 100
  status: 'on_track' | 'at_risk' | 'off_track'
  trend: number // % change
  period: string
}

export interface Benchmark {
  id: string
  organizationId: string
  name: string
  benchmark: 'industry' | 'peer' | 'internal'
  metric: string
  benchmarkValue: number
  actualValue: number
  variance: number // % difference from benchmark
  status: 'above_average' | 'average' | 'below_average'
  lastUpdated: Date
}

export interface CostTrend {
  entityId: string
  entityType: string
  metric: string
  direction: 'increasing' | 'decreasing' | 'stable'
  changePercent: number
  periods: Array<{ period: string; value: number }>
  forecast?: Array<{ period: string; projected: number }>
}

export interface CostBreakdown {
  entityId: string
  period: string
  byTeam: Record<string, number>
  byProject: Record<string, number>
  byResourceType: Record<string, number>
  byCustomer: Record<string, number>
  byRegion?: Record<string, number>
}

// Storage
const metrics = new Map<string, CostMetric[]>()
const kpis = new Map<string, PerformanceKPI[]>()
const benchmarks = new Map<string, Benchmark[]>()
const trends = new Map<string, CostTrend>()
const breakdowns = new Map<string, CostBreakdown>()

/**
 * Record cost metric.
 */
export function recordCostMetric(
  entityId: string,
  entityType: 'organization' | 'department' | 'team' | 'project' | 'customer',
  period: string,
  totalCost: number,
  breakdown: Record<string, number>,
  trend: number = 0
): CostMetric {
  const metric: CostMetric = {
    entityId,
    entityType,
    period,
    totalCost,
    breakdown,
    trend,
  }

  const key = `${entityType}:${entityId}`
  const list = metrics.get(key) || []
  list.push(metric)
  metrics.set(key, list)

  return metric
}

/**
 * Get cost metrics for entity.
 */
export function getEntityMetrics(
  entityId: string,
  entityType: string,
  periods: number = 12
): CostMetric[] {
  const key = `${entityType}:${entityId}`
  const list = metrics.get(key) || []
  return list.slice(-periods)
}

/**
 * Create or update KPI.
 */
export function setPerformanceKPI(
  organizationId: string,
  name: string,
  description: string,
  metric: string,
  targetValue: number,
  actualValue: number,
  period: string
): PerformanceKPI {
  const percentOfTarget = (actualValue / targetValue) * 100
  const status: 'on_track' | 'at_risk' | 'off_track' =
    percentOfTarget >= 90 ? 'on_track' : percentOfTarget >= 75 ? 'at_risk' : 'off_track'

  const kpi: PerformanceKPI = {
    id: `kpi-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    organizationId,
    name,
    description,
    metric,
    targetValue,
    actualValue,
    percentOfTarget,
    status,
    trend: 0,
    period,
  }

  const list = kpis.get(organizationId) || []
  const index = list.findIndex((k) => k.metric === metric && k.period === period)
  if (index >= 0) {
    const prev = list[index]
    kpi.trend = ((actualValue - prev.actualValue) / prev.actualValue) * 100
    list[index] = kpi
  } else {
    list.push(kpi)
  }
  kpis.set(organizationId, list)

  logger.info('kpi recorded', {
    organizationId,
    name,
    metric,
    percentOfTarget,
    status,
  })

  return kpi
}

/**
 * Get KPIs for organization.
 */
export function getOrganizationKPIs(organizationId: string): PerformanceKPI[] {
  return kpis.get(organizationId) || []
}

/**
 * Create benchmark.
 */
export function createBenchmark(
  organizationId: string,
  name: string,
  benchmark: 'industry' | 'peer' | 'internal',
  metric: string,
  benchmarkValue: number,
  actualValue: number
): Benchmark {
  const variance = ((actualValue - benchmarkValue) / benchmarkValue) * 100
  const status: 'above_average' | 'average' | 'below_average' =
    variance > 10 ? 'above_average' : variance < -10 ? 'below_average' : 'average'

  const bm: Benchmark = {
    id: `bench-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    organizationId,
    name,
    benchmark,
    metric,
    benchmarkValue,
    actualValue,
    variance,
    status,
    lastUpdated: new Date(),
  }

  const list = benchmarks.get(organizationId) || []
  list.push(bm)
  benchmarks.set(organizationId, list)

  logger.info('benchmark created', {
    organizationId,
    name,
    metric,
    variance,
    status,
  })

  return bm
}

/**
 * Get benchmarks for organization.
 */
export function getOrganizationBenchmarks(
  organizationId: string,
  benchmarkType?: 'industry' | 'peer' | 'internal'
): Benchmark[] {
  const list = benchmarks.get(organizationId) || []
  return benchmarkType ? list.filter((b) => b.benchmark === benchmarkType) : list
}

/**
 * Track cost trend.
 */
export function trackCostTrend(
  entityId: string,
  entityType: string,
  metric: string,
  periods: Array<{ period: string; value: number }>
): CostTrend {
  let direction: 'increasing' | 'decreasing' | 'stable' = 'stable'
  let changePercent = 0

  if (periods.length >= 2) {
    const recent = periods.slice(-3)
    const avg = recent.reduce((sum, p) => sum + p.value, 0) / recent.length
    const previous = periods.slice(-6, -3)
    const prevAvg = previous.length > 0 ? previous.reduce((sum, p) => sum + p.value, 0) / previous.length : avg

    changePercent = ((avg - prevAvg) / prevAvg) * 100
    direction = Math.abs(changePercent) < 5 ? 'stable' : changePercent > 0 ? 'increasing' : 'decreasing'
  }

  const trend: CostTrend = {
    entityId,
    entityType,
    metric,
    direction,
    changePercent,
    periods,
  }

  const key = `${entityType}:${entityId}:${metric}`
  trends.set(key, trend)

  return trend
}

/**
 * Get cost trend.
 */
export function getCostTrend(entityId: string, entityType: string, metric: string): CostTrend | null {
  const key = `${entityType}:${entityId}:${metric}`
  return trends.get(key) || null
}

/**
 * Create cost breakdown.
 */
export function createCostBreakdown(
  entityId: string,
  period: string,
  byTeam: Record<string, number>,
  byProject: Record<string, number>,
  byResourceType: Record<string, number>,
  byCustomer: Record<string, number>,
  byRegion?: Record<string, number>
): CostBreakdown {
  const breakdown: CostBreakdown = {
    entityId,
    period,
    byTeam,
    byProject,
    byResourceType,
    byCustomer,
    byRegion,
  }

  const key = `${entityId}:${period}`
  breakdowns.set(key, breakdown)

  return breakdown
}

/**
 * Get cost breakdown.
 */
export function getCostBreakdown(entityId: string, period: string): CostBreakdown | null {
  const key = `${entityId}:${period}`
  return breakdowns.get(key) || null
}

/**
 * Calculate cost per seat KPI.
 */
export function calculateCostPerSeat(
  totalCost: number,
  headcount: number
): number {
  return headcount > 0 ? totalCost / headcount : 0
}

/**
 * Calculate cost per transaction KPI.
 */
export function calculateCostPerTransaction(
  totalCost: number,
  transactionCount: number
): number {
  return transactionCount > 0 ? totalCost / transactionCount : 0
}

/**
 * Calculate cost per unit KPI.
 */
export function calculateCostPerUnit(
  totalCost: number,
  unitCount: number
): number {
  return unitCount > 0 ? totalCost / unitCount : 0
}

/**
 * Get analytics summary for organization.
 */
export function getAnalyticsSummary(organizationId: string): {
  kpis: PerformanceKPI[]
  benchmarks: Benchmark[]
  trends: CostTrend[]
  topCostDrivers: Array<{ name: string; cost: number; percentage: number }>
} {
  const kpiList = getOrganizationKPIs(organizationId)
  const benchmarkList = getOrganizationBenchmarks(organizationId)
  const trendList = Array.from(trends.values()).filter((t) => t.entityId === organizationId)

  // Find top cost drivers from metrics
  const allMetrics = Array.from(metrics.values()).flat()
  const topBreakdown: Record<string, number> = {}
  allMetrics.forEach((m) => {
    for (const [key, value] of Object.entries(m.breakdown)) {
      topBreakdown[key] = (topBreakdown[key] || 0) + value
    }
  })

  const totalCost = Object.values(topBreakdown).reduce((sum, v) => sum + v, 0)
  const topCostDrivers = Object.entries(topBreakdown)
    .map(([name, cost]) => ({
      name,
      cost,
      percentage: (cost / totalCost) * 100,
    }))
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 5)

  return {
    kpis: kpiList,
    benchmarks: benchmarkList,
    trends: trendList,
    topCostDrivers,
  }
}

/**
 * Clear analytics data (for testing).
 */
export function clearAnalytics(): void {
  metrics.clear()
  kpis.clear()
  benchmarks.clear()
  trends.clear()
  breakdowns.clear()
}
