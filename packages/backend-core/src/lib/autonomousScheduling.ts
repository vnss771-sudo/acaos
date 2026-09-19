// Phase 10: Autonomous crew and shift scheduling.
// Autonomously optimizes crew schedules based on demand, fatigue, and cost.

import { logger } from './logger.js'

export interface SchedulingOptimization {
  id: string
  organizationId: string
  agentId: string
  workspaceId: string
  optimizationType: 'demand_matching' | 'fatigue_optimization' | 'cost_optimization' | 'coverage_balancing'
  proposedChanges: Array<{
    crewMemberId: string
    currentShift: string
    proposedShift: string
    reason: string
  }>
  estimatedCostSavings: number
  estimatedFatigueReduction: number // 0-100
  estimatedCoverageImprovement: number // 0-100
  confidence: number // 0-1
  riskFactors: string[]
  status: 'proposed' | 'approved' | 'executing' | 'completed' | 'failed'
  appliedAt?: Date
  metrics?: {
    actualCostSavings: number
    actualFatigueReduction: number
    actualCoverageImprovement: number
  }
  createdAt: Date
}

export interface ShiftAssignment {
  id: string
  organizationId: string
  crewMemberId: string
  shiftId: string
  startTime: Date
  endTime: Date
  estimatedFatigueLevel: number // 0-100
  costImpact: number
  coverageScore: number // 0-1
  assignmentReason: string
  status: 'scheduled' | 'confirmed' | 'completed' | 'cancelled'
  confirmedAt?: Date
  completedAt?: Date
  actualFatigueLevel?: number
}

export interface DemandForecast {
  id: string
  organizationId: string
  workspaceId: string
  date: Date
  timeSlot: string // HH:MM format
  expectedDemand: number
  requiredStaff: number
  availableStaff: number
  coverageGap: number
  confidenceLevel: number // 0-1
  historicalAccuracy: number // 0-1
}

export interface ScheduleImpactReport {
  id: string
  organizationId: string
  agentId: string
  period: 'daily' | 'weekly' | 'monthly'
  date: Date
  optimizationsApplied: number
  totalCostSavings: number
  averageFatigueReduction: number
  coverageImprovement: number
  crewSatisfactionImpact: number // -1 to 1
  complianceViolations: number
  swapRequestsFulfilled: number
}

// Storage
const optimizations = new Map<string, SchedulingOptimization[]>()
const assignments = new Map<string, ShiftAssignment[]>()
const forecasts = new Map<string, DemandForecast[]>()
const impactReports = new Map<string, ScheduleImpactReport[]>()

/**
 * Propose scheduling optimization.
 */
export function proposeSchedulingOptimization(
  organizationId: string,
  agentId: string,
  workspaceId: string,
  optimizationType: SchedulingOptimization['optimizationType'],
  proposedChanges: SchedulingOptimization['proposedChanges'],
  estimatedCostSavings: number,
  estimatedFatigueReduction: number,
  estimatedCoverageImprovement: number,
  confidence: number,
  riskFactors: string[] = []
): SchedulingOptimization {
  const optimization: SchedulingOptimization = {
    id: `sched-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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
    status: confidence > 0.9 && estimatedCostSavings > 0 ? 'approved' : 'proposed',
    createdAt: new Date(),
  }

  const key = `${organizationId}:sched_optim`
  const list = optimizations.get(key) || []
  list.push(optimization)

  // Keep last 500
  const filtered = list.slice(-500)
  optimizations.set(key, filtered)

  logger.info('scheduling optimization proposed', {
    organizationId,
    agentId,
    optimizationType,
    changes: proposedChanges.length,
    costSavings: estimatedCostSavings,
  })

  return optimization
}

/**
 * Get scheduling optimizations.
 */
export function getSchedulingOptimizations(organizationId: string, agentId?: string, status?: string): SchedulingOptimization[] {
  const key = `${organizationId}:sched_optim`
  let list = optimizations.get(key) || []

  if (agentId) {
    list = list.filter((o) => o.agentId === agentId)
  }
  if (status) {
    list = list.filter((o) => o.status === status)
  }

  return list
}

/**
 * Apply scheduling optimization.
 */
export function applySchedulingOptimization(
  organizationId: string,
  optimizationId: string,
  actualCostSavings: number,
  actualFatigueReduction: number,
  actualCoverageImprovement: number
): boolean {
  const key = `${organizationId}:sched_optim`
  const list = optimizations.get(key) || []
  const optimization = list.find((o) => o.id === optimizationId)

  if (!optimization) return false

  optimization.status = 'completed'
  optimization.appliedAt = new Date()
  optimization.metrics = {
    actualCostSavings,
    actualFatigueReduction,
    actualCoverageImprovement,
  }

  logger.info('scheduling optimization applied', {
    organizationId,
    optimizationId,
    actualCostSavings,
  })

  return true
}

/**
 * Create shift assignment.
 */
export function createShiftAssignment(
  organizationId: string,
  crewMemberId: string,
  shiftId: string,
  startTime: Date,
  endTime: Date,
  estimatedFatigueLevel: number,
  costImpact: number,
  coverageScore: number,
  assignmentReason: string
): ShiftAssignment {
  const assignment: ShiftAssignment = {
    id: `assign-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    organizationId,
    crewMemberId,
    shiftId,
    startTime,
    endTime,
    estimatedFatigueLevel,
    costImpact,
    coverageScore,
    assignmentReason,
    status: 'scheduled',
  }

  const key = `${organizationId}:assignments`
  const list = assignments.get(key) || []
  list.push(assignment)

  // Keep last 5000
  const filtered = list.slice(-5000)
  assignments.set(key, filtered)

  logger.info('shift assignment created', {
    organizationId,
    crewMemberId,
    shiftId,
    estimatedFatigue: estimatedFatigueLevel,
  })

  return assignment
}

