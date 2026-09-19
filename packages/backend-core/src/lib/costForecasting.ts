// Phase 4.5: Predictive cost forecasting and budget tracking.
// Analyzes usage patterns to forecast month-end costs and identify
// cost optimization opportunities.

import { logger } from './logger.js'

export interface UsagePattern {
  metric: string
  dailyAverage: number
  dailyStdDev: number
  peakDaily: number
  trend: 'stable' | 'increasing' | 'decreasing' | 'volatile'
  trendPercentage: number // % change over period
}

export interface BudgetAlert {
  workspaceId: string
  projectedMonthEnd: number
  budget: number
  percentOfBudget: number
  daysRemaining: number
  recommendation: string
  severity: 'info' | 'warning' | 'critical'
}

export interface CostOptimization {
  workspaceId: string
  metric: string
  currentUsage: number
  potentialSavings: number
  savingsPercentage: number
  recommendation: string
  priority: 'low' | 'medium' | 'high'
}

export interface UsageBreakdown {
  metric: string
  dailyAverage: number
  monthlyProjection: number
  costImpact: number
  percentOfTotal: number
}

// Store daily usage patterns for trend analysis
interface DailyMetrics {
  date: string
  apiCalls: number
  emailsSent: number
  dbQueries: number
  storageBytes: number
  aiTokens: number
}

const dailyMetricsHistory = new Map<string, DailyMetrics[]>()
const MAX_DAYS_HISTORY = 90

/**
 * Record daily metrics for a workspace.
 */
export function recordDailyMetrics(
  workspaceId: string,
  metrics: {
    apiCalls: number
    emailsSent: number
    dbQueries: number
    storageBytes: number
    aiTokens: number
  }
): void {
  const history = dailyMetricsHistory.get(workspaceId) || []
  const today = new Date().toISOString().split('T')[0]

  // Remove old entry for today if exists
  const todayIndex = history.findIndex((m) => m.date === today)
  if (todayIndex >= 0) {
    history.splice(todayIndex, 1)
  }

  history.push({
    date: today,
    ...metrics,
  })

  // Keep only last 90 days
  if (history.length > MAX_DAYS_HISTORY) {
    history.splice(0, history.length - MAX_DAYS_HISTORY)
  }

  dailyMetricsHistory.set(workspaceId, history)
}

/**
 * Analyze usage pattern for a metric.
 */
export function analyzeUsagePattern(
  workspaceId: string,
  metric: 'apiCalls' | 'emailsSent' | 'dbQueries' | 'storageBytes' | 'aiTokens',
  days: number = 30
): UsagePattern {
  const history = dailyMetricsHistory.get(workspaceId) || []

  if (history.length < 2) {
    return {
      metric,
      dailyAverage: 0,
      dailyStdDev: 0,
      peakDaily: 0,
      trend: 'stable',
      trendPercentage: 0,
    }
  }

  // Get last N days of data
  const recentDays = history.slice(-days)
  const values = recentDays.map((m) => m[metric] || 0)

  // Calculate statistics
  const average = values.reduce((a, b) => a + b, 0) / values.length
  const variance = values.reduce((sum, val) => sum + Math.pow(val - average, 2), 0) / values.length
  const stdDev = Math.sqrt(variance)
  const peak = Math.max(...values)

  // Analyze trend
  const firstHalf = values.slice(0, Math.floor(values.length / 2))
  const secondHalf = values.slice(Math.floor(values.length / 2))
  const firstAvg = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length
  const secondAvg = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length
  const trendPercentage = ((secondAvg - firstAvg) / firstAvg) * 100

  let trend: 'stable' | 'increasing' | 'decreasing' | 'volatile'
  if (stdDev > average * 0.5) {
    trend = 'volatile'
  } else if (trendPercentage > 10) {
    trend = 'increasing'
  } else if (trendPercentage < -10) {
    trend = 'decreasing'
  } else {
    trend = 'stable'
  }

  return {
    metric,
    dailyAverage: Math.round(average),
    dailyStdDev: Math.round(stdDev),
    peakDaily: peak,
    trend,
    trendPercentage: Math.round(trendPercentage * 10) / 10,
  }
}

