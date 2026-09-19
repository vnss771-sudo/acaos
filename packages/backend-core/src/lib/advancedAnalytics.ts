// Phase 9: Advanced analytics with time-series forecasting, anomaly detection, and trend analysis.
// Enables predictive insights, cost clustering, and pattern recognition.

import { logger } from './logger.js'

export interface TimeSeriesDataPoint {
  timestamp: Date
  value: number
  confidence?: number
}

export interface Forecast {
  id: string
  organizationId: string
  metric: string
  forecastType: 'cost' | 'budget_usage' | 'resource_count'
  period: 'daily' | 'weekly' | 'monthly'
  algorithm: 'exponential_smoothing' | 'linear_regression' | 'arima'
  predictions: Array<{
    timestamp: Date
    predictedValue: number
    lowerBound: number
    upperBound: number
    confidence: number
  }>
  accuracy?: number // MAPE or similar
  trainingDataPoints: number
  createdAt: Date
}

export interface AnomalyDetectionResult {
  id: string
  organizationId: string
  metric: string
  detectionMethod: 'isolation_forest' | 'statistical' | 'dbscan'
  anomalies: Array<{
    timestamp: Date
    value: number
    anomalyScore: number // 0-1
    severity: 'low' | 'medium' | 'high' | 'critical'
    expectedValue: number
    deviation: number
  }>
  totalDataPoints: number
  anomalyCount: number
  anomalyPercentage: number
  createdAt: Date
}

export interface TrendAnalysis {
  id: string
  organizationId: string
  metric: string
  period: 'week' | 'month' | 'quarter'
  direction: 'increasing' | 'decreasing' | 'stable'
  trend: Array<{
    label: string
    value: number
    change: number
    changePercentage: number
  }>
  slopeChange: number // Rate of change
  seasonalityDetected: boolean
  seasonalPattern?: 'weekly' | 'monthly' | 'quarterly'
  cycleLength?: number // Days in cycle
  createdAt: Date
}

export interface CostCluster {
  id: string
  organizationId: string
  name: string
  clusterType: 'cost_center' | 'team' | 'service' | 'behavioral'
  members: Array<{
    entityId: string
    entityType: string
    cost: number
    percentage: number
  }>
  centroid: {
    cost: number
    volatility: number
    trend: string
  }
  characterization: string
  similarityScore: number
  createdAt: Date
}

export interface PatternRecognition {
  id: string
  organizationId: string
  pattern: 'spikes' | 'cycles' | 'drift' | 'clustering' | 'outliers'
  description: string
  confidence: number // 0-1
  occurrences: number
  lastOccurrence: Date
  affectedEntities: string[]
  recommendation?: string
  createdAt: Date
}

export interface CapacityPlan {
  id: string
  organizationId: string
  metric: string
  currentCapacity: number
  projectedDemand: Array<{
    months: number
    demand: number
    utilizationPercentage: number
  }>
  bottlenecks: Array<{
    entity: string
    currentUtilization: number
    projectedCritical: number // Month when > 90%
    recommendation: string
  }>
  createdAt: Date
}

// Storage
const forecasts = new Map<string, Forecast[]>()
const anomalyResults = new Map<string, AnomalyDetectionResult[]>()
const trendAnalyses = new Map<string, TrendAnalysis[]>()
const costClusters = new Map<string, CostCluster[]>()
const patternRecognitions = new Map<string, PatternRecognition[]>()
const capacityPlans = new Map<string, CapacityPlan[]>()

/**
 * Generate cost forecast using exponential smoothing.
 */
