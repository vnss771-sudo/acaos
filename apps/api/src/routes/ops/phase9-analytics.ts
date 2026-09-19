import { Router, Request, Response } from 'express'
import { requireAuth } from '../../middleware/auth.js'
import {
  generateForecast,
  detectAnomalies,
  analyzeTrends,
  clusterCosts,
  recognizePatterns,
  planCapacity,
  getForecasts,
  getAnomalyResults,
  getTrendAnalyses,
  getCostClusters,
  getPatterns,
  getCapacityPlans,
  clearAdvancedAnalytics,
} from '@acaos/backend-core/lib/advancedAnalytics.js'
import {
  createModel,
  getModels,
  getModel,
  updateModelMetrics,
  recordFeatureImportance,
  getFeatureImportance,
  crossValidate,
  runInferenceBatch,
  getInferenceBatches,
  logModelPerformance,
  getPerformanceLogs,
  compareModels,
  getModelComparisons,
  deprecateModel,
  clearMLPipeline,
} from '@acaos/backend-core/lib/mlPipeline.js'
import {
  generateRecommendation,
  getRecommendations,
  getRecommendation,
  updateRecommendationStatus,
  approveRecommendation,
  rejectRecommendation,
  assessRisk,
  getRiskAssessments,
  analyzeImpact,
  getImpactAnalyses,
  calculateROI,
  getROICalculations,
  groupRecommendations,
  getRecommendationGroups,
  getRecommendationsSummary,
  clearRecommendations,
} from '@acaos/backend-core/lib/recommendationEngine.js'

export const phase9AnalyticsRouter = Router()

// ============================================================================
// FORECASTING ENDPOINTS
// ============================================================================

phase9AnalyticsRouter.post('/forecasts', requireAuth, (req: Request, res: Response) => {
  const {
    organizationId,
    metric,
    forecastType,
    historicalData,
    periods = 30,
    algorithm = 'exponential_smoothing',
  } = req.body
  const forecast = generateForecast(organizationId, metric, forecastType, historicalData, periods, algorithm)
  res.json(forecast)
})

phase9AnalyticsRouter.get('/forecasts/:organizationId', requireAuth, (req: Request, res: Response) => {
  const { metric } = req.query
  const forecasts = getForecasts(req.params.organizationId, metric as string)
  res.json(forecasts)
})

// ============================================================================
// ANOMALY DETECTION ENDPOINTS
// ============================================================================

phase9AnalyticsRouter.post('/anomalies/detect', requireAuth, (req: Request, res: Response) => {
  const { organizationId, metric, data, method = 'statistical', threshold = 3 } = req.body
  const result = detectAnomalies(organizationId, metric, data, method, threshold)
  res.json(result)
})

phase9AnalyticsRouter.get('/anomalies/:organizationId', requireAuth, (req: Request, res: Response) => {
  const { metric } = req.query
  const results = getAnomalyResults(req.params.organizationId, metric as string)
  res.json(results)
})

// ============================================================================
// TREND ANALYSIS ENDPOINTS
// ============================================================================

phase9AnalyticsRouter.post('/trends/analyze', requireAuth, (req: Request, res: Response) => {
  const { organizationId, metric, data, period = 'month' } = req.body
  const analysis = analyzeTrends(organizationId, metric, data, period)
  res.json(analysis)
})

phase9AnalyticsRouter.get('/trends/:organizationId', requireAuth, (req: Request, res: Response) => {
  const { metric } = req.query
  const analyses = getTrendAnalyses(req.params.organizationId, metric as string)
  res.json(analyses)
})

// ============================================================================
// COST CLUSTERING ENDPOINTS
// ============================================================================

phase9AnalyticsRouter.post('/clusters/generate', requireAuth, (req: Request, res: Response) => {
  const { organizationId, entities } = req.body
  const clusters = clusterCosts(organizationId, entities)
  res.json(clusters)
})

phase9AnalyticsRouter.get('/clusters/:organizationId', requireAuth, (req: Request, res: Response) => {
  const clusters = getCostClusters(req.params.organizationId)
  res.json(clusters)
})

// ============================================================================
// PATTERN RECOGNITION ENDPOINTS
// ============================================================================

phase9AnalyticsRouter.post('/patterns/recognize', requireAuth, (req: Request, res: Response) => {
  const { organizationId, data } = req.body
  const patterns = recognizePatterns(organizationId, data)
  res.json(patterns)
})

phase9AnalyticsRouter.get('/patterns/:organizationId', requireAuth, (req: Request, res: Response) => {
  const patterns = getPatterns(req.params.organizationId)
  res.json(patterns)
})

// ============================================================================
// CAPACITY PLANNING ENDPOINTS
// ============================================================================

phase9AnalyticsRouter.post('/capacity/plan', requireAuth, (req: Request, res: Response) => {
  const { organizationId, metric, currentCapacity, projectedDemand } = req.body
  const plan = planCapacity(organizationId, metric, currentCapacity, projectedDemand)
  res.json(plan)
})

phase9AnalyticsRouter.get('/capacity/:organizationId', requireAuth, (req: Request, res: Response) => {
  const { metric } = req.query
  const plans = getCapacityPlans(req.params.organizationId, metric as string)
  res.json(plans)
})

