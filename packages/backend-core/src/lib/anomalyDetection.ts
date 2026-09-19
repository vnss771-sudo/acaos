// Phase 4.7: Anomaly detection and intelligent cost optimization.
// Detects unusual usage patterns, attributes costs by team, recommends optimizations.

import { logger } from './logger.js'

export type MetricType = 'api_calls' | 'emails_sent' | 'database_queries' | 'storage_bytes' | 'ai_tokens'
export type AnomalySeverity = 'suspicious' | 'concerning' | 'critical'
export type PatternClassification = 'normal' | 'ramping_up' | 'sustained_high' | 'spike' | 'degradation'
export type OptimizationType = 'query_optimization' | 'feature_deprecation' | 'migration_guide' | 'cost_control'

export interface UsageAnomaly {
  id: string
  workspaceId: string
  metricType: MetricType
  severity: AnomalySeverity
  baselineDaily: number
  baselineStdDev: number
  currentDaily: number
  deviationSigma: number
  detectedAt: Date
  resolvedAt?: Date
  rootCause?: string
  actionTaken?: string
}

export interface CostAttribution {
  workspaceId: string
  totalCost: number
  breakdown: Record<string, number>
  topConsumers: Array<{
    identifier: string // endpoint, team, feature, etc.
    usage: number
    cost: number
    trend: 'stable' | 'increasing' | 'decreasing'
    percentageOfTotal: number
  }>
  lastUpdated: Date
}

export interface UsagePattern {
  workspaceId: string
  metricType: MetricType
  classification: PatternClassification
  confidence: number
  description: string
  triggers: string[]
  dailyAverage: number
  currentDaily: number
  growthRate: number
}

export interface CostOptimization {
  id: string
  workspaceId: string
  title: string
  description: string
  potentialSavings: number
  priority: 'low' | 'medium' | 'high' | 'critical'
  optimizationType: OptimizationType
  actionItems: string[]
  implementationComplexity: 'easy' | 'medium' | 'hard'
  estimatedROI: number // in percent
  createdAt: Date
  implementedAt?: Date
}

export interface CapacityForecast {
  metricType: MetricType
  current: number
  limit: number
  dailyGrowthRate: number
  daysUntilQuotaExceeded: number
  projectedDateExceeded?: Date
  confidence: number
  recommendation: string
}

// Storage (would be DB in production)
const anomalies = new Map<string, UsageAnomaly[]>()
const costAttributions = new Map<string, CostAttribution>()
const usagePatterns = new Map<string, Map<MetricType, UsagePattern>>()
const optimizations = new Map<string, CostOptimization[]>()
const MAX_ANOMALIES = 10000

/**
 * Detect anomalies in workspace usage.
 * Compares current usage to historical baseline using statistical analysis.
 */
