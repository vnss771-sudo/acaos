import { Router, Request, Response } from 'express'
import { requireAuth } from '../../middleware/auth.js'
import {
  createAgent,
  getAgents,
  getAgent,
  updateAgentStatus,
  proposeDecision,
  getDecisions,
  getDecision,
  approveDecision,
  rejectDecision,
  executeDecision,
  recordExecution,
  recordPerformance,
  getPerformance,
  clearAutonomousAgents,
} from '@acaos/backend-core/lib/autonomousAgents.js'
import {
  createOptimizationAction,
  getOptimizationActions,
  executeOptimizationAction,
  createStrategy,
  getStrategies,
  recordOptimizationRun,
  getOptimizationRuns,
  analyzeWastage,
  getWastageAnalyses,
  clearCostOptimization,
} from '@acaos/backend-core/lib/autonomousCostOptimization.js'
import {
  proposeSchedulingOptimization,
  getSchedulingOptimizations,
  applySchedulingOptimization,
  createShiftAssignment,
  getShiftAssignments,
  confirmShiftAssignment,
  completeShiftAssignment,
  recordDemandForecast,
  getDemandForecasts,
  recordScheduleImpact,
  getScheduleImpactReports,
  clearAutonomousScheduling,
} from '@acaos/backend-core/lib/autonomousScheduling.js'
import {
  createAnomalyIncident,
  getAnomalyIncidents,
  startInvestigation,
  recordDiagnosis,
  startRemediation,
  completeRemediation,
  escalateIncident,
  createRemediationWorkflow,
  getRemediationWorkflows,
  generateIncidentReport,
  getIncidentReports,
  recordResponseMetrics,
  getResponseMetrics,
  clearAnomalyResponse,
} from '@acaos/backend-core/lib/autonomousAnomalyResponse.js'

export const phase10AgentsRouter = Router()

// ============================================================================
// AGENT MANAGEMENT ENDPOINTS
// ============================================================================

phase10AgentsRouter.post('/agents', requireAuth, (req: Request, res: Response) => {
  const { organizationId, name, type, riskProfile, autoApprovalThreshold, executionMode, config } = req.body
  const agent = createAgent(organizationId, name, type, riskProfile, autoApprovalThreshold, executionMode, config)
  res.json(agent)
})

phase10AgentsRouter.get('/agents/:organizationId', requireAuth, (req: Request, res: Response) => {
  const { type } = req.query
  const agents = getAgents(req.params.organizationId, type as string)
  res.json(agents)
})

phase10AgentsRouter.get('/agents/:organizationId/:agentId', requireAuth, (req: Request, res: Response) => {
  const agent = getAgent(req.params.organizationId, req.params.agentId)
  res.json(agent || { error: 'Agent not found' })
})

phase10AgentsRouter.put('/agents/:organizationId/:agentId/status', requireAuth, (req: Request, res: Response) => {
  const { status } = req.body
  const success = updateAgentStatus(req.params.organizationId, req.params.agentId, status)
  res.json({ success })
})

// ============================================================================
// AGENT DECISION ENDPOINTS
// ============================================================================

phase10AgentsRouter.post('/agents/:organizationId/:agentId/decisions', requireAuth, (req: Request, res: Response) => {
  const { type, priority, riskScore, proposedAction } = req.body
  const decision = proposeDecision(req.params.organizationId, req.params.agentId, type, priority, riskScore, proposedAction)
  res.json(decision)
})

phase10AgentsRouter.get('/agents/:organizationId/:agentId/decisions', requireAuth, (req: Request, res: Response) => {
  const { status } = req.query
  const decisions = getDecisions(req.params.organizationId, req.params.agentId, status as string)
  res.json(decisions)
})

phase10AgentsRouter.get('/agents/:organizationId/:agentId/decisions/:decisionId', requireAuth, (req: Request, res: Response) => {
  const decision = getDecision(req.params.organizationId, req.params.decisionId)
  res.json(decision || { error: 'Decision not found' })
})

