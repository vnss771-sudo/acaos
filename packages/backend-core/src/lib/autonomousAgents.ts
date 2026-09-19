// Phase 10: Autonomous agents framework for self-executing operations.
// Agents make decisions based on Phase 9 ML models and execute low-risk actions autonomously.

import { logger } from './logger.js'

export interface Agent {
  id: string
  organizationId: string
  name: string
  type: 'cost_optimization' | 'crew_scheduling' | 'capacity_planning' | 'anomaly_response' | 'workflow_automation'
  status: 'active' | 'paused' | 'suspended'
  riskProfile: 'conservative' | 'balanced' | 'aggressive'
  autoApprovalThreshold: number // $, max cost change per action
  executionMode: 'dry_run' | 'manual_approval' | 'autonomous'
  config: Record<string, unknown>
  metrics: {
    decisionsProposed: number
    decisionsExecuted: number
    decisionsRejected: number
    actionsSuccessful: number
    actionsFailed: number
    totalSavingsGenerated: number
    successRate: number // 0-1
  }
  createdAt: Date
  lastExecutionAt?: Date
  nextScheduledRun?: Date
}

export interface AgentDecision {
  id: string
  organizationId: string
  agentId: string
  type: string
  priority: 'low' | 'medium' | 'high' | 'critical'
  riskScore: number // 0-1
  proposedAction: {
    title: string
    description: string
    estimatedImpact: Record<string, unknown>
    estimatedCost?: number
    rollbackPlan?: string
  }
  status: 'proposed' | 'approved' | 'rejected' | 'executing' | 'executed' | 'failed'
  approvalRequiredReason?: string
  approvedByUserId?: string
  approvedAt?: Date
  executedAt?: Date
  result?: {
    success: boolean
    message: string
    actualImpact?: Record<string, unknown>
    actualCost?: number
  }
  createdAt: Date
}

export interface AgentExecution {
  id: string
  organizationId: string
  agentId: string
  startedAt: Date
  completedAt?: Date
  status: 'running' | 'completed' | 'failed' | 'paused'
  decisionsProposed: number
  decisionsExecuted: number
  decisionsRejected: number
  totalActions: number
  successfulActions: number
  failedActions: number
  errors: Array<{ action: string; error: string; timestamp: Date }>
  executionTimeMs?: number
}

export interface AgentPerformance {
  id: string
  organizationId: string
  agentId: string
  period: 'day' | 'week' | 'month'
  date: Date
  decisionsProposed: number
  decisionsExecuted: number
  executionRate: number // 0-1
  successRate: number // 0-1
  totalSavingsGenerated: number
  averageDecisionTime: number // ms
  averageExecutionTime: number // ms
  anomalies: number
  incidents: number
}

// Storage
const agents = new Map<string, Agent[]>()
const decisions = new Map<string, AgentDecision[]>()
const executions = new Map<string, AgentExecution[]>()
const performance = new Map<string, AgentPerformance[]>()

/**
 * Create an autonomous agent.
 */