export function detectAnomaly(
  workspaceId: string,
  metricType: MetricType,
  currentDaily: number,
  baselineDaily: number,
  baselineStdDev: number
): UsageAnomaly | null {
  if (baselineStdDev === 0) {
    return null // No variance in historical data
  }

  const deviationSigma = (currentDaily - baselineDaily) / baselineStdDev

  // Severity based on standard deviations from mean
  let severity: AnomalySeverity
  if (deviationSigma >= 3) {
    severity = 'critical'
  } else if (deviationSigma >= 2) {
    severity = 'concerning'
  } else if (deviationSigma >= 1.5) {
    severity = 'suspicious'
  } else {
    return null // Not anomalous
  }

  const anomaly: UsageAnomaly = {
    id: `anom-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    workspaceId,
    metricType,
    severity,
    baselineDaily,
    baselineStdDev,
    currentDaily,
    deviationSigma,
    detectedAt: new Date(),
  }

  const list = anomalies.get(workspaceId) || []
  list.push(anomaly)
  anomalies.set(workspaceId, list)

  if (list.length > MAX_ANOMALIES) {
    list.splice(0, list.length - 5000)
  }

  logger.info('anomaly detected', {
    workspaceId,
    metricType,
    severity,
    deviationSigma: deviationSigma.toFixed(2),
    current: currentDaily,
    baseline: baselineDaily,
  })

  return anomaly
}

/**
 * Get recent anomalies for a workspace.
 */
export function getAnomalies(workspaceId: string, limit: number = 50): UsageAnomaly[] {
  const list = anomalies.get(workspaceId) || []
  return list.slice(-limit).reverse()
}

/**
 * Resolve an anomaly (mark as handled).
 */
export function resolveAnomaly(
  workspaceId: string,
  anomalyId: string,
  rootCause: string,
  actionTaken: string
): boolean {
  const list = anomalies.get(workspaceId)
  if (!list) return false

  const anomaly = list.find((a) => a.id === anomalyId)
  if (!anomaly) return false

  anomaly.resolvedAt = new Date()
  anomaly.rootCause = rootCause
  anomaly.actionTaken = actionTaken
  return true
}

/**
 * Classify current usage pattern for a metric.
 */
export function classifyPattern(
  workspaceId: string,
  metricType: MetricType,
  dailyAverage: number,
  currentDaily: number,
  recentTrend: number // % change per day
): UsagePattern {
  const percentChange = ((currentDaily - dailyAverage) / dailyAverage) * 100

  let classification: PatternClassification
  let confidence = 85
  const triggers: string[] = []

  // Normal baseline: within 20% of average
  if (Math.abs(percentChange) <= 20 && Math.abs(recentTrend) <= 2) {
    classification = 'normal'
  }
  // Ramping up: sustained growth trend
  else if (recentTrend > 2 && recentTrend <= 10) {
    classification = 'ramping_up'
    triggers.push('sustained_growth_detected')
    confidence = 80
  }
  // Sustained high: consistently 50%+ above average
  else if (percentChange >= 50 && recentTrend <= 2) {
    classification = 'sustained_high'
    triggers.push('elevated_baseline')
    confidence = 90
  }
  // Spike: sudden increase >50% today
  else if (currentDaily > dailyAverage * 1.5 && recentTrend > 10) {
    classification = 'spike'
    triggers.push('sudden_spike')
    triggers.push('high_growth_rate')
    confidence = 95
  }
  // Degradation: sustained decrease
  else if (recentTrend < -2) {
    classification = 'degradation'
    triggers.push('declining_usage')
    confidence = 80
  } else {
    classification = 'normal'
  }

  const description = describePattern(
    classification,
    currentDaily,
    dailyAverage,
    percentChange,
    recentTrend
  )

  const pattern: UsagePattern = {
    workspaceId,
    metricType,
    classification,
    confidence,
    description,
    triggers,
    dailyAverage,
    currentDaily,
    growthRate: recentTrend,
  }

  const patternMap = usagePatterns.get(workspaceId) || new Map()
  patternMap.set(metricType, pattern)
  usagePatterns.set(workspaceId, patternMap)

  return pattern
}

/**
 * Get current usage pattern.
 */
export function getPattern(workspaceId: string, metricType?: MetricType): UsagePattern[] {
  const patternMap = usagePatterns.get(workspaceId) || new Map()
  if (metricType) {
    const pattern = patternMap.get(metricType)
    return pattern ? [pattern] : []
  }
  return Array.from(patternMap.values())
}

/**
 * Calculate cost attribution by team/project/endpoint.
 */
export function calculateCostAttribution(
  workspaceId: string,
  totalCost: number,
  usageByConsumer: Array<{
    identifier: string
    usage: number
    cost: number
  }>,
  recentTrends: Map<string, number>
): CostAttribution {
  const topConsumers = usageByConsumer
    .map((c) => ({
      identifier: c.identifier,
      usage: c.usage,
      cost: c.cost,
      trend: trendFromPercentage(recentTrends.get(c.identifier) || 0),
      percentageOfTotal: (c.cost / totalCost) * 100,
    }))
    .sort((a, b) => b.cost - a.cost)

  const attribution: CostAttribution = {
    workspaceId,
    totalCost,
    breakdown: usageByConsumer.reduce(
      (acc, c) => {
        acc[c.identifier] = c.cost
        return acc
      },
      {} as Record<string, number>
    ),
    topConsumers,
    lastUpdated: new Date(),
  }

  costAttributions.set(workspaceId, attribution)

  logger.info('cost attribution calculated', {
    workspaceId,
    totalCost,
    topConsumers: topConsumers.length,
    largestConsumer: topConsumers[0]?.identifier,
  })

  return attribution
}

/**
 * Get cost attribution for workspace.
 */
export function getCostAttribution(workspaceId: string): CostAttribution | null {
  return costAttributions.get(workspaceId) || null
}

/**
 * Create a cost optimization recommendation.
 */
export function createOptimization(
  workspaceId: string,
  title: string,
  description: string,
  potentialSavings: number,
  priority: 'low' | 'medium' | 'high' | 'critical',
  optimizationType: OptimizationType,
  actionItems: string[],
  implementationComplexity: 'easy' | 'medium' | 'hard'
): CostOptimization {
  const estimatedROI = calculateROI(potentialSavings, implementationComplexity)

  const optimization: CostOptimization = {
    id: `opt-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    workspaceId,
    title,
    description,
    potentialSavings,
    priority,
    optimizationType,
    actionItems,
    implementationComplexity,
    estimatedROI,
    createdAt: new Date(),
  }

  const list = optimizations.get(workspaceId) || []
  list.push(optimization)
  optimizations.set(workspaceId, list)

  logger.info('optimization created', {
    workspaceId,
    title,
    savings: `$${potentialSavings}`,
    priority,
  })

  return optimization
}

/**
 * Get optimizations for workspace.
 */
export function getOptimizations(
  workspaceId: string,
  type?: OptimizationType,
  limit: number = 50
): CostOptimization[] {
  let list = optimizations.get(workspaceId) || []
  if (type) {
    list = list.filter((o) => o.optimizationType === type)
  }
  return list.slice(-limit).reverse()
}

/**
 * Mark optimization as implemented.
 */
export function markOptimizationImplemented(workspaceId: string, optimizationId: string): boolean {
  const list = optimizations.get(workspaceId)
  if (!list) return false

  const opt = list.find((o) => o.id === optimizationId)
  if (!opt) return false

  opt.implementedAt = new Date()
  return true
}

