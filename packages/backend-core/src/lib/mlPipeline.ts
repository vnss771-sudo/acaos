// Phase 9: ML pipeline for model training, evaluation, and inference.
// Enables continuous improvement of predictions through validation and retraining.

import { logger } from './logger.js'

export interface MLModel {
  id: string
  organizationId: string
  name: string
  version: number
  modelType: 'regression' | 'classification' | 'clustering' | 'forecasting'
  algorithm: string
  status: 'training' | 'validating' | 'active' | 'deprecated'
  metrics: {
    accuracy?: number // 0-1
    mape?: number // %
    rmse?: number
    mae?: number
    precision?: number
    recall?: number
    f1?: number
  }
  features: string[]
  hyperparameters: Record<string, unknown>
  trainingDataSize: number
  validationDataSize: number
  testDataSize?: number
  createdAt: Date
  trainingCompletedAt?: Date
  activatedAt?: Date
  deprecatedAt?: Date
}

export interface FeatureImportance {
  id: string
  organizationId: string
  modelId: string
  features: Array<{
    name: string
    importance: number // 0-1
    direction: 'positive' | 'negative' | 'neutral'
  }>
  timestamp: Date
}

export interface ValidationReport {
  id: string
  organizationId: string
  modelId: string
  validationType: 'cross_validation' | 'holdout' | 'time_series_split'
  folds: number
  metrics: {
    meanAccuracy?: number
    stdAccuracy?: number
    meanMAPE?: number
    stdMAPE?: number
    meanRMSE?: number
    stdRMSE?: number
  }
  foldResults: Array<{
    fold: number
    accuracy?: number
    mape?: number
    rmse?: number
    mae?: number
  }>
  timestamp: Date
}

export interface InferenceBatch {
  id: string
  organizationId: string
  modelId: string
  inputSize: number
  outputs: Array<{
    input: Record<string, unknown>
    prediction: number
    confidence: number
    timestamp: Date
  }>
  processingTimeMs: number
  completedAt: Date
}

export interface ModelPerformanceLog {
  id: string
  organizationId: string
  modelId: string
  metric: string
  actualValue: number
  predictedValue: number
  error: number
  errorPercentage: number
  timestamp: Date
}

export interface ModelComparison {
  id: string
  organizationId: string
  models: Array<{
    modelId: string
    name: string
    version: number
    accuracy?: number
    mape?: number
    rmse?: number
    rank: number
  }>
  winner: {
    modelId: string
    name: string
    improvement: number
  }
  timestamp: Date
}

// Storage
const models = new Map<string, MLModel[]>()
const featureImportances = new Map<string, FeatureImportance[]>()
const validationReports = new Map<string, ValidationReport[]>()
const inferenceBatches = new Map<string, InferenceBatch[]>()
const performanceLogs = new Map<string, ModelPerformanceLog[]>()
const modelComparisons = new Map<string, ModelComparison[]>()

/**
 * Create and train a new ML model.
 */
export function createModel(
  organizationId: string,
  name: string,
  modelType: 'regression' | 'classification' | 'clustering' | 'forecasting',
  algorithm: string,
  features: string[],
  hyperparameters: Record<string, unknown> = {},
  trainingDataSize: number = 0,
  validationDataSize: number = 0,
  testDataSize: number = 0
): MLModel {
  const model: MLModel = {
    id: `model-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    organizationId,
    name,
    version: 1,
    modelType,
    algorithm,
    status: 'training',
    metrics: {},
    features,
    hyperparameters,
    trainingDataSize,
    validationDataSize,
    testDataSize,
    createdAt: new Date(),
  }

  const key = `${organizationId}:models`
  const list = models.get(key) || []
  list.push(model)
  models.set(key, list)

  logger.info('model created and training started', {
    organizationId,
    modelId: model.id,
    algorithm,
    features: features.length,
  })

  return model
}

/**
 * Get models.
 */
export function getModels(organizationId: string, status?: string): MLModel[] {
  const key = `${organizationId}:models`
  const list = models.get(key) || []
  return status ? list.filter((m) => m.status === status) : list
}

/**
 * Get model by ID.
 */
export function getModel(organizationId: string, modelId: string): MLModel | null {
  const key = `${organizationId}:models`
  const list = models.get(key) || []
  return list.find((m) => m.id === modelId) || null
}

/**
 * Update model training metrics.
 */
export function updateModelMetrics(
  organizationId: string,
  modelId: string,
  metrics: Partial<MLModel['metrics']>,
  status: 'validating' | 'active' | 'deprecated' = 'validating'
): boolean {
  const model = getModel(organizationId, modelId)
  if (!model) return false

  model.metrics = { ...model.metrics, ...metrics }
  model.status = status
  if (status === 'active') {
    model.activatedAt = new Date()
  }
  if (status === 'validating') {
    model.trainingCompletedAt = new Date()
  }

  logger.info('model metrics updated', {
    organizationId,
    modelId,
    status,
    metrics: model.metrics,
  })

  return true
}

/**
 * Record feature importance.
 */
export function recordFeatureImportance(
  organizationId: string,
  modelId: string,
  features: Array<{ name: string; importance: number; direction: 'positive' | 'negative' | 'neutral' }>
): FeatureImportance {
  const importance: FeatureImportance = {
    id: `fi-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    organizationId,
    modelId,
    features: features.sort((a, b) => b.importance - a.importance),
    timestamp: new Date(),
  }

  const key = `${organizationId}:importance`
  const list = featureImportances.get(key) || []
  list.push(importance)

  // Keep last 500
  const filtered = list.slice(-500)
  featureImportances.set(key, filtered)

  logger.info('feature importance recorded', {
    organizationId,
    modelId,
    topFeature: features[0]?.name,
  })

  return importance
}