export function generateForecast(
  organizationId: string,
  metric: string,
  forecastType: 'cost' | 'budget_usage' | 'resource_count',
  historicalData: TimeSeriesDataPoint[],
  periods: number = 30,
  algorithm: 'exponential_smoothing' | 'linear_regression' | 'arima' = 'exponential_smoothing'
): Forecast {
  if (historicalData.length < 7) {
    throw new Error('Insufficient historical data for forecasting (minimum 7 points)')
  }

  const sortedData = [...historicalData].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
  const values = sortedData.map((d) => d.value)

  let predictions: Forecast['predictions'] = []

  if (algorithm === 'exponential_smoothing') {
    predictions = exponentialSmoothingForecast(values, periods, sortedData)
  } else if (algorithm === 'linear_regression') {
    predictions = linearRegressionForecast(values, periods, sortedData)
  } else if (algorithm === 'arima') {
    predictions = arimaForecast(values, periods, sortedData)
  }

  const forecast: Forecast = {
    id: `fcst-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    organizationId,
    metric,
    forecastType,
    period: determinePeriod(periods),
    algorithm,
    predictions,
    trainingDataPoints: sortedData.length,
    createdAt: new Date(),
    accuracy: calculateMAPE(values, predictions),
  }

  const key = `${organizationId}:forecasts`
  const list = forecasts.get(key) || []
  list.push(forecast)

  // Keep last 1000 forecasts
  const filtered = list.slice(-1000)
  forecasts.set(key, filtered)

  logger.info('forecast generated', {
    organizationId,
    metric,
    algorithm,
    periods,
    accuracy: forecast.accuracy,
  })

  return forecast
}

/**
 * Exponential smoothing forecast.
 */
function exponentialSmoothingForecast(
  values: number[],
  periods: number,
  originalData: TimeSeriesDataPoint[]
): Forecast['predictions'] {
  const alpha = 0.3 // Smoothing parameter
  let smoothed = values[0]
  const predictions: Forecast['predictions'] = []
  const lastDate = originalData[originalData.length - 1].timestamp

  for (let i = 0; i < periods; i++) {
    const trend = i === 0 ? 0 : (smoothed - values[Math.max(0, values.length - 1)]) * 0.1
    smoothed = alpha * values[Math.max(0, values.length - 1 - i)] + (1 - alpha) * smoothed + trend

    const nextDate = new Date(lastDate.getTime() + (i + 1) * 24 * 60 * 60 * 1000)
    const variance = Math.sqrt(values.reduce((sum, v) => sum + Math.pow(v - smoothed, 2), 0) / values.length)

    predictions.push({
      timestamp: nextDate,
      predictedValue: Math.max(0, smoothed),
      lowerBound: Math.max(0, smoothed - 1.96 * variance),
      upperBound: smoothed + 1.96 * variance,
      confidence: 0.95,
    })
  }

  return predictions
}

/**
 * Linear regression forecast.
 */
function linearRegressionForecast(
  values: number[],
  periods: number,
  originalData: TimeSeriesDataPoint[]
): Forecast['predictions'] {
  const n = values.length
  const xMean = (n - 1) / 2
  const yMean = values.reduce((a, b) => a + b, 0) / n
  const numerator = values.reduce((sum, y, i) => sum + (i - xMean) * (y - yMean), 0)
  const denominator = values.reduce((sum, _, i) => sum + Math.pow(i - xMean, 2), 0)
  const slope = denominator > 0 ? numerator / denominator : 0
  const intercept = yMean - slope * xMean

  const predictions: Forecast['predictions'] = []
  const lastDate = originalData[n - 1].timestamp
  const variance = values.reduce((sum, v) => sum + Math.pow(v - (intercept + slope * (values.indexOf(v) - xMean)), 2), 0) / n

  for (let i = 0; i < periods; i++) {
    const x = n - 1 + i + 1
    const predictedValue = intercept + slope * (x - xMean)
    const nextDate = new Date(lastDate.getTime() + (i + 1) * 24 * 60 * 60 * 1000)

    predictions.push({
      timestamp: nextDate,
      predictedValue: Math.max(0, predictedValue),
      lowerBound: Math.max(0, predictedValue - 1.96 * Math.sqrt(variance)),
      upperBound: predictedValue + 1.96 * Math.sqrt(variance),
      confidence: 0.95,
    })
  }

  return predictions
}

/**
 * ARIMA-style forecast (simplified).
 */
function arimaForecast(
  values: number[],
  periods: number,
  originalData: TimeSeriesDataPoint[]
): Forecast['predictions'] {
  const predictions: Forecast['predictions'] = []
  const lastDate = originalData[originalData.length - 1].timestamp
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length
  const lastValue = values[values.length - 1]

  for (let i = 0; i < periods; i++) {
    const decay = Math.pow(0.95, i) // Decay confidence over time
    const nextDate = new Date(lastDate.getTime() + (i + 1) * 24 * 60 * 60 * 1000)

    predictions.push({
      timestamp: nextDate,
      predictedValue: mean + (lastValue - mean) * decay,
      lowerBound: mean - 1.96 * Math.sqrt(variance) * decay,
      upperBound: mean + 1.96 * Math.sqrt(variance) * decay,
      confidence: 0.95 * decay,
    })
  }

  return predictions
}

/**
 * Detect anomalies using statistical method.
 */
export function detectAnomalies(
  organizationId: string,
  metric: string,
  data: TimeSeriesDataPoint[],
  method: 'isolation_forest' | 'statistical' | 'dbscan' = 'statistical',
  threshold: number = 3 // Standard deviations
): AnomalyDetectionResult {
  if (data.length < 10) {
    throw new Error('Insufficient data for anomaly detection (minimum 10 points)')
  }

  const values = data.map((d) => d.value)
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length
  const stdDev = Math.sqrt(variance)

  const anomalies = data
    .map((d, i) => ({
      timestamp: d.timestamp,
      value: d.value,
      expectedValue: mean,
      deviation: Math.abs(d.value - mean) / stdDev,
    }))
    .filter((a) => a.deviation > threshold)
    .map((a) => ({
      timestamp: a.timestamp,
      value: a.value,
      anomalyScore: Math.min(a.deviation / (threshold * 2), 1),
      severity: a.deviation > threshold * 2 ? 'critical' : a.deviation > threshold * 1.5 ? 'high' : 'medium' as const,
      expectedValue: a.expectedValue,
      deviation: a.deviation,
    }))

  const result: AnomalyDetectionResult = {
    id: `anom-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    organizationId,
    metric,
    detectionMethod: method,
    anomalies,
    totalDataPoints: data.length,
    anomalyCount: anomalies.length,
    anomalyPercentage: (anomalies.length / data.length) * 100,
    createdAt: new Date(),
  }

  const key = `${organizationId}:anomalies`
  const list = anomalyResults.get(key) || []
  list.push(result)

  // Keep last 500 results
  const filtered = list.slice(-500)
  anomalyResults.set(key, filtered)

  logger.info('anomaly detection completed', {
    organizationId,
    metric,
    anomalies: anomalies.length,
    method,
  })

  return result
}