export function createAgent(
  organizationId: string,
  name: string,
  type: Agent['type'],
  riskProfile: Agent['riskProfile'],
  autoApprovalThreshold: number,
  executionMode: Agent['executionMode'],
  config: Record<string, unknown> = {}
): Agent {
  const agent: Agent = {
    id: `agent-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    organizationId,
    name,
    type,
    status: 'active',
    riskProfile,
    autoApprovalThreshold,
    executionMode,
    config,
    metrics: {
      decisionsProposed: 0,
      decisionsExecuted: 0,
      decisionsRejected: 0,
      actionsSuccessful: 0,
      actionsFailed: 0,
      totalSavingsGenerated: 0,
      successRate: 1.0,
    },
    createdAt: new Date(),
  }

  const key = `${organizationId}:agents`
  const list = agents.get(key) || []
  list.push(agent)
  agents.set(key, list)

  logger.info('autonomous agent created', {
    organizationId,
    agentId: agent.id,
    type,
    riskProfile,
  })

  return agent
}

/**
 * Get agents.
 */
export function getAgents(organizationId: string, type?: Agent['type']): Agent[] {
  const key = `${organizationId}:agents`
  const list = agents.get(key) || []
  return type ? list.filter((a) => a.type === type) : list
}

/**
 * Get agent by ID.
 */
export function getAgent(organizationId: string, agentId: string): Agent | null {
  const key = `${organizationId}:agents`
  const list = agents.get(key) || []
  return list.find((a) => a.id === agentId) || null
}

/**
 * Update agent status.
 */
export function updateAgentStatus(organizationId: string, agentId: string, status: Agent['status']): boolean {
  const agent = getAgent(organizationId, agentId)
  if (!agent) return false

  agent.status = status
  logger.info('agent status updated', { organizationId, agentId, status })
  return true
}

/**
 * Propose a decision for an agent.
 */
export function proposeDecision(
  organizationId: string,
  agentId: string,
  decisionType: string,
  priority: AgentDecision['priority'],
  riskScore: number,
  proposedAction: AgentDecision['proposedAction']
): AgentDecision {
  const agent = getAgent(organizationId, agentId)
  if (!agent) throw new Error('Agent not found')

  const requiresApproval = riskScore > 0.7 || proposedAction.estimatedCost! > agent.autoApprovalThreshold

  const decision: AgentDecision = {
    id: `decision-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    organizationId,
    agentId,
    type: decisionType,
    priority,
    riskScore,
    proposedAction,
    status: requiresApproval ? 'proposed' : 'approved',
    approvalRequiredReason: requiresApproval ? `Risk score ${riskScore.toFixed(2)} exceeds threshold or cost exceeds limit` : undefined,
    createdAt: new Date(),
  }

  const key = `${organizationId}:decisions`
  const list = decisions.get(key) || []
  list.push(decision)

  // Keep last 5000
  const filtered = list.slice(-5000)
  decisions.set(key, filtered)

  // Update agent metrics
  agent.metrics.decisionsProposed++

  logger.info('decision proposed', {
    organizationId,
    agentId,
    decisionType,
    riskScore,
    requiresApproval,
  })

  return decision
}

/**
 * Get decisions for an agent.
 */
export function getDecisions(organizationId: string, agentId?: string, status?: string): AgentDecision[] {
  const key = `${organizationId}:decisions`
  let list = decisions.get(key) || []

  if (agentId) {
    list = list.filter((d) => d.agentId === agentId)
  }
  if (status) {
    list = list.filter((d) => d.status === status)
  }

  return list
}

/**
 * Get decision by ID.
 */
export function getDecision(organizationId: string, decisionId: string): AgentDecision | null {
  const key = `${organizationId}:decisions`
  const list = decisions.get(key) || []
  return list.find((d) => d.id === decisionId) || null
}

/**
 * Approve a decision.
 */
export function approveDecision(organizationId: string, decisionId: string, userId: string): boolean {
  const decision = getDecision(organizationId, decisionId)
  if (!decision) return false

  decision.status = 'approved'
  decision.approvedByUserId = userId
  decision.approvedAt = new Date()

  logger.info('decision approved', { organizationId, decisionId, userId })
  return true
}

/**
 * Reject a decision.
 */
export function rejectDecision(organizationId: string, decisionId: string, reason: string): boolean {
  const decision = getDecision(organizationId, decisionId)
  if (!decision) return false

  decision.status = 'rejected'
  decision.approvalRequiredReason = reason

  const agent = getAgent(organizationId, decision.agentId)
  if (agent) {
    agent.metrics.decisionsRejected++
  }

  logger.info('decision rejected', { organizationId, decisionId, reason })
  return true
}

/**
 * Execute a decision.
 */