/**
 * Get feature importance.
 */
export function getFeatureImportance(organizationId: string, modelId?: string): FeatureImportance[] {
  const key = `${organizationId}:importance`
  const list = featureImportances.get(key) || []
  return modelId ? list.filter((f) => f.modelId === modelId) : list
}

/**
 * Perform cross-validation.
 */
export function crossValidate(
  organizationId: string,
  modelId: string,
  data: Array<{ actual: number; predicted: number }>,
  folds: number = 5
): ValidationReport {
  if (data.length < folds) {
    throw new Error('Insufficient data for cross-validation')
  }

  const foldSize = Math.floor(data.length / folds)
  const foldResults: ValidationReport['foldResults'] = []

  for (let fold = 0; fold < folds; fold++) {
    const start = fold * foldSize
    const end = fold === folds - 1 ? data.length : (fold + 1) * foldSize

    const testSet = data.slice(start, end)
    const trainSet = data.slice(0, start).concat(data.slice(end))

    const metrics = calculateMetrics(testSet)

    foldResults.push({
      fold: fold + 1,
      accuracy: metrics.accuracy,
      mape: metrics.mape,
      rmse: metrics.rmse,
      mae: metrics.mae,
    })
  }

  const report: ValidationReport = {
    id: `val-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    organizationId,
    modelId,
    validationType: 'cross_validation',
    folds,
    metrics: {
      meanAccuracy: foldResults.reduce((sum, f) => sum + (f.accuracy || 0), 0) / folds,
      stdAccuracy: calculateStdDev(foldResults.map((f) => f.accuracy || 0)),
      meanMAPE: foldResults.reduce((sum, f) => sum + (f.mape || 0), 0) / folds,
      stdMAPE: calculateStdDev(foldResults.map((f) => f.mape || 0)),
      meanRMSE: foldResults.reduce((sum, f) => sum + (f.rmse || 0), 0) / folds,
      stdRMSE: calculateStdDev(foldResults.map((f) => f.rmse || 0)),
    },
    foldResults,
    timestamp: new Date(),
  }

  const key = `${organizationId}:validation`
  const list = validationReports.get(key) || []
  list.push(report)

  // Keep last 500
  const filtered = list.slice(-500)
  validationReports.set(key, filtered)

  logger.info('cross-validation completed', {
    organizationId,
    modelId,
    folds,
    meanMAPE: report.metrics.meanMAPE,
  })

  return report
}

/**
 * Run inference batch.
 */
export function runInferenceBatch(
  organizationId: string,
  modelId: string,
  inputs: Array<Record<string, unknown>>
): InferenceBatch {
  const startTime = Date.now()

  const outputs = inputs.map((input, idx) => ({
    input,
    prediction: simulatePrediction(input),
    confidence: 0.85 + Math.random() * 0.1,
    timestamp: new Date(),
  }))

  const processingTimeMs = Date.now() - startTime

  const batch: InferenceBatch = {
    id: `inf-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    organizationId,
    modelId,
    inputSize: inputs.length,
    outputs,
    processingTimeMs,
    completedAt: new Date(),
  }

  const key = `${organizationId}:inference`
  const list = inferenceBatches.get(key) || []
  list.push(batch)

  // Keep last 1000
  const filtered = list.slice(-1000)
  inferenceBatches.set(key, filtered)

  logger.info('inference batch completed', {
    organizationId,
    modelId,
    inputSize: inputs.length,
    processingTimeMs,
  })

  return batch
}

/**
 * Get inference batches.
 */
export function getInferenceBatches(organizationId: string, modelId?: string, hours: number = 24): InferenceBatch[] {
  const key = `${organizationId}:inference`
  const list = inferenceBatches.get(key) || []
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000)

  let filtered = list.filter((b) => b.completedAt >= cutoff)
  if (modelId) {
    filtered = filtered.filter((b) => b.modelId === modelId)
  }

  return filtered
}

/**
 * Log model performance.
 */