phase10AgentsRouter.post('/agents/:organizationId/:agentId/decisions/:decisionId/approve', requireAuth, (req: Request, res: Response) => {
  const { userId } = req.body
  const success = approveDecision(req.params.organizationId, req.params.decisionId, userId)
  res.json({ success })
})

phase10AgentsRouter.post('/agents/:organizationId/:agentId/decisions/:decisionId/reject', requireAuth, (req: Request, res: Response) => {
  const { reason } = req.body
  const success = rejectDecision(req.params.organizationId, req.params.decisionId, reason)
  res.json({ success })
})

phase10AgentsRouter.post('/agents/:organizationId/:agentId/decisions/:decisionId/execute', requireAuth, (req: Request, res: Response) => {
  const { success, message, actualCost } = req.body
  const decision = executeDecision(req.params.organizationId, req.params.decisionId, success, message, actualCost)
  res.json(decision)
})

// ============================================================================
// AGENT EXECUTION & PERFORMANCE ENDPOINTS
// ============================================================================

phase10AgentsRouter.post('/agents/:organizationId/:agentId/executions', requireAuth, (req: Request, res: Response) => {
  const { decisionsProposed, decisionsExecuted, decisionsRejected, successfulActions, failedActions, errors, executionTimeMs } = req.body
  const execution = recordExecution(
    req.params.organizationId,
    req.params.agentId,
    decisionsProposed,
    decisionsExecuted,
    decisionsRejected,
    successfulActions,
    failedActions,
    errors,
    executionTimeMs
  )
  res.json(execution)
})

phase10AgentsRouter.get('/agents/:organizationId/:agentId/performance', requireAuth, (req: Request, res: Response) => {
  const { days = 30 } = req.query
  const performance = getPerformance(req.params.organizationId, req.params.agentId, Number(days))
  res.json(performance)
})

phase10AgentsRouter.post('/agents/:organizationId/:agentId/performance', requireAuth, (req: Request, res: Response) => {
  const {
    period,
    decisionsProposed,
    decisionsExecuted,
    successfulActions,
    failedActions,
    totalSavings,
    avgDecisionTime,
    avgExecutionTime,
    anomalies,
    incidents,
  } = req.body
  const perf = recordPerformance(
    req.params.organizationId,
    req.params.agentId,
    period,
    decisionsProposed,
    decisionsExecuted,
    successfulActions,
    failedActions,
    totalSavings,
    avgDecisionTime,
    avgExecutionTime,
    anomalies,
    incidents
  )
  res.json(perf)
})

// ============================================================================
// COST OPTIMIZATION ENDPOINTS
// ============================================================================

phase10AgentsRouter.post('/optimization/actions', requireAuth, (req: Request, res: Response) => {
  const {
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
  } = req.body
  const action = createOptimizationAction(
    organizationId,
    agentId,
    type,
    targetResource,
    targetMetric,
    currentValue,
    proposedValue,
    estimatedMonthlySavings,
    confidence,
    implementationCost
  )
  res.json(action)
})

phase10AgentsRouter.get('/optimization/actions/:organizationId', requireAuth, (req: Request, res: Response) => {
  const { agentId, type } = req.query
  const actions = getOptimizationActions(req.params.organizationId, agentId as string, type as string)
  res.json(actions)
})

phase10AgentsRouter.post('/optimization/actions/:organizationId/:actionId/execute', requireAuth, (req: Request, res: Response) => {
  const { success, actualSavings } = req.body
  const result = executeOptimizationAction(req.params.organizationId, req.params.actionId, success, actualSavings)
  res.json({ success: result })
})

phase10AgentsRouter.post('/optimization/strategies', requireAuth, (req: Request, res: Response) => {
  const { organizationId, name, description, type, targetMetrics, optimizationRules, targetSavingsPerMonth } = req.body
  const strategy = createStrategy(organizationId, name, description, type, targetMetrics, optimizationRules, targetSavingsPerMonth)
  res.json(strategy)
})

