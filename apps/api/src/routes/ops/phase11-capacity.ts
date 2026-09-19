import { Router, Request, Response } from 'express'
import { requireAuth } from '../../middleware/auth.js'
import {
  createCapacityForecast,
  getCapacityForecasts,
  createProvisioningPlan,
  getProvisioningPlans,
  executeProvisioningPlan,
  recordUtilizationTrend,
  getUtilizationTrends,
  createCapacityAllocation,
  getCapacityAllocations,
  updateCapacityAllocation,
  detectBottleneck,
  getBottlenecks,
  resolveBottleneck,
  proposeCapacityOptimization,
  getCapacityOptimizations,
  executeCapacityOptimization,
  clearCapacityPlanning,
} from '../../../backend-core/src/lib/autonomousCapacityPlanning.js'
import {
  createCostForecast,
  getCostForecasts,
  createBudgetAllocation,
  getBudgetAllocations,
  updateBudgetUtilization,
  detectSpendAnomaly,
  getSpendAnomalies,
  createCostOptimizationRecommendation,
  getCostOptimizationRecommendations,
  createCostOptimizationPlan,
  getCostOptimizationPlans,
  createBudgetGovernancePolicy,
  getBudgetGovernancePolicies,
  generateCostReport,
  getCostReports,
  clearCostForecasting,
} from '../../../backend-core/src/lib/autonomousCostForecasting.js'

export const phase11CapacityRouter = Router()

// ============================================================================
// CAPACITY FORECASTING ENDPOINTS
// ============================================================================

phase11CapacityRouter.post('/capacity/forecasts', requireAuth, (req: Request, res: Response) => {
  const {
    organizationId,
    agentId,
    resourceType,
    metricName,
    forecastPeriod,
    currentUtilization,
    forecastedUtilization,
    peakUtilization,
    capacityThreshold,
    recommendedCapacity,
    confidenceLevel,
    forecastAccuracy,
  } = req.body

  const forecast = createCapacityForecast(
    organizationId,
    agentId,
    resourceType,
    metricName,
    forecastPeriod,
    currentUtilization,
    forecastedUtilization,
    peakUtilization,
    capacityThreshold,
    recommendedCapacity,
    confidenceLevel,
    forecastAccuracy
  )
  res.json(forecast)
})

phase11CapacityRouter.get('/capacity/forecasts/:organizationId', requireAuth, (req: Request, res: Response) => {
  const { agentId, resourceType } = req.query
  const forecasts = getCapacityForecasts(req.params.organizationId, agentId as string, resourceType as string)
  res.json(forecasts)
})

// ============================================================================
// PROVISIONING PLAN ENDPOINTS
// ============================================================================

phase11CapacityRouter.post('/capacity/plans', requireAuth, (req: Request, res: Response) => {
  const {
    organizationId,
    agentId,
    forecastId,
    resourceType,
    currentCapacity,
    targetCapacity,
    provisioningStrategy,
    estimatedCost,
    estimatedProvisioningTime,
    implementationSteps,
  } = req.body

  const plan = createProvisioningPlan(
    organizationId,
    agentId,
    forecastId,
    resourceType,
    currentCapacity,
    targetCapacity,
    provisioningStrategy,
    estimatedCost,
    estimatedProvisioningTime,
    implementationSteps
  )
  res.json(plan)
})

phase11CapacityRouter.get('/capacity/plans/:organizationId', requireAuth, (req: Request, res: Response) => {
  const { agentId, status } = req.query
  const plans = getProvisioningPlans(req.params.organizationId, agentId as string, status as string)
  res.json(plans)
})

phase11CapacityRouter.post('/capacity/plans/:organizationId/:planId/execute', requireAuth, (req: Request, res: Response) => {
  const { actualCost, bottlenecksPrevented } = req.body
  const success = executeProvisioningPlan(req.params.organizationId, req.params.planId, actualCost, bottlenecksPrevented)
  res.json({ success })
})

// ============================================================================
// UTILIZATION TREND ENDPOINTS
// ============================================================================

