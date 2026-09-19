// Phase 10: Autonomous anomaly detection and response.
// Automatically diagnoses and responds to operational anomalies.

import { logger } from './logger.js'

export interface AnomalyIncident {
  id: string
  organizationId: string
  agentId: string
  anomalyId: string
  metric: string
  severity: 'low' | 'medium' | 'high' | 'critical'
  detectedAt: Date
  detectionConfidence: number // 0-1
  baselineValue: number
  currentValue: number
  deviation: number // percentage
  rootCauseHypotheses: Array<{
    cause: string
    probability: number // 0-1
    suggestedAction: string
  }>
  status: 'detected' | 'investigating' | 'diagnosed' | 'remediating' | 'resolved' | 'escalated'
  investigationStartedAt?: Date
  rootCauseDiagnosis?: {
    cause: string
    confidence: number // 0-1
    evidence: string[]
  }
  remediationAction?: string
  remediationStartedAt?: Date
  remediationCompletedAt?: Date
  escalatedToUserId?: string
  escalationReason?: string
  incidentReport?: {
    summary: string
    timeline: Array<{ timestamp: Date; event: string }>
    impact: string
    resolution: string
  }
}

export interface RemediationWorkflow {
  id: string
  organizationId: string
  agentId: string
  name: string
  applicableAnomalies: string[]
  remediationSteps: Array<{
    step: number
    action: string
    riskLevel: 'low' | 'medium' | 'high'
    estimatedDurationMs: number
    rollbackProcedure?: string
  }>
  estimatedResolutionTimeMs: number
  successRate: number // 0-1 based on historical data
  enabled: boolean
  createdAt: Date
}

export interface IncidentReport {
  id: string
  organizationId: string
  agentId: string
  incidentId: string
  title: string
  severity: 'low' | 'medium' | 'high' | 'critical'
  startTime: Date
  endTime?: Date
  duration?: number // ms
  affectedServices: string[]
  affectedUsers: number
  rootCause: string
  resolution: string
  timeline: Array<{
    timestamp: Date
    event: string
    actor?: string
  }>
  actionItems: Array<{
    action: string
    assignedTo?: string
    dueDate?: Date
    completed?: boolean
  }>
  postmortemNotes?: string
}

export interface ResponseMetrics {
  id: string
  organizationId: string
  agentId: string
  period: 'day' | 'week' | 'month'
  date: Date
  anomaliesDetected: number
  anomaliesInvestigated: number
  anomalyResolutionRate: number // 0-1
  averageTimeToDetect: number // ms
  averageTimeToResolve: number // ms
  remediationSuccessRate: number // 0-1
  escalationRate: number // 0-1
  preventiveActionsTaken: number
  costsSavedByAutomation: number
}

// Storage
const incidents = new Map<string, AnomalyIncident[]>()
const workflows = new Map<string, RemediationWorkflow[]>()
const reports = new Map<string, IncidentReport[]>()
const metrics = new Map<string, ResponseMetrics[]>()

/**
 * Create anomaly incident.
 */
export function createAnomalyIncident(
  organizationId: string,
  agentId: string,
  anomalyId: string,
  metric: string,
  severity: AnomalyIncident['severity'],
  detectionConfidence: number,
  baselineValue: number,
  currentValue: number,
  rootCauseHypotheses: AnomalyIncident['rootCauseHypotheses']
): AnomalyIncident {
  const deviation = ((currentValue - baselineValue) / Math.abs(baselineValue)) * 100

  const incident: AnomalyIncident = {
    id: `incident-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    organizationId,
    agentId,
    anomalyId,
    metric,
    severity,
    detectedAt: new Date(),
    detectionConfidence,
    baselineValue,
    currentValue,
    deviation,
    rootCauseHypotheses,
    status: 'detected',
  }

  const key = `${organizationId}:incidents`
  const list = incidents.get(key) || []
  list.push(incident)

  // Keep last 2000
  const filtered = list.slice(-2000)
  incidents.set(key, filtered)

  logger.info('anomaly incident created', {
    organizationId,
    agentId,
    metric,
    severity,
    detectionConfidence,
    deviation: deviation.toFixed(1),
  })

  return incident
}

/**
 * Get anomaly incidents.
 */
export function getAnomalyIncidents(organizationId: string, agentId?: string, status?: string, severity?: string): AnomalyIncident[] {
  const key = `${organizationId}:incidents`
  let list = incidents.get(key) || []

  if (agentId) {
    list = list.filter((i) => i.agentId === agentId)
  }
  if (status) {
    list = list.filter((i) => i.status === status)
  }
  if (severity) {
    list = list.filter((i) => i.severity === severity)
  }

  return list
}

/**
 * Start incident investigation.
 */
export function startInvestigation(organizationId: string, incidentId: string): boolean {
  const key = `${organizationId}:incidents`
  const list = incidents.get(key) || []
  const incident = list.find((i) => i.id === incidentId)

  if (!incident) return false

  incident.status = 'investigating'
  incident.investigationStartedAt = new Date()

  logger.info('anomaly investigation started', { organizationId, incidentId })
  return true
}

/**
 * Record root cause diagnosis.
 */
export function recordDiagnosis(
  organizationId: string,
  incidentId: string,
  cause: string,
  confidence: number,
  evidence: string[]
): boolean {
  const key = `${organizationId}:incidents`
  const list = incidents.get(key) || []
  const incident = list.find((i) => i.id === incidentId)

  if (!incident) return false

  incident.status = 'diagnosed'
  incident.rootCauseDiagnosis = {
    cause,
    confidence,
    evidence,
  }

  logger.info('root cause diagnosed', {
    organizationId,
    incidentId,
    cause,
    confidence,
  })

  return true
}

/**
 * Execute remediation.
 */
export function startRemediation(organizationId: string, incidentId: string, action: string): boolean {
  const key = `${organizationId}:incidents`
  const list = incidents.get(key) || []
  const incident = list.find((i) => i.id === incidentId)

  if (!incident) return false

  incident.status = 'remediating'
  incident.remediationAction = action
  incident.remediationStartedAt = new Date()

  return true
}

/**
 * Complete remediation.
 */
export function completeRemediation(organizationId: string, incidentId: string): boolean {
  const key = `${organizationId}:incidents`
  const list = incidents.get(key) || []
  const incident = list.find((i) => i.id === incidentId)

  if (!incident) return false

  incident.status = 'resolved'
  incident.remediationCompletedAt = new Date()

  return true
}

/**
 * Escalate incident to user.
 */
export function escalateIncident(organizationId: string, incidentId: string, userId: string, reason: string): boolean {
  const key = `${organizationId}:incidents`
  const list = incidents.get(key) || []
  const incident = list.find((i) => i.id === incidentId)

  if (!incident) return false

  incident.status = 'escalated'
  incident.escalatedToUserId = userId
  incident.escalationReason = reason

  logger.info('incident escalated', {
    organizationId,
    incidentId,
    escalatedTo: userId,
    reason,
  })

  return true
}

/**
 * Create remediation workflow.
 */
export function createRemediationWorkflow(
  organizationId: string,
  agentId: string,
  name: string,
  applicableAnomalies: string[],
  remediationSteps: RemediationWorkflow['remediationSteps'],
  estimatedResolutionTimeMs: number,
  successRate: number = 0.95
): RemediationWorkflow {
  const workflow: RemediationWorkflow = {
    id: `workflow-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    organizationId,
    agentId,
    name,
    applicableAnomalies,
    remediationSteps,
    estimatedResolutionTimeMs,
    successRate,
    enabled: true,
    createdAt: new Date(),
  }

  const key = `${organizationId}:workflows`
  const list = workflows.get(key) || []
  list.push(workflow)
  workflows.set(key, list)

  logger.info('remediation workflow created', {
    organizationId,
    agentId,
    name,
    steps: remediationSteps.length,
  })

  return workflow
}