phase10AgentsRouter.get('/optimization/strategies/:organizationId', requireAuth, (req: Request, res: Response) => {
  const { enabled } = req.query
  const strategies = getStrategies(req.params.organizationId, enabled === 'true' ? true : enabled === 'false' ? false : undefined)
  res.json(strategies)
})

phase10AgentsRouter.post('/optimization/runs', requireAuth, (req: Request, res: Response) => {
  const { organizationId, strategyId, actionsProposed, actionsExecuted, totalEstimatedSavings, totalActualSavings, errors } = req.body
  const run = recordOptimizationRun(organizationId, strategyId, actionsProposed, actionsExecuted, totalEstimatedSavings, totalActualSavings, errors)
  res.json(run)
})

phase10AgentsRouter.get('/optimization/runs/:organizationId', requireAuth, (req: Request, res: Response) => {
  const { strategyId, days = 30 } = req.query
  const runs = getOptimizationRuns(req.params.organizationId, strategyId as string, Number(days))
  res.json(runs)
})

phase10AgentsRouter.post('/optimization/wastage', requireAuth, (req: Request, res: Response) => {
  const { organizationId, agentId, resourceType, currentUsage, optimalUsage, commonPatterns, recommendations } = req.body
  const analysis = analyzeWastage(organizationId, agentId, resourceType, currentUsage, optimalUsage, commonPatterns, recommendations)
  res.json(analysis)
})

phase10AgentsRouter.get('/optimization/wastage/:organizationId', requireAuth, (req: Request, res: Response) => {
  const { agentId, days = 30 } = req.query
  const analyses = getWastageAnalyses(req.params.organizationId, agentId as string, Number(days))
  res.json(analyses)
})

// ============================================================================
// AUTONOMOUS SCHEDULING ENDPOINTS
// ============================================================================

phase10AgentsRouter.post('/scheduling/optimizations', requireAuth, (req: Request, res: Response) => {
  const {
    organizationId,
    agentId,
    workspaceId,
    optimizationType,
    proposedChanges,
    estimatedCostSavings,
    estimatedFatigueReduction,
    estimatedCoverageImprovement,
    confidence,
    riskFactors,
  } = req.body
  const optimization = proposeSchedulingOptimization(
    organizationId,
    agentId,
    workspaceId,
    optimizationType,
    proposedChanges,
    estimatedCostSavings,
    estimatedFatigueReduction,
    estimatedCoverageImprovement,
    confidence,
    riskFactors
  )
  res.json(optimization)
})

phase10AgentsRouter.get('/scheduling/optimizations/:organizationId', requireAuth, (req: Request, res: Response) => {
  const { agentId, status } = req.query
  const optimizations = getSchedulingOptimizations(req.params.organizationId, agentId as string, status as string)
  res.json(optimizations)
})

phase10AgentsRouter.post('/scheduling/optimizations/:organizationId/:optimizationId/apply', requireAuth, (req: Request, res: Response) => {
  const { actualCostSavings, actualFatigueReduction, actualCoverageImprovement } = req.body
  const success = applySchedulingOptimization(
    req.params.organizationId,
    req.params.optimizationId,
    actualCostSavings,
    actualFatigueReduction,
    actualCoverageImprovement
  )
  res.json({ success })
})

phase10AgentsRouter.post('/scheduling/assignments', requireAuth, (req: Request, res: Response) => {
  const { organizationId, crewMemberId, shiftId, startTime, endTime, estimatedFatigueLevel, costImpact, coverageScore, assignmentReason } = req.body
  const assignment = createShiftAssignment(
    organizationId,
    crewMemberId,
    shiftId,
    new Date(startTime),
    new Date(endTime),
    estimatedFatigueLevel,
    costImpact,
    coverageScore,
    assignmentReason
  )
  res.json(assignment)
})

phase10AgentsRouter.get('/scheduling/assignments/:organizationId', requireAuth, (req: Request, res: Response) => {
  const { crewMemberId, status } = req.query
  const assignments = getShiftAssignments(req.params.organizationId, crewMemberId as string, status as string)
  res.json(assignments)
})