phase11CapacityRouter.post('/capacity/trends', requireAuth, (req: Request, res: Response) => {
  const {
    organizationId,
    agentId,
    resourceType,
    metricName,
    period,
    minUtilization,
    avgUtilization,
    maxUtilization,
    p95,
    p99,
    trend,
    trendRate,
    anomalyDetected,
    seasonalPattern,
  } = req.body

  const trendRecord = recordUtilizationTrend(
    organizationId,
    agentId,
    resourceType,
    metricName,
    period,
    minUtilization,
    avgUtilization,
    maxUtilization,
    p95,
    p99,
    trend,
    trendRate,
    anomalyDetected,
    seasonalPattern
  )
  res.json(trendRecord)
})

phase11CapacityRouter.get('/capacity/trends/:organizationId', requireAuth, (req: Request, res: Response) => {
  const { agentId, resourceType, days = 30 } = req.query
  const trends = getUtilizationTrends(req.params.organizationId, agentId as string, resourceType as string, Number(days))
  res.json(trends)
})

// ============================================================================
// CAPACITY ALLOCATION ENDPOINTS
// ============================================================================

phase11CapacityRouter.post('/capacity/allocations', requireAuth, (req: Request, res: Response) => {
  const {
    organizationId,
    agentId,
    resourceType,
    allocatedCapacity,
    reservedCapacity,
    currentUsage,
    minInstances,
    maxInstances,
    currentInstances,
    workspaceId,
    departmentId,
    autoScalingGroup,
  } = req.body

  const allocation = createCapacityAllocation(
    organizationId,
    agentId,
    resourceType,
    allocatedCapacity,
    reservedCapacity,
    currentUsage,
    minInstances,
    maxInstances,
    currentInstances,
    workspaceId,
    departmentId,
    autoScalingGroup
  )
  res.json(allocation)
})

phase11CapacityRouter.get('/capacity/allocations/:organizationId', requireAuth, (req: Request, res: Response) => {
  const { resourceType } = req.query
  const allocations = getCapacityAllocations(req.params.organizationId, resourceType as string)
  res.json(allocations)
})

phase11CapacityRouter.put('/capacity/allocations/:organizationId/:allocationId', requireAuth, (req: Request, res: Response) => {
  const { currentUsage, currentInstances } = req.body
  const success = updateCapacityAllocation(req.params.organizationId, req.params.allocationId, currentUsage, currentInstances)
  res.json({ success })
})

// ============================================================================
// BOTTLENECK DETECTION ENDPOINTS
// ============================================================================

phase11CapacityRouter.post('/capacity/bottlenecks', requireAuth, (req: Request, res: Response) => {
  const { organizationId, agentId, resourceType, metricName, currentUtilization, capacityThreshold, affectedServices, affectedUsers } = req.body

  const bottleneck = detectBottleneck(
    organizationId,
    agentId,
    resourceType,
    metricName,
    currentUtilization,
    capacityThreshold,
    affectedServices,
    affectedUsers
  )
  res.json(bottleneck)
})

phase11CapacityRouter.get('/capacity/bottlenecks/:organizationId', requireAuth, (req: Request, res: Response) => {
  const { agentId, urgencyLevel } = req.query
  const bottlenecks = getBottlenecks(req.params.organizationId, agentId as string, urgencyLevel as string)
  res.json(bottlenecks)
})

phase11CapacityRouter.post('/capacity/bottlenecks/:organizationId/:bottleneckId/resolve', requireAuth, (req: Request, res: Response) => {
  const success = resolveBottleneck(req.params.organizationId, req.params.bottleneckId)
  res.json({ success })
})

// ============================================================================
// CAPACITY OPTIMIZATION ENDPOINTS
// ============================================================================

phase11CapacityRouter.post('/capacity/optimizations', requireAuth, (req: Request, res: Response) => {
  const {
    organizationId,
    agentId,
    optimizationType,
    currentAllocation,
    proposedAllocation,
    estimatedSavings,
    riskOfUnderprovisioning,
    confidence,
    implementationComplexity,
  } = req.body

  const optimization = proposeCapacityOptimization(
    organizationId,
    agentId,
    optimizationType,
    currentAllocation,
    proposedAllocation,
    estimatedSavings,
    riskOfUnderprovisioning,
    confidence,
    implementationComplexity
  )
  res.json(optimization)
})