/**
 * Forecast total month-end cost based on patterns.
 */
export function forecastMonthendCost(
  workspaceId: string,
  baseTierCost: number,
  overagePricing: Record<string, number>,
  daysElapsed: number
): {
  projectedTotal: number
  projectedOverage: number
  confidence: number
  breakdown: UsageBreakdown[]
} {
  const history = dailyMetricsHistory.get(workspaceId) || []

  if (history.length === 0) {
    return {
      projectedTotal: baseTierCost,
      projectedOverage: 0,
      confidence: 0,
      breakdown: [],
    }
  }

  const now = new Date()
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
  const daysRemaining = daysInMonth - daysElapsed

  // Analyze each metric
  const breakdown: UsageBreakdown[] = []
  let totalOverageCost = 0

  const metrics = [
    { key: 'apiCalls', name: 'API Calls' },
    { key: 'emailsSent', name: 'Emails Sent' },
    { key: 'dbQueries', name: 'Database Queries' },
    { key: 'aiTokens', name: 'AI Tokens' },
  ]

  for (const { key, name } of metrics) {
    const pattern = analyzeUsagePattern(workspaceId, key as any, daysElapsed)
    const projectedMonthly = pattern.dailyAverage * daysInMonth

    // Estimate overage cost (simplified)
    const pricingPerUnit = overagePricing[key] || 0
    const overageCost = Math.max(0, projectedMonthly) * pricingPerUnit

    breakdown.push({
      metric: name,
      dailyAverage: pattern.dailyAverage,
      monthlyProjection: Math.round(projectedMonthly),
      costImpact: Math.round(overageCost * 100) / 100,
      percentOfTotal: 0, // Updated below
    })

    totalOverageCost += overageCost
  }

  // Calculate percentages
  const totalOverage = breakdown.reduce((sum, b) => sum + b.costImpact, 0)
  breakdown.forEach((b) => {
    b.percentOfTotal = totalOverage > 0 ? (b.costImpact / totalOverage) * 100 : 0
  })

  // Confidence based on data recency
  const confidence = Math.min(100, Math.round((daysElapsed / daysInMonth) * 100))

  return {
    projectedTotal: Math.round((baseTierCost + totalOverageCost) * 100) / 100,
    projectedOverage: Math.round(totalOverageCost * 100) / 100,
    confidence,
    breakdown,
  }
}

/**
 * Identify cost optimization opportunities.
 */