/**
 * Analyze trends in cost data.
 */
export function analyzeTrends(
  organizationId: string,
  metric: string,
  data: TimeSeriesDataPoint[],
  period: 'week' | 'month' | 'quarter' = 'month'
): TrendAnalysis {
  if (data.length < 3) {
    throw new Error('Insufficient data for trend analysis')
  }

  const sorted = [...data].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
  const values = sorted.map((d) => d.value)

  // Calculate slope
  const n = values.length
  const xMean = (n - 1) / 2
  const yMean = values.reduce((a, b) => a + b, 0) / n
  const numerator = values.reduce((sum, y, i) => sum + (i - xMean) * (y - yMean), 0)
  const denominator = values.reduce((sum, _, i) => sum + Math.pow(i - xMean, 2), 0)
  const slope = denominator > 0 ? numerator / denominator : 0

  const direction: 'increasing' | 'decreasing' | 'stable' =
    Math.abs(slope) < 0.01 ? 'stable' : slope > 0 ? 'increasing' : 'decreasing'

  const trend = values.map((v, i) => ({
    label: `Point ${i + 1}`,
    value: v,
    change: i === 0 ? 0 : v - values[i - 1],
    changePercentage: i === 0 ? 0 : ((v - values[i - 1]) / values[i - 1]) * 100,
  }))

  const seasonalityDetected = detectSeasonality(values)

  const analysis: TrendAnalysis = {
    id: `trend-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    organizationId,
    metric,
    period,
    direction,
    trend,
    slopeChange: slope,
    seasonalityDetected,
    createdAt: new Date(),
  }

  const key = `${organizationId}:trends`
  const list = trendAnalyses.get(key) || []
  list.push(analysis)

  // Keep last 500 analyses
  const filtered = list.slice(-500)
  trendAnalyses.set(key, filtered)

  logger.info('trend analysis completed', {
    organizationId,
    metric,
    direction,
    seasonality: seasonalityDetected,
  })

  return analysis
}

/**
 * Detect seasonality in time series.
 */
function detectSeasonality(values: number[]): boolean {
  if (values.length < 14) return false

  // Simple seasonal detection: check correlation with lagged values
  const lag7 = 7 // Weekly seasonality
  const differences: number[] = []

  for (let i = lag7; i < values.length; i++) {
    differences.push(Math.abs(values[i] - values[i - lag7]))
  }

  const avgDiff = differences.reduce((a, b) => a + b, 0) / differences.length
  const stdDev = Math.sqrt(differences.reduce((sum, d) => sum + Math.pow(d - avgDiff, 2), 0) / differences.length)

  // Low variation in lagged differences = seasonality
  return stdDev < avgDiff * 0.3
}

/**
 * Cluster costs by behavior.
 */
export function clusterCosts(
  organizationId: string,
  entities: Array<{ id: string; type: string; cost: number; volatility: number; trend: string }>
): CostCluster[] {
  const clusters: CostCluster[] = []

  // K-means clustering (k=3: high, medium, low cost)
  const k = Math.min(3, Math.max(1, Math.ceil(entities.length / 5)))
  const centroids = entities.slice(0, k).map((e) => ({
    cost: e.cost,
    volatility: e.volatility,
    trend: e.trend,
  }))

  const assignments: Map<number, string[]> = new Map()
  for (let c = 0; c < k; c++) {
    assignments.set(c, [])
  }

  // Assign entities to nearest centroid
  entities.forEach((e) => {
    let nearestCluster = 0
    let minDistance = Infinity

    centroids.forEach((centroid, idx) => {
      const distance = Math.sqrt(Math.pow(e.cost - centroid.cost, 2) + Math.pow(e.volatility - centroid.volatility, 2))
      if (distance < minDistance) {
        minDistance = distance
        nearestCluster = idx
      }
    })

    assignments.get(nearestCluster)!.push(e.id)
  })

  // Create clusters
  assignments.forEach((memberIds, clusterIdx) => {
    const members = entities.filter((e) => memberIds.includes(e.id))
    const totalCost = members.reduce((sum, m) => sum + m.cost, 0)
    const avgVolatility = members.reduce((sum, m) => sum + m.volatility, 0) / members.length

    clusters.push({
      id: `clust-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      organizationId,
      name: `Cluster ${clusterIdx + 1}`,
      clusterType: 'behavioral',
      members: members.map((m) => ({
        entityId: m.id,
        entityType: m.type,
        cost: m.cost,
        percentage: (m.cost / totalCost) * 100,
      })),
      centroid: {
        cost: totalCost / members.length,
        volatility: avgVolatility,
        trend: members[0]?.trend || 'stable',
      },
      characterization: `${members.length} entities with avg cost $${(totalCost / members.length).toFixed(2)}`,
      similarityScore: 0.85,
      createdAt: new Date(),
    })
  })

  const key = `${organizationId}:clusters`
  const list = costClusters.get(key) || []
  list.push(...clusters)

  // Keep last 1000 clusters
  const filtered = list.slice(-1000)
  costClusters.set(key, filtered)

  logger.info('cost clustering completed', {
    organizationId,
    clusters: clusters.length,
    totalEntities: entities.length,
  })

  return clusters
}