phase11CapacityRouter.get('/capacity/optimizations/:organizationId', requireAuth, (req: Request, res: Response) => {
  const { status } = req.query
  const optimizations = getCapacityOptimizations(req.params.organizationId, status as string)
  res.json(optimizations)
})

phase11CapacityRouter.post('/capacity/optimizations/:organizationId/:optimizationId/execute', requireAuth, (req: Request, res: Response) => {
  const { actualSavings } = req.body
  const success = executeCapacityOptimization(req.params.organizationId, req.params.optimizationId, actualSavings)
  res.json({ success })
})

// ============================================================================
// COST FORECASTING ENDPOINTS
// ============================================================================

phase11CapacityRouter.post('/costs/forecasts', requireAuth, (req: Request, res: Response) => {
  const {
    organizationId,
    agentId,
    forecastPeriod,
    baslineCost,
    forecastedCost,
    driversByCategory,
    costTrendPercentage,
    seasonalityFactor,
    confidenceLevel,
    anomalies,
    forecastAccuracy,
  } = req.body

  const forecast = createCostForecast(
    organizationId,
    agentId,
    forecastPeriod,
    baslineCost,
    forecastedCost,
    driversByCategory,
    costTrendPercentage,
    seasonalityFactor,
    confidenceLevel,
    anomalies,
    forecastAccuracy
  )
  res.json(forecast)
})

phase11CapacityRouter.get('/costs/forecasts/:organizationId', requireAuth, (req: Request, res: Response) => {
  const { agentId } = req.query
  const forecasts = getCostForecasts(req.params.organizationId, agentId as string)
  res.json(forecasts)
})

// ============================================================================
// BUDGET MANAGEMENT ENDPOINTS
// ============================================================================

phase11CapacityRouter.post('/costs/budgets', requireAuth, (req: Request, res: Response) => {
  const {
    organizationId,
    agentId,
    budgetType,
    period,
    allocatedBudget,
    forecastedSpend,
    commitmentDiscounts,
    workspaceId,
    departmentId,
  } = req.body

  const budget = createBudgetAllocation(
    organizationId,
    agentId,
    budgetType,
    period,
    allocatedBudget,
    forecastedSpend,
    commitmentDiscounts,
    workspaceId,
    departmentId
  )
  res.json(budget)
})

phase11CapacityRouter.get('/costs/budgets/:organizationId', requireAuth, (req: Request, res: Response) => {
  const { status } = req.query
  const budgets = getBudgetAllocations(req.params.organizationId, status as string)
  res.json(budgets)
})

phase11CapacityRouter.put('/costs/budgets/:organizationId/:budgetId', requireAuth, (req: Request, res: Response) => {
  const { currentSpend, forecastedSpend } = req.body
  const success = updateBudgetUtilization(req.params.organizationId, req.params.budgetId, currentSpend, forecastedSpend)
  res.json({ success })
})

// ============================================================================
// SPEND ANOMALY DETECTION ENDPOINTS
// ============================================================================

phase11CapacityRouter.post('/costs/anomalies', requireAuth, (req: Request, res: Response) => {
  const {
    organizationId,
    agentId,
    service,
    expectedCost,
    actualCost,
    severity,
    detectionConfidence,
    possibleCauses,
  } = req.body

  const anomaly = detectSpendAnomaly(
    organizationId,
    agentId,
    service,
    expectedCost,
    actualCost,
    severity,
    detectionConfidence,
    possibleCauses
  )
  res.json(anomaly)
})

phase11CapacityRouter.get('/costs/anomalies/:organizationId', requireAuth, (req: Request, res: Response) => {
  const { agentId, severity } = req.query
  const anomalies = getSpendAnomalies(req.params.organizationId, agentId as string, severity as string)
  res.json(anomalies)
})

// ============================================================================
// COST OPTIMIZATION RECOMMENDATIONS ENDPOINTS
// ============================================================================