/**
 * Get shift assignments.
 */
export function getShiftAssignments(organizationId: string, crewMemberId?: string, status?: string): ShiftAssignment[] {
  const key = `${organizationId}:assignments`
  let list = assignments.get(key) || []

  if (crewMemberId) {
    list = list.filter((a) => a.crewMemberId === crewMemberId)
  }
  if (status) {
    list = list.filter((a) => a.status === status)
  }

  return list
}

/**
 * Confirm shift assignment.
 */
export function confirmShiftAssignment(organizationId: string, assignmentId: string): boolean {
  const key = `${organizationId}:assignments`
  const list = assignments.get(key) || []
  const assignment = list.find((a) => a.id === assignmentId)

  if (!assignment) return false

  assignment.status = 'confirmed'
  assignment.confirmedAt = new Date()

  return true
}

/**
 * Complete shift assignment.
 */
export function completeShiftAssignment(organizationId: string, assignmentId: string, actualFatigueLevel: number): boolean {
  const key = `${organizationId}:assignments`
  const list = assignments.get(key) || []
  const assignment = list.find((a) => a.id === assignmentId)

  if (!assignment) return false

  assignment.status = 'completed'
  assignment.completedAt = new Date()
  assignment.actualFatigueLevel = actualFatigueLevel

  return true
}

/**
 * Record demand forecast.
 */
export function recordDemandForecast(
  organizationId: string,
  workspaceId: string,
  date: Date,
  timeSlot: string,
  expectedDemand: number,
  requiredStaff: number,
  availableStaff: number,
  confidenceLevel: number,
  historicalAccuracy: number
): DemandForecast {
  const forecast: DemandForecast = {
    id: `demand-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    organizationId,
    workspaceId,
    date,
    timeSlot,
    expectedDemand,
    requiredStaff,
    availableStaff,
    coverageGap: Math.max(0, requiredStaff - availableStaff),
    confidenceLevel,
    historicalAccuracy,
  }

  const key = `${organizationId}:demand_forecast`
  const list = forecasts.get(key) || []
  list.push(forecast)

  // Keep last 5000
  const filtered = list.slice(-5000)
  forecasts.set(key, filtered)

  return forecast
}

/**
 * Get demand forecasts.
 */
export function getDemandForecasts(organizationId: string, workspaceId?: string, days: number = 7): DemandForecast[] {
  const key = `${organizationId}:demand_forecast`
  const list = forecasts.get(key) || []
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  let filtered = list.filter((f) => f.date >= cutoff)
  if (workspaceId) {
    filtered = filtered.filter((f) => f.workspaceId === workspaceId)
  }

  return filtered
}

/**
 * Record schedule impact.
 */
export function recordScheduleImpact(
  organizationId: string,
  agentId: string,
  period: ScheduleImpactReport['period'],
  optimizationsApplied: number,
  totalCostSavings: number,
  averageFatigueReduction: number,
  coverageImprovement: number,
  crewSatisfactionImpact: number,
  complianceViolations: number,
  swapRequestsFulfilled: number
): ScheduleImpactReport {
  const report: ScheduleImpactReport = {
    id: `impact-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    organizationId,
    agentId,
    period,
    date: new Date(),
    optimizationsApplied,
    totalCostSavings,
    averageFatigueReduction,
    coverageImprovement,
    crewSatisfactionImpact,
    complianceViolations,
    swapRequestsFulfilled,
  }

  const key = `${organizationId}:schedule_impact`
  const list = impactReports.get(key) || []
  list.push(report)

  // Keep last 500
  const filtered = list.slice(-500)
  impactReports.set(key, filtered)

  logger.info('schedule impact recorded', {
    organizationId,
    agentId,
    period,
    optimizations: optimizationsApplied,
    costSavings: totalCostSavings,
  })

  return report
}

/**
 * Get schedule impact reports.
 */
export function getScheduleImpactReports(organizationId: string, agentId?: string, days: number = 30): ScheduleImpactReport[] {
  const key = `${organizationId}:schedule_impact`
  const list = impactReports.get(key) || []
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  let filtered = list.filter((r) => r.date >= cutoff)
  if (agentId) {
    filtered = filtered.filter((r) => r.agentId === agentId)
  }

  return filtered
}

/**
 * Clear scheduling data (for testing).
 */
export function clearAutonomousScheduling(): void {
  optimizations.clear()
  assignments.clear()
  forecasts.clear()
  impactReports.clear()
}