phase10AgentsRouter.post('/scheduling/assignments/:organizationId/:assignmentId/confirm', requireAuth, (req: Request, res: Response) => {
  const success = confirmShiftAssignment(req.params.organizationId, req.params.assignmentId)
  res.json({ success })
})

phase10AgentsRouter.post('/scheduling/assignments/:organizationId/:assignmentId/complete', requireAuth, (req: Request, res: Response) => {
  const { actualFatigueLevel } = req.body
  const success = completeShiftAssignment(req.params.organizationId, req.params.assignmentId, actualFatigueLevel)
  res.json({ success })
})

phase10AgentsRouter.post('/scheduling/demand-forecast', requireAuth, (req: Request, res: Response) => {
  const {
    organizationId,
    workspaceId,
    date,
    timeSlot,
    expectedDemand,
    requiredStaff,
    availableStaff,
    confidenceLevel,
    historicalAccuracy,
  } = req.body
  const forecast = recordDemandForecast(
    organizationId,
    workspaceId,
    new Date(date),
    timeSlot,
    expectedDemand,
    requiredStaff,
    availableStaff,
    confidenceLevel,
    historicalAccuracy
  )
  res.json(forecast)
})

phase10AgentsRouter.get('/scheduling/demand-forecast/:organizationId', requireAuth, (req: Request, res: Response) => {
  const { workspaceId, days = 7 } = req.query
  const forecasts = getDemandForecasts(req.params.organizationId, workspaceId as string, Number(days))
  res.json(forecasts)
})

phase10AgentsRouter.post('/scheduling/impact', requireAuth, (req: Request, res: Response) => {
  const {
    organizationId,
    agentId,
    period,
    optimizationsApplied,
    totalCostSavings,
    averageFatigueReduction,
    coverageImprovement,
    crewSatisfactionImpact,
    complianceViolations,
    swapRequestsFulfilled,
  } = req.body
  const report = recordScheduleImpact(
    organizationId,
    agentId,
    period,
    optimizationsApplied,
    totalCostSavings,
    averageFatigueReduction,
    coverageImprovement,
    crewSatisfactionImpact,
    complianceViolations,
    swapRequestsFulfilled
  )
  res.json(report)
})

phase10AgentsRouter.get('/scheduling/impact/:organizationId', requireAuth, (req: Request, res: Response) => {
  const { agentId, days = 30 } = req.query
  const reports = getScheduleImpactReports(req.params.organizationId, agentId as string, Number(days))
  res.json(reports)
})

// ============================================================================
// ANOMALY RESPONSE ENDPOINTS
// ============================================================================

phase10AgentsRouter.post('/anomalies/incidents', requireAuth, (req: Request, res: Response) => {
  const {
    organizationId,
    agentId,
    anomalyId,
    metric,
    severity,
    detectionConfidence,
    baselineValue,
    currentValue,
    rootCauseHypotheses,
  } = req.body
  const incident = createAnomalyIncident(
    organizationId,
    agentId,
    anomalyId,
    metric,
    severity,
    detectionConfidence,
    baselineValue,
    currentValue,
    rootCauseHypotheses
  )
  res.json(incident)
})

phase10AgentsRouter.get('/anomalies/incidents/:organizationId', requireAuth, (req: Request, res: Response) => {
  const { agentId, status, severity } = req.query
  const incidents = getAnomalyIncidents(
    req.params.organizationId,
    agentId as string,
    status as string,
    severity as string
  )
  res.json(incidents)
})

phase10AgentsRouter.post('/anomalies/incidents/:organizationId/:incidentId/investigate', requireAuth, (req: Request, res: Response) => {
  const success = startInvestigation(req.params.organizationId, req.params.incidentId)
  res.json({ success })
})