// ============================================================================
// ML MODEL ENDPOINTS
// ============================================================================

phase9AnalyticsRouter.post('/models', requireAuth, (req: Request, res: Response) => {
  const { organizationId, name, modelType, algorithm, features, hyperparameters, trainingDataSize, validationDataSize, testDataSize } =
    req.body
  const model = createModel(organizationId, name, modelType, algorithm, features, hyperparameters, trainingDataSize, validationDataSize, testDataSize)
  res.json(model)
})

phase9AnalyticsRouter.get('/models/:organizationId', requireAuth, (req: Request, res: Response) => {
  const { status } = req.query
  const models = getModels(req.params.organizationId, status as string)
  res.json(models)
})

phase9AnalyticsRouter.get('/models/:organizationId/:modelId', requireAuth, (req: Request, res: Response) => {
  const model = getModel(req.params.organizationId, req.params.modelId)
  res.json(model || { error: 'Model not found' })
})

phase9AnalyticsRouter.put('/models/:organizationId/:modelId/metrics', requireAuth, (req: Request, res: Response) => {
  const { metrics, status } = req.body
  const success = updateModelMetrics(req.params.organizationId, req.params.modelId, metrics, status)
  res.json({ success })
})

phase9AnalyticsRouter.post('/models/:organizationId/:modelId/deprecate', requireAuth, (req: Request, res: Response) => {
  const success = deprecateModel(req.params.organizationId, req.params.modelId)
  res.json({ success })
})

// ============================================================================
// FEATURE IMPORTANCE ENDPOINTS
// ============================================================================

phase9AnalyticsRouter.post('/models/:organizationId/:modelId/feature-importance', requireAuth, (req: Request, res: Response) => {
  const { features } = req.body
  const importance = recordFeatureImportance(req.params.organizationId, req.params.modelId, features)
  res.json(importance)
})

phase9AnalyticsRouter.get('/models/:organizationId/:modelId/feature-importance', requireAuth, (req: Request, res: Response) => {
  const importances = getFeatureImportance(req.params.organizationId, req.params.modelId)
  res.json(importances)
})

// ============================================================================
// VALIDATION ENDPOINTS
// ============================================================================

phase9AnalyticsRouter.post('/models/:organizationId/:modelId/validate', requireAuth, (req: Request, res: Response) => {
  const { data, folds = 5 } = req.body
  const report = crossValidate(req.params.organizationId, req.params.modelId, data, folds)
  res.json(report)
})

// ============================================================================
// INFERENCE ENDPOINTS
// ============================================================================

phase9AnalyticsRouter.post('/models/:organizationId/:modelId/infer', requireAuth, (req: Request, res: Response) => {
  const { inputs } = req.body
  const batch = runInferenceBatch(req.params.organizationId, req.params.modelId, inputs)
  res.json(batch)
})

phase9AnalyticsRouter.get('/models/:organizationId/:modelId/inference-history', requireAuth, (req: Request, res: Response) => {
  const { hours = 24 } = req.query
  const batches = getInferenceBatches(req.params.organizationId, req.params.modelId, Number(hours))
  res.json(batches)
})

// ============================================================================
// MODEL PERFORMANCE ENDPOINTS
// ============================================================================

phase9AnalyticsRouter.post('/models/:organizationId/:modelId/performance', requireAuth, (req: Request, res: Response) => {
  const { metric, actualValue, predictedValue } = req.body
  const log = logModelPerformance(req.params.organizationId, req.params.modelId, metric, actualValue, predictedValue)
  res.json(log)
})

phase9AnalyticsRouter.get('/models/:organizationId/:modelId/performance-logs', requireAuth, (req: Request, res: Response) => {
  const { metric, days = 30 } = req.query
  const logs = getPerformanceLogs(req.params.organizationId, req.params.modelId, metric as string, Number(days))
  res.json(logs)
})

// ============================================================================
// MODEL COMPARISON ENDPOINTS
// ============================================================================

phase9AnalyticsRouter.post('/models/:organizationId/compare', requireAuth, (req: Request, res: Response) => {
  const { modelIds } = req.body
  const comparison = compareModels(req.params.organizationId, modelIds)
  res.json(comparison)
})

phase9AnalyticsRouter.get('/models/:organizationId/comparisons', requireAuth, (req: Request, res: Response) => {
  const comparisons = getModelComparisons(req.params.organizationId)
  res.json(comparisons)
})

// ============================================================================
// RECOMMENDATION ENDPOINTS
// ============================================================================

phase9AnalyticsRouter.post('/recommendations', requireAuth, (req: Request, res: Response) => {
  const {
    organizationId,
    type,
    title,
    description,
    category,
    severity,
    estimatedMonthlySavings,
    estimatedImplementationCost,
    affectedServices = [],
    affectedTeams = [],
  } = req.body
  const rec = generateRecommendation(
    organizationId,
    type,
    title,
    description,
    category,
    severity,
    estimatedMonthlySavings,
    estimatedImplementationCost,
    affectedServices,
    affectedTeams
  )
  res.json(rec)
})