export function executeDecision(organizationId: string, decisionId: string, success: boolean, message: string, actualCost?: number): AgentDecision | null {
  const decision = getDecision(organizationId, decisionId)
  if (!decision) return null

  decision.status = success ? 'executed' : 'failed'
  decision.executedAt = new Date()
  decision.result = {
    success,
    message,
    actualCost,
  }

  const agent = getAgent(organizationId, decision.agentId)
  if (agent) {
    agent.metrics.decisionsExecuted++
    if (success) {
      agent.metrics.actionsSuccessful++
      if (actualCost) {
        agent.metrics.totalSavingsGenerated += Math.max(0, (decision.proposedAction.estimatedCost || 0) - actualCost)
      }
    } else {
      agent.metrics.actionsFailed++
    }
    agent.metrics.successRate = agent.metrics.actionsSuccessful / Math.max(1, agent.metrics.actionsSuccessful + agent.metrics.actionsFailed)
    agent.lastExecutionAt = new Date()
  }

  logger.info('decision executed', {
    organizationId,
    decisionId,
    success,
    actualCost,
  })

  return decision
}

/**
 * Record agent execution run.
 */
export function recordExecution(
  organizationId: string,
  agentId: string,
  decisionsProposed: number,
  decisionsExecuted: number,
  decisionsRejected: number,
  successfulActions: number,
  failedActions: number,
  errors: Array<{ action: string; error: string; timestamp: Date }> = [],
  executionTimeMs: number = 0
): AgentExecution {
  const execution: AgentExecution = {
    id: `exec-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    organizationId,
    agentId,
    startedAt: new Date(Date.now() - executionTimeMs),
    completedAt: new Date(),
    status: failedActions > 0 ? 'completed' : 'completed',
    decisionsProposed,
    decisionsExecuted,
    decisionsRejected,
    totalActions: successfulActions + failedActions,
    successfulActions,
    failedActions,
    errors,
    executionTimeMs,
  }

  const key = `${organizationId}:executions`
  const list = executions.get(key) || []
  list.push(execution)

  // Keep last 1000
  const filtered = list.slice(-1000)
  executions.set(key, filtered)

  logger.info('agent execution recorded', {
    organizationId,
    agentId,
    decisionsExecuted,
    successfulActions,
    failedActions,
  })

  return execution
}

/**
 * Get execution history.
 */
export function getExecutions(organizationId: string, agentId?: string, hours: number = 168): AgentExecution[] {
  const key = `${organizationId}:executions`
  const list = executions.get(key) || []
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000)

  let filtered = list.filter((e) => e.completedAt && e.completedAt >= cutoff)
  if (agentId) {
    filtered = filtered.filter((e) => e.agentId === agentId)
  }

  return filtered
}

/**
 * Record agent performance metrics.
 */
export function recordPerformance(
  organizationId: string,
  agentId: string,
  period: AgentPerformance['period'],
  decisionsProposed: number,
  decisionsExecuted: number,
  successfulActions: number,
  failedActions: number,
  totalSavings: number,
  avgDecisionTime: number,
  avgExecutionTime: number,
  anomalies: number = 0,
  incidents: number = 0
): AgentPerformance {
  const perf: AgentPerformance = {
    id: `perf-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    organizationId,
    agentId,
    period,
    date: new Date(),
    decisionsProposed,
    decisionsExecuted,
    executionRate: decisionsProposed > 0 ? decisionsExecuted / decisionsProposed : 0,
    successRate: successfulActions + failedActions > 0 ? successfulActions / (successfulActions + failedActions) : 1.0,
    totalSavingsGenerated: totalSavings,
    averageDecisionTime: avgDecisionTime,
    averageExecutionTime: avgExecutionTime,
    anomalies,
    incidents,
  }

  const key = `${organizationId}:performance`
  const list = performance.get(key) || []
  list.push(perf)

  // Keep last 500
  const filtered = list.slice(-500)
  performance.set(key, filtered)

  return perf
}

/**
 * Get agent performance.
 */
export function getPerformance(organizationId: string, agentId?: string, days: number = 30): AgentPerformance[] {
  const key = `${organizationId}:performance`
  const list = performance.get(key) || []
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  let filtered = list.filter((p) => p.date >= cutoff)
  if (agentId) {
    filtered = filtered.filter((p) => p.agentId === agentId)
  }

  return filtered
}

/**
 * Clear autonomous agents data (for testing).
 */
export function clearAutonomousAgents(): void {
  agents.clear()
  decisions.clear()
  executions.clear()
  performance.clear()
}