phase10AgentsRouter.post('/anomalies/incidents/:organizationId/:incidentId/diagnose', requireAuth, (req: Request, res: Response) => {
  const { cause, confidence, evidence } = req.body
  const success = recordDiagnosis(req.params.organizationId, req.params.incidentId, cause, confidence, evidence)
  res.json({ success })
})

phase10AgentsRouter.post('/anomalies/incidents/:organizationId/:incidentId/remediate', requireAuth, (req: Request, res: Response) => {
  const { action } = req.body
  const success = startRemediation(req.params.organizationId, req.params.incidentId, action)
  res.json({ success })
})

phase10AgentsRouter.post('/anomalies/incidents/:organizationId/:incidentId/resolve', requireAuth, (req: Request, res: Response) => {
  const success = completeRemediation(req.params.organizationId, req.params.incidentId)
  res.json({ success })
})

phase10AgentsRouter.post('/anomalies/incidents/:organizationId/:incidentId/escalate', requireAuth, (req: Request, res: Response) => {
  const { userId, reason } = req.body
  const success = escalateIncident(req.params.organizationId, req.params.incidentId, userId, reason)
  res.json({ success })
})

phase10AgentsRouter.post('/anomalies/workflows', requireAuth, (req: Request, res: Response) => {
  const { organizationId, agentId, name, applicableAnomalies, remediationSteps, estimatedResolutionTimeMs, successRate } = req.body
  const workflow = createRemediationWorkflow(
    organizationId,
    agentId,
    name,
    applicableAnomalies,
    remediationSteps,
    estimatedResolutionTimeMs,
    successRate
  )
  res.json(workflow)
})

phase10AgentsRouter.get('/anomalies/workflows/:organizationId', requireAuth, (req: Request, res: Response) => {
  const workflows = getRemediationWorkflows(req.params.organizationId)
  res.json(workflows)
})

phase10AgentsRouter.post('/anomalies/reports', requireAuth, (req: Request, res: Response) => {
  const {
    organizationId,
    agentId,
    incidentId,
    title,
    severity,
    affectedServices,
    affectedUsers,
    rootCause,
    resolution,
    timeline,
  } = req.body
  const report = generateIncidentReport(
    organizationId,
    agentId,
    incidentId,
    title,
    severity,
    affectedServices,
    affectedUsers,
    rootCause,
    resolution,
    timeline
  )
  res.json(report)
})

phase10AgentsRouter.get('/anomalies/reports/:organizationId', requireAuth, (req: Request, res: Response) => {
  const { days = 30 } = req.query
  const reports = getIncidentReports(req.params.organizationId, Number(days))
  res.json(reports)
})

phase10AgentsRouter.post('/anomalies/response-metrics', requireAuth, (req: Request, res: Response) => {
  const {
    organizationId,
    agentId,
    period,
    anomaliesDetected,
    anomaliesInvestigated,
    averageTimeToDetect,
    averageTimeToResolve,
    remediationSuccessRate,
    escalationRate,
    preventiveActionsTaken,
    costsSavedByAutomation,
  } = req.body
  const metrics = recordResponseMetrics(
    organizationId,
    agentId,
    period,
    anomaliesDetected,
    anomaliesInvestigated,
    averageTimeToDetect,
    averageTimeToResolve,
    remediationSuccessRate,
    escalationRate,
    preventiveActionsTaken,
    costsSavedByAutomation
  )
  res.json(metrics)
})

phase10AgentsRouter.get('/anomalies/response-metrics/:organizationId', requireAuth, (req: Request, res: Response) => {
  const { agentId, days = 30 } = req.query
  const metrics = getResponseMetrics(req.params.organizationId, agentId as string, Number(days))
  res.json(metrics)
})

// ============================================================================
// INITIALIZATION & TESTING
// ============================================================================

phase10AgentsRouter.post('/clear-all', requireAuth, (req: Request, res: Response) => {
  clearAutonomousAgents()
  clearCostOptimization()
  clearAutonomousScheduling()
  clearAnomalyResponse()
  res.json({ message: 'All Phase 10 data cleared' })
})