phase11CapacityRouter.post('/costs/recommendations', requireAuth, (req: Request, res: Response) => {
  const {
    organizationId,
    agentId,
    title,
    description,
    category,
    estimatedAnnualSavings,
    estimatedImplementationCost,
    implementationEffort,
    riskLevel,
    affectedServices,
  } = req.body

  const recommendation = createCostOptimizationRecommendation(
    organizationId,
    agentId,
    title,
    description,
    category,
    estimatedAnnualSavings,
    estimatedImplementationCost,
    implementationEffort,
    riskLevel,
    affectedServices
  )
  res.json(recommendation)
})

phase11CapacityRouter.get('/costs/recommendations/:organizationId', requireAuth, (req: Request, res: Response) => {
  const { status } = req.query
  const recommendations = getCostOptimizationRecommendations(req.params.organizationId, status as string)
  res.json(recommendations)
})

// ============================================================================
// COST OPTIMIZATION PLAN ENDPOINTS
// ============================================================================

phase11CapacityRouter.post('/costs/plans', requireAuth, (req: Request, res: Response) => {
  const { organizationId, agentId, name, targetMonthlySavings, recommendationIds } = req.body
  const plan = createCostOptimizationPlan(organizationId, agentId, name, targetMonthlySavings, recommendationIds)
  res.json(plan)
})

phase11CapacityRouter.get('/costs/plans/:organizationId', requireAuth, (req: Request, res: Response) => {
  const { status } = req.query
  const plans = getCostOptimizationPlans(req.params.organizationId, status as string)
  res.json(plans)
})

// ============================================================================
// BUDGET GOVERNANCE POLICY ENDPOINTS
// ============================================================================

phase11CapacityRouter.post('/costs/policies', requireAuth, (req: Request, res: Response) => {
  const {
    organizationId,
    name,
    description,
    budgetLimitPerWorkspace,
    autoApprovalThreshold,
    requireApprovalThreshold,
    escalationThreshold,
    overspendAction,
    overspendThreshold,
  } = req.body

  const policy = createBudgetGovernancePolicy(
    organizationId,
    name,
    description,
    budgetLimitPerWorkspace,
    autoApprovalThreshold,
    requireApprovalThreshold,
    escalationThreshold,
    overspendAction,
    overspendThreshold
  )
  res.json(policy)
})

phase11CapacityRouter.get('/costs/policies/:organizationId', requireAuth, (req: Request, res: Response) => {
  const policies = getBudgetGovernancePolicies(req.params.organizationId)
  res.json(policies)
})

// ============================================================================
// COST REPORTING ENDPOINTS
// ============================================================================

phase11CapacityRouter.post('/costs/reports', requireAuth, (req: Request, res: Response) => {
  const {
    organizationId,
    agentId,
    reportType,
    startDate,
    endDate,
    totalSpend,
    spendByCategory,
    spendByWorkspace,
    spendByDepartment,
    anomaliesDetected,
    optimizationsImplemented,
    costsSaved,
    forecastedMonthEnd,
    budgetVariance,
  } = req.body

  const report = generateCostReport(
    organizationId,
    agentId,
    reportType,
    new Date(startDate),
    new Date(endDate),
    totalSpend,
    spendByCategory,
    spendByWorkspace,
    spendByDepartment,
    anomaliesDetected,
    optimizationsImplemented,
    costsSaved,
    forecastedMonthEnd,
    budgetVariance
  )
  res.json(report)
})

phase11CapacityRouter.get('/costs/reports/:organizationId', requireAuth, (req: Request, res: Response) => {
  const { reportType, days = 90 } = req.query
  const reports = getCostReports(req.params.organizationId, reportType as string, Number(days))
  res.json(reports)
})

// ============================================================================
// INITIALIZATION & TESTING
// ============================================================================

phase11CapacityRouter.post('/clear-all', requireAuth, (req: Request, res: Response) => {
  clearCapacityPlanning()
  clearCostForecasting()
  res.json({ message: 'All Phase 11 data cleared' })
})