export function logModelPerformance(
  organizationId: string,
  modelId: string,
  metric: string,
  actualValue: number,
  predictedValue: number
): ModelPerformanceLog {
  const error = actualValue - predictedValue
  const errorPercentage = (Math.abs(error) / actualValue) * 100

  const log: ModelPerformanceLog = {
    id: `perf-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    organizationId,
    modelId,
    metric,
    actualValue,
    predictedValue,
    error,
    errorPercentage,
    timestamp: new Date(),
  }

  const key = `${organizationId}:performance`
  const list = performanceLogs.get(key) || []
  list.push(log)

  // Keep last 10000
  const filtered = list.slice(-10000)
  performanceLogs.set(key, filtered)

  return log
}

/**
 * Get performance logs.
 */
export function getPerformanceLogs(
  organizationId: string,
  modelId?: string,
  metric?: string,
  days: number = 30
): ModelPerformanceLog[] {
  const key = `${organizationId}:performance`
  const list = performanceLogs.get(key) || []
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  let filtered = list.filter((p) => p.timestamp >= cutoff)
  if (modelId) {
    filtered = filtered.filter((p) => p.modelId === modelId)
  }
  if (metric) {
    filtered = filtered.filter((p) => p.metric === metric)
  }

  return filtered
}

/**
 * Compare model performance.
 */
export function compareModels(organizationId: string, modelIds: string[]): ModelComparison {
  const modelList = getModels(organizationId)
  const compareModels = modelList.filter((m) => modelIds.includes(m.id))

  const ranked = compareModels
    .map((m) => ({
      modelId: m.id,
      name: m.name,
      version: m.version,
      accuracy: m.metrics.accuracy || 0,
      mape: m.metrics.mape || 100,
      rmse: m.metrics.rmse || Infinity,
      rank: 0,
    }))
    .sort((a, b) => {
      let scoreA = (a.accuracy * 0.4 + (100 - a.mape) * 0.4 + (100 - Math.min(a.rmse, 100)) * 0.2) / 100
      let scoreB = (b.accuracy * 0.4 + (100 - b.mape) * 0.4 + (100 - Math.min(b.rmse, 100)) * 0.2) / 100
      return scoreB - scoreA
    })
    .map((m, idx) => ({ ...m, rank: idx + 1 }))

  const winner = ranked[0]
  const baseline = ranked[1]

  const comparison: ModelComparison = {
    id: `comp-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    organizationId,
    models: ranked,
    winner: {
      modelId: winner.modelId,
      name: winner.name,
      improvement: baseline ? ((baseline.mape - winner.mape) / baseline.mape) * 100 : 0,
    },
    timestamp: new Date(),
  }

  const key = `${organizationId}:comparisons`
  const list = modelComparisons.get(key) || []
  list.push(comparison)

  // Keep last 100
  const filtered = list.slice(-100)
  modelComparisons.set(key, filtered)

  logger.info('model comparison completed', {
    organizationId,
    models: modelIds.length,
    winner: winner.name,
    improvement: comparison.winner.improvement,
  })

  return comparison
}

/**
 * Get model comparisons.
 */
export function getModelComparisons(organizationId: string): ModelComparison[] {
  const key = `${organizationId}:comparisons`
  return modelComparisons.get(key) || []
}

/**
 * Deprecate model.
 */
export function deprecateModel(organizationId: string, modelId: string): boolean {
  const model = getModel(organizationId, modelId)
  if (!model) return false

  model.status = 'deprecated'
  model.deprecatedAt = new Date()

  logger.info('model deprecated', {
    organizationId,
    modelId,
  })

  return true
}

/**
 * Calculate metrics from predictions.
 */
function calculateMetrics(data: Array<{ actual: number; predicted: number }>): Record<string, number> {
  if (data.length === 0) {
    return { accuracy: 0, mape: 0, rmse: 0, mae: 0 }
  }

  const errors = data.map((d) => d.actual - d.predicted)
  const absErrors = errors.map((e) => Math.abs(e))
  const percentErrors = data.map((d) => Math.abs((d.actual - d.predicted) / d.actual) * 100)

  const mape = percentErrors.reduce((a, b) => a + b, 0) / data.length
  const rmse = Math.sqrt(errors.reduce((sum, e) => sum + e * e, 0) / data.length)
  const mae = absErrors.reduce((a, b) => a + b, 0) / data.length

  // Simple accuracy: within 5% error
  const accuracy = data.filter((d) => Math.abs((d.actual - d.predicted) / d.actual) < 0.05).length / data.length

  return { accuracy, mape, rmse, mae }
}

/**
 * Calculate standard deviation.
 */
function calculateStdDev(values: number[]): number {
  if (values.length === 0) return 0
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  return Math.sqrt(values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length)
}

/**
 * Simulate prediction for demo purposes.
 */
function simulatePrediction(input: Record<string, unknown>): number {
  return Math.random() * 10000
}

/**
 * Clear ML pipeline data (for testing).
 */
export function clearMLPipeline(): void {
  models.clear()
  featureImportances.clear()
  validationReports.clear()
  inferenceBatches.clear()
  performanceLogs.clear()
  modelComparisons.clear()
}