/**
 * Forecast when quota will be exceeded.
 */
export function forecastQuotaExceeded(
  metricType: MetricType,
  current: number,
  limit: number,
  dailyAverage: number,
  growthRate: number // % per day
): CapacityForecast {
  const remaining = limit - current
  const dailyGrowth = dailyAverage * (growthRate / 100)
  const daysRemaining = dailyGrowth > 0 ? Math.ceil(remaining / dailyGrowth) : -1

  const projectedDateExceeded =
    daysRemaining > 0 ? new Date(Date.now() + daysRemaining * 24 * 60 * 60 * 1000) : undefined

  // Confidence decreases if growth rate varies (volatile usage)
  const confidence = Math.max(50, 90 - Math.abs(growthRate) * 2)

  const recommendation = generateQuotaRecommendation(
    metricType,
    daysRemaining,
    current,
    limit,
    growthRate
  )

  return {
    metricType,
    current,
    limit,
    dailyGrowthRate: growthRate,
    daysUntilQuotaExceeded: Math.max(daysRemaining, 0),
    projectedDateExceeded,
    confidence,
    recommendation,
  }
}

/**
 * Get recommendations for quota optimization and cost reduction.
 */
export function getOptimizationRecommendations(
  workspaceId: string,
  usagePatterns: Array<{ metricType: MetricType; dailyAverage: number; growthRate: number }>,
  topConsumers: Array<{ name: string; cost: number }>,
  totalCost: number
): string[] {
  const recommendations: string[] = []

  // Pattern-based recommendations
  for (const pattern of usagePatterns) {
    if (pattern.growthRate > 5) {
      recommendations.push(
        `Usage of ${pattern.metricType} is growing ${pattern.growthRate}% daily. Consider investigating top consumers and optimizing queries.`
      )
    }
  }

  // Cost concentration recommendations
  if (topConsumers.length > 0 && topConsumers[0].cost > totalCost * 0.5) {
    recommendations.push(
      `${topConsumers[0].name} represents ${((topConsumers[0].cost / totalCost) * 100).toFixed(0)}% of costs. Prioritize optimizing this area.`
    )
  }

  // Feature-specific recommendations
  if (totalCost > 1000) {
    recommendations.push('At high usage levels, consider enabling query caching to reduce redundant queries.')
    recommendations.push('Review and optimize batch jobs—they may benefit from scheduling during off-peak hours.')
  }

  return recommendations
}

// Helpers

function describePattern(
  classification: PatternClassification,
  current: number,
  average: number,
  percentChange: number,
  growthRate: number
): string {
  switch (classification) {
    case 'normal':
      return `Usage is normal. Currently ${current}/day vs. average ${average}/day.`
    case 'ramping_up':
      return `Usage is ramping up at ${growthRate.toFixed(1)}%/day. If trend continues, quota will be exceeded in ~${Math.ceil(30 / growthRate)} days.`
    case 'sustained_high':
      return `Usage is consistently ${percentChange.toFixed(0)}% above baseline. Current: ${current}/day vs. baseline ${average}/day.`
    case 'spike':
      return `Sudden spike detected. Current usage ${percentChange.toFixed(0)}% above normal (${current} vs. ${average}/day).`
    case 'degradation':
      return `Usage is declining at ${Math.abs(growthRate).toFixed(1)}%/day. Current: ${current}/day vs. baseline ${average}/day.`
  }
}

function trendFromPercentage(percentage: number): 'stable' | 'increasing' | 'decreasing' {
  if (Math.abs(percentage) < 2) return 'stable'
  if (percentage > 0) return 'increasing'
  return 'decreasing'
}

function calculateROI(potentialSavings: number, complexity: string): number {
  const complexityMultiplier = {
    easy: 1.5,
    medium: 1.0,
    hard: 0.6,
  }[complexity] || 1.0

  return Math.round(potentialSavings * complexityMultiplier)
}

function generateQuotaRecommendation(
  metricType: MetricType,
  daysRemaining: number,
  current: number,
  limit: number,
  growthRate: number
): string {
  const percentUsed = (current / limit) * 100

  if (daysRemaining <= 7) {
    return `URGENT: ${metricType} quota will be exceeded in ~${daysRemaining} days at current growth rate (${growthRate.toFixed(1)}%/day). Upgrade plan immediately or implement usage restrictions.`
  } else if (daysRemaining <= 14) {
    return `HIGH: ${metricType} quota will be exceeded in ~${daysRemaining} days. Recommend plan upgrade or implementing cost controls.`
  } else if (daysRemaining <= 30) {
    return `MEDIUM: ${metricType} quota will be exceeded in ~${daysRemaining} days. Monitor and plan for upgrade.`
  } else {
    return `${percentUsed.toFixed(0)}% of ${metricType} quota used. Continue monitoring usage patterns.`
  }
}

/**
 * Clear anomaly data (for testing).
 */
export function clearAnomalies(): void {
  anomalies.clear()
  costAttributions.clear()
  usagePatterns.clear()
  optimizations.clear()
}