export function identifyCostOptimizations(
  workspaceId: string,
  currentUsage: { [key: string]: number }
): CostOptimization[] {
  const history = dailyMetricsHistory.get(workspaceId) || []

  if (history.length < 7) {
    return [] // Need at least 7 days of history
  }

  const optimizations: CostOptimization[] = []

  // Check for high storage usage
  const recentStorage = history.slice(-7).map((m) => m.storageBytes)
  const avgStorage = recentStorage.reduce((a, b) => a + b, 0) / recentStorage.length
  const maxStorage = Math.max(...recentStorage)

  if (maxStorage > avgStorage * 1.5) {
    optimizations.push({
      workspaceId,
      metric: 'storage',
      currentUsage: maxStorage,
      potentialSavings: (maxStorage - avgStorage) * 0.25 * 0.0001, // Rough cost estimate
      savingsPercentage: ((maxStorage - avgStorage) / maxStorage) * 100,
      recommendation: 'Implement storage cleanup policies for old files/records',
      priority: 'medium',
    })
  }

  // Check for N+1 query patterns (high DB queries)
  const recentQueries = history.slice(-7).map((m) => m.dbQueries)
  const avgQueries = recentQueries.reduce((a, b) => a + b, 0) / recentQueries.length
  const queryTrend = analyzeUsagePattern(workspaceId, 'dbQueries', 7)

  if (queryTrend.trend === 'increasing' || queryTrend.trend === 'volatile') {
    optimizations.push({
      workspaceId,
      metric: 'database_queries',
      currentUsage: Math.round(avgQueries),
      potentialSavings: Math.round(avgQueries * 0.2 * 0.00001 * 100) / 100, // 20% reduction estimate
      savingsPercentage: 20,
      recommendation: 'Review for N+1 queries and missing indexes (see /api/ops/optimization)',
      priority: 'high',
    })
  }

  // Check for expensive API calls
  const recentApiCalls = history.slice(-7).map((m) => m.apiCalls)
  const avgApiCalls = recentApiCalls.reduce((a, b) => a + b, 0) / recentApiCalls.length
  const apiTrend = analyzeUsagePattern(workspaceId, 'apiCalls', 7)

  if (apiTrend.trendPercentage > 20) {
    optimizations.push({
      workspaceId,
      metric: 'api_calls',
      currentUsage: Math.round(avgApiCalls),
      potentialSavings: Math.round(avgApiCalls * 0.15 * 0.001 * 100) / 100, // 15% reduction estimate
      savingsPercentage: 15,
      recommendation: 'API calls increasing. Implement caching or batch operations',
      priority: 'medium',
    })
  }

  // Check for expensive AI token usage
  const recentTokens = history.slice(-7).map((m) => m.aiTokens)
  if (recentTokens.some((t) => t > 0)) {
    const avgTokens = recentTokens.reduce((a, b) => a + b, 0) / recentTokens.length
    optimizations.push({
      workspaceId,
      metric: 'ai_tokens',
      currentUsage: Math.round(avgTokens),
      potentialSavings: Math.round(avgTokens * 0.25 * 0.000002 * 100) / 100, // 25% reduction estimate
      savingsPercentage: 25,
      recommendation: 'Implement prompt caching or use faster models for non-critical tasks',
      priority: 'high',
    })
  }

  return optimizations.sort((a, b) => {
    const priorityOrder = { high: 0, medium: 1, low: 2 }
    return priorityOrder[a.priority] - priorityOrder[b.priority]
  })
}

/**
 * Check budget and generate alerts.
 */
export function checkBudgetStatus(
  workspaceId: string,
  currentMonthCost: number,
  monthlyBudget: number,
  daysElapsed: number
): BudgetAlert | null {
  const now = new Date()
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
  const daysRemaining = daysInMonth - daysElapsed

  const percentOfBudget = (currentMonthCost / monthlyBudget) * 100

  if (percentOfBudget > 100) {
    return {
      workspaceId,
      projectedMonthEnd: currentMonthCost,
      budget: monthlyBudget,
      percentOfBudget,
      daysRemaining,
      recommendation: 'Budget exceeded. Implement cost controls immediately.',
      severity: 'critical',
    }
  } else if (percentOfBudget > 85) {
    return {
      workspaceId,
      projectedMonthEnd: currentMonthCost,
      budget: monthlyBudget,
      percentOfBudget,
      daysRemaining,
      recommendation: `${daysRemaining} days remaining. Monitor usage closely.`,
      severity: 'warning',
    }
  } else if (percentOfBudget > 70) {
    return {
      workspaceId,
      projectedMonthEnd: currentMonthCost,
      budget: monthlyBudget,
      percentOfBudget,
      daysRemaining,
      recommendation: `Trending toward ${(percentOfBudget * (daysInMonth / daysElapsed)).toFixed(0)}% of budget by month-end.`,
      severity: 'info',
    }
  }

  return null
}

/**
 * Get usage history for a workspace.
 */
export function getUsageHistory(workspaceId: string): DailyMetrics[] {
  return dailyMetricsHistory.get(workspaceId) || []
}

/**
 * Clear usage history (for testing).
 */
export function clearUsageHistory(): void {
  dailyMetricsHistory.clear()
}