/**
 * Get remediation workflows.
 */
export function getRemediationWorkflows(organizationId: string, enabled?: boolean): RemediationWorkflow[] {
  const key = `${organizationId}:workflows`
  let list = workflows.get(key) || []

  if (enabled !== undefined) {
    list = list.filter((w) => w.enabled === enabled)
  }

  return list
}

/**
 * Generate incident report.
 */
export function generateIncidentReport(
  organizationId: string,
  agentId: string,
  incidentId: string,
  title: string,
  severity: IncidentReport['severity'],
  affectedServices: string[],
  affectedUsers: number,
  rootCause: string,
  resolution: string,
  timeline: IncidentReport['timeline']
): IncidentReport {
  const report: IncidentReport = {
    id: `report-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    organizationId,
    agentId,
    incidentId,
    title,
    severity,
    startTime: timeline[0]?.timestamp || new Date(),
    endTime: new Date(),
    affectedServices,
    affectedUsers,
    rootCause,
    resolution,
    timeline,
    actionItems: [],
  }

  const key = `${organizationId}:reports`
  const list = reports.get(key) || []
  list.push(report)

  // Keep last 1000
  const filtered = list.slice(-1000)
  reports.set(key, filtered)

  logger.info('incident report generated', {
    organizationId,
    incidentId,
    title,
    severity,
    affectedServices: affectedServices.length,
  })

  return report
}

/**
 * Get incident reports.
 */
export function getIncidentReports(organizationId: string, days: number = 30): IncidentReport[] {
  const key = `${organizationId}:reports`
  const list = reports.get(key) || []
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  return list.filter((r) => r.startTime >= cutoff)
}

/**
 * Record response metrics.
 */
export function recordResponseMetrics(
  organizationId: string,
  agentId: string,
  period: ResponseMetrics['period'],
  anomaliesDetected: number,
  anomaliesInvestigated: number,
  averageTimeToDetect: number,
  averageTimeToResolve: number,
  remediationSuccessRate: number,
  escalationRate: number,
  preventiveActionsTaken: number,
  costsSavedByAutomation: number
): ResponseMetrics {
  const metric: ResponseMetrics = {
    id: `metric-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    organizationId,
    agentId,
    period,
    date: new Date(),
    anomaliesDetected,
    anomaliesInvestigated,
    anomalyResolutionRate: anomaliesInvestigated > 0 ? anomaliesInvestigated / anomaliesDetected : 0,
    averageTimeToDetect,
    averageTimeToResolve,
    remediationSuccessRate,
    escalationRate,
    preventiveActionsTaken,
    costsSavedByAutomation,
  }

  const key = `${organizationId}:response_metrics`
  const list = metrics.get(key) || []
  list.push(metric)

  // Keep last 500
  const filtered = list.slice(-500)
  metrics.set(key, filtered)

  return metric
}

/**
 * Get response metrics.
 */
export function getResponseMetrics(organizationId: string, agentId?: string, days: number = 30): ResponseMetrics[] {
  const key = `${organizationId}:response_metrics`
  const list = metrics.get(key) || []
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  let filtered = list.filter((m) => m.date >= cutoff)
  if (agentId) {
    filtered = filtered.filter((m) => m.agentId === agentId)
  }

  return filtered
}

/**
 * Clear anomaly response data (for testing).
 */
export function clearAnomalyResponse(): void {
  incidents.clear()
  workflows.clear()
  reports.clear()
  metrics.clear()
}