/**
 * Recognize patterns in cost behavior.
 */
export function recognizePatterns(
  organizationId: string,
  data: TimeSeriesDataPoint[]
): PatternRecognition[] {
  const patterns: PatternRecognition[] = []
  const values = data.map((d) => d.value)

  // Pattern 1: Spikes
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const stdDev = Math.sqrt(values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length)
  const spikes = values.filter((v) => v > mean + 2 * stdDev).length

  if (spikes > 0) {
    patterns.push({
      id: `pat-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      organizationId,
      pattern: 'spikes',
      description: `${spikes} cost spikes detected above 2σ threshold`,
      confidence: Math.min(0.95, spikes / values.length),
      occurrences: spikes,
      lastOccurrence: data[data.length - 1].timestamp,
      affectedEntities: [],
      recommendation: 'Investigate root cause of cost spikes; may indicate misconfiguration or unusual usage',
      createdAt: new Date(),
    })
  }

  // Pattern 2: Cycles
  if (detectSeasonality(values)) {
    patterns.push({
      id: `pat-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      organizationId,
      pattern: 'cycles',
      description: 'Weekly seasonality detected in cost data',
      confidence: 0.85,
      occurrences: Math.floor(values.length / 7),
      lastOccurrence: data[data.length - 1].timestamp,
      affectedEntities: [],
      recommendation: 'Align cost optimization efforts with identified cycles; opportunity for scheduled cost reduction',
      createdAt: new Date(),
    })
  }

  // Pattern 3: Drift
  const firstHalf = values.slice(0, Math.floor(values.length / 2))
  const secondHalf = values.slice(Math.floor(values.length / 2))
  const mean1 = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length
  const mean2 = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length
  const driftPercentage = ((mean2 - mean1) / mean1) * 100

  if (Math.abs(driftPercentage) > 15) {
    patterns.push({
      id: `pat-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      organizationId,
      pattern: 'drift',
      description: `${driftPercentage > 0 ? 'Increasing' : 'Decreasing'} cost trend detected (${Math.abs(driftPercentage).toFixed(1)}%)`,
      confidence: 0.8,
      occurrences: 1,
      lastOccurrence: data[data.length - 1].timestamp,
      affectedEntities: [],
      recommendation: 'Review cost drivers and implement controls to stabilize spending',
      createdAt: new Date(),
    })
  }

  const key = `${organizationId}:patterns`
  const list = patternRecognitions.get(key) || []
  list.push(...patterns)

  // Keep last 500 patterns
  const filtered = list.slice(-500)
  patternRecognitions.set(key, filtered)

  return patterns
}

/**
 * Plan capacity based on projections.
 */
export function planCapacity(
  organizationId: string,
  metric: string,
  currentCapacity: number,
  projectedDemand: Array<{ months: number; demand: number }>
): CapacityPlan {
  const bottlenecks = projectedDemand
    .filter((d) => d.demand > currentCapacity * 0.7)
    .map((d) => ({
      entity: `Month ${d.months}`,
      currentUtilization: (projectedDemand[0]?.demand / currentCapacity) * 100,
      projectedCritical: d.demand > currentCapacity ? d.months : -1,
      recommendation: `Increase capacity by ${Math.ceil((d.demand / currentCapacity - 1) * 100)}% to handle projected demand`,
    }))

  const plan: CapacityPlan = {
    id: `capplan-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    organizationId,
    metric,
    currentCapacity,
    projectedDemand,
    bottlenecks,
    createdAt: new Date(),
  }

  const key = `${organizationId}:capacity`
  const list = capacityPlans.get(key) || []
  list.push(plan)

  // Keep last 100 plans
  const filtered = list.slice(-100)
  capacityPlans.set(key, filtered)

  logger.info('capacity planning completed', {
    organizationId,
    metric,
    bottlenecks: bottlenecks.length,
  })

  return plan
}

/**
 * Get forecasts.
 */
export function getForecasts(organizationId: string, metric?: string): Forecast[] {
  const key = `${organizationId}:forecasts`
  const list = forecasts.get(key) || []
  return metric ? list.filter((f) => f.metric === metric) : list
}

/**
 * Get anomaly results.
 */
export function getAnomalyResults(organizationId: string, metric?: string): AnomalyDetectionResult[] {
  const key = `${organizationId}:anomalies`
  const list = anomalyResults.get(key) || []
  return metric ? list.filter((a) => a.metric === metric) : list
}

/**
 * Get trend analyses.
 */
export function getTrendAnalyses(organizationId: string, metric?: string): TrendAnalysis[] {
  const key = `${organizationId}:trends`
  const list = trendAnalyses.get(key) || []
  return metric ? list.filter((t) => t.metric === metric) : list
}

/**
 * Get cost clusters.
 */
export function getCostClusters(organizationId: string): CostCluster[] {
  const key = `${organizationId}:clusters`
  return costClusters.get(key) || []
}

/**
 * Get recognized patterns.
 */
export function getPatterns(organizationId: string): PatternRecognition[] {
  const key = `${organizationId}:patterns`
  return patternRecognitions.get(key) || []
}

/**
 * Get capacity plans.
 */
export function getCapacityPlans(organizationId: string, metric?: string): CapacityPlan[] {
  const key = `${organizationId}:capacity`
  const list = capacityPlans.get(key) || []
  return metric ? list.filter((p) => p.metric === metric) : list
}

/**
 * Calculate MAPE (Mean Absolute Percentage Error).
 */
function calculateMAPE(actual: number[], predicted: Forecast['predictions']): number {
  if (actual.length === 0 || predicted.length === 0) return 0

  const minLen = Math.min(actual.length, predicted.length)
  const errors = actual.slice(0, minLen).map((a, i) => Math.abs((a - predicted[i].predictedValue) / a))

  return (errors.reduce((sum, e) => sum + e, 0) / minLen) * 100
}

/**
 * Determine period from number of predictions.
 */
function determinePeriod(periods: number): 'daily' | 'weekly' | 'monthly' {
  if (periods <= 30) return 'daily'
  if (periods <= 120) return 'weekly'
  return 'monthly'
}

/**
 * Clear analytics data (for testing).
 */
export function clearAdvancedAnalytics(): void {
  forecasts.clear()
  anomalyResults.clear()
  trendAnalyses.clear()
  costClusters.clear()
  patternRecognitions.clear()
  capacityPlans.clear()
}