phase9AnalyticsRouter.get('/recommendations/:organizationId', requireAuth, (req: Request, res: Response) => {
  const { status, type, minPriority = 1 } = req.query
  const recommendations = getRecommendations(req.params.organizationId, status as string, type as string, Number(minPriority))
  res.json(recommendations)
})

phase9AnalyticsRouter.get('/recommendations/:organizationId/:recommendationId', requireAuth, (req: Request, res: Response) => {
  const rec = getRecommendation(req.params.organizationId, req.params.recommendationId)
  res.json(rec || { error: 'Recommendation not found' })
})

phase9AnalyticsRouter.put('/recommendations/:organizationId/:recommendationId/status', requireAuth, (req: Request, res: Response) => {
  const { status, notes } = req.body
  const success = updateRecommendationStatus(req.params.organizationId, req.params.recommendationId, status, notes)
  res.json({ success })
})

phase9AnalyticsRouter.post('/recommendations/:organizationId/:recommendationId/approve', requireAuth, (req: Request, res: Response) => {
  const { userId } = req.body
  const success = approveRecommendation(req.params.organizationId, req.params.recommendationId, userId)
  res.json({ success })
})

phase9AnalyticsRouter.post('/recommendations/:organizationId/:recommendationId/reject', requireAuth, (req: Request, res: Response) => {
  const { reason } = req.body
  const success = rejectRecommendation(req.params.organizationId, req.params.recommendationId, reason)
  res.json({ success })
})

// ============================================================================
// RISK ASSESSMENT ENDPOINTS
// ============================================================================

phase9AnalyticsRouter.post('/recommendations/:organizationId/:recommendationId/risk-assessment', requireAuth, (req: Request, res: Response) => {
  const { riskType, probability, impact, mitigation, rollbackPlan, testingPlan } = req.body
  const assessment = assessRisk(
    req.params.organizationId,
    req.params.recommendationId,
    riskType,
    probability,
    impact,
    mitigation,
    rollbackPlan,
    testingPlan
  )
  res.json(assessment)
})

phase9AnalyticsRouter.get('/recommendations/:organizationId/:recommendationId/risks', requireAuth, (req: Request, res: Response) => {
  const risks = getRiskAssessments(req.params.organizationId, req.params.recommendationId)
  res.json(risks)
})

// ============================================================================
// IMPACT ANALYSIS ENDPOINTS
// ============================================================================

phase9AnalyticsRouter.post('/recommendations/:organizationId/:recommendationId/impact-analysis', requireAuth, (req: Request, res: Response) => {
  const { metric, currentValue, projectedValue, confidenceLevel = 0.85 } = req.body
  const analysis = analyzeImpact(req.params.organizationId, req.params.recommendationId, metric, currentValue, projectedValue, confidenceLevel)
  res.json(analysis)
})

phase9AnalyticsRouter.get('/recommendations/:organizationId/:recommendationId/impacts', requireAuth, (req: Request, res: Response) => {
  const impacts = getImpactAnalyses(req.params.organizationId, req.params.recommendationId)
  res.json(impacts)
})

// ============================================================================
// ROI CALCULATION ENDPOINTS
// ============================================================================

phase9AnalyticsRouter.post('/recommendations/:organizationId/:recommendationId/roi', requireAuth, (req: Request, res: Response) => {
  const { monthlySavings, implementationCost, monthlyMaintenance = 0, discountRate = 0.1 } = req.body
  const roi = calculateROI(
    req.params.organizationId,
    req.params.recommendationId,
    monthlySavings,
    implementationCost,
    monthlyMaintenance,
    discountRate
  )
  res.json(roi)
})

phase9AnalyticsRouter.get('/recommendations/:organizationId/:recommendationId/roi', requireAuth, (req: Request, res: Response) => {
  const rois = getROICalculations(req.params.organizationId, req.params.recommendationId)
  res.json(rois)
})

// ============================================================================
// RECOMMENDATION GROUPING ENDPOINTS
// ============================================================================

phase9AnalyticsRouter.post('/recommendations/:organizationId/groups', requireAuth, (req: Request, res: Response) => {
  const { recommendationIds, name, description } = req.body
  const group = groupRecommendations(req.params.organizationId, recommendationIds, name, description)
  res.json(group)
})

phase9AnalyticsRouter.get('/recommendations/:organizationId/groups', requireAuth, (req: Request, res: Response) => {
  const groups = getRecommendationGroups(req.params.organizationId)
  res.json(groups)
})

// ============================================================================
// SUMMARY & REPORTING ENDPOINTS
// ============================================================================

phase9AnalyticsRouter.get('/recommendations/:organizationId/summary', requireAuth, (req: Request, res: Response) => {
  const summary = getRecommendationsSummary(req.params.organizationId)
  res.json(summary)
})

// ============================================================================
// INITIALIZATION & TESTING
// ============================================================================

phase9AnalyticsRouter.post('/clear-all', requireAuth, (req: Request, res: Response) => {
  clearAdvancedAnalytics()
  clearMLPipeline()
  clearRecommendations()
  res.json({ message: 'All Phase 9 data cleared' })
})
