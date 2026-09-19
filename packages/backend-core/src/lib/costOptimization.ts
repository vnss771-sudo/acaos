// Phase 5: Automated cost optimization engine with recommendation tracking and rollback.
// Enables auto-application of optimizations with approval workflows and impact tracking.

import { logger } from './logger.js'

export type OptimizationType = 'scale_down' | 'archive_data' | 'schedule_batch' | 'disable_feature' | 'upgrade_plan' | 'reserved_instance'
export type OptimizationStatus = 'recommended' | 'approved' | 'applied' | 'rolled_back' | 'rejected'
export type ApprovalLevel = 'auto' | 'manager' | 'director' | 'cfo'

export interface Optimization {
  id: string
  workspaceId: string
  type: OptimizationType
  title: string
  description: string
  estimatedMonthlySavings: number
  confidenceScore: number // 0-100
  difficulty: 'easy' | 'medium' | 'hard'
  estimatedImplementationHours: number
  status: OptimizationStatus
  approvalLevel: ApprovalLevel
  approvedBy?: string
  approvedAt?: Date
  appliedAt?: Date
  appliedResult?: {
    success: boolean
    actualSavings: number
    message: string
  }
  rolledBackAt?: Date
  createdAt: Date
  expiresAt: Date // recommendation validity window (30 days)
}

export interface OptimizationImpact {
  optimizationId: string
  date: Date
  estimatedCost: number
  actualCost: number
  savingsAchieved: number
  status: 'healthy' | 'underperforming' | 'failed'
}

export interface OptimizationTemplate {
  id: string
  type: OptimizationType
  name: string
  description: string
  defaultApprovalLevel: ApprovalLevel
  autoApplyThreshold: number // ROI threshold for auto-apply (e.g., 50% savings)
  parameters: Record<string, unknown>
}

export interface ApprovalWorkflow {
  optimizationId: string
  workspaceId: string
  approvalLevel: ApprovalLevel
  requiredApprovers: string[]
  approvedBy: string[]
  status: 'pending' | 'approved' | 'rejected'
  rejectionReason?: string
  createdAt: Date
  respondedAt?: Date
}

// Storage
const optimizations = new Map<string, Optimization[]>()
const optimizationImpact = new Map<string, OptimizationImpact[]>()
const approvalWorkflows = new Map<string, ApprovalWorkflow[]>()
const templates = new Map<string, OptimizationTemplate>()

/**
 * Create optimization recommendation.
 */
export function createOptimization(
  workspaceId: string,
  type: OptimizationType,
  title: string,
  description: string,
  estimatedMonthlySavings: number,
  confidenceScore: number,
  difficulty: 'easy' | 'medium' | 'hard',
  estimatedImplementationHours: number,
  approvalLevel: ApprovalLevel = 'auto'
): Optimization {
  const optimization: Optimization = {
    id: `opt-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    workspaceId,
    type,
    title,
    description,
    estimatedMonthlySavings,
    confidenceScore,
    difficulty,
    estimatedImplementationHours,
    status: 'recommended',
    approvalLevel,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
  }

  const list = optimizations.get(workspaceId) || []
  list.push(optimization)
  optimizations.set(workspaceId, list)

  logger.info('optimization created', {
    workspaceId,
    type,
    title,
    estimatedSavings: `$${estimatedMonthlySavings}`,
    confidence: `${confidenceScore}%`,
  })

  return optimization
}

/**
 * Get optimization recommendations for workspace.
 */
export function getOptimizations(
  workspaceId: string,
  status?: OptimizationStatus
): Optimization[] {
  const list = optimizations.get(workspaceId) || []
  const now = new Date()

  return list.filter((opt) => {
    const notExpired = opt.expiresAt > now
    const statusMatch = !status || opt.status === status
    return notExpired && statusMatch
  })
}

/**
 * Get single optimization.
 */
export function getOptimization(optimizationId: string): Optimization | null {
  for (const list of optimizations.values()) {
    const opt = list.find((o) => o.id === optimizationId)
    if (opt) return opt
  }
  return null
}

/**
 * Apply optimization (with approval workflow).
 */
export function applyOptimization(
  workspaceId: string,
  optimizationId: string,
  approvedBy: string,
  result: { success: boolean; actualSavings: number; message: string }
): boolean {
  const list = optimizations.get(workspaceId) || []
  const opt = list.find((o) => o.id === optimizationId)

  if (!opt) return false

  opt.status = result.success ? 'applied' : 'rejected'
  opt.approvedBy = approvedBy
  opt.approvedAt = new Date()
  opt.appliedAt = new Date()
  opt.appliedResult = result

  logger.info('optimization applied', {
    workspaceId,
    optimizationId,
    type: opt.type,
    success: result.success,
    savingsAchieved: `$${result.actualSavings}`,
  })

  return true
}

/**
 * Rollback optimization.
 */
export function rollbackOptimization(
  workspaceId: string,
  optimizationId: string,
  reason: string
): boolean {
  const list = optimizations.get(workspaceId) || []
  const opt = list.find((o) => o.id === optimizationId)

  if (!opt || opt.status !== 'applied') return false

  opt.status = 'rolled_back'
  opt.rolledBackAt = new Date()

  logger.info('optimization rolled back', {
    workspaceId,
    optimizationId,
    reason,
  })

  return true
}

/**
 * Record optimization impact (actual cost savings over time).
 */
export function recordOptimizationImpact(
  optimizationId: string,
  estimatedCost: number,
  actualCost: number
): OptimizationImpact {
  const savingsAchieved = estimatedCost - actualCost
  const percentageSavings = (savingsAchieved / estimatedCost) * 100

  let status: 'healthy' | 'underperforming' | 'failed'
  if (percentageSavings >= 80) {
    status = 'healthy'
  } else if (percentageSavings >= 50) {
    status = 'underperforming'
  } else {
    status = 'failed'
  }

  const impact: OptimizationImpact = {
    optimizationId,
    date: new Date(),
    estimatedCost,
    actualCost,
    savingsAchieved,
    status,
  }

  const list = optimizationImpact.get(optimizationId) || []
  list.push(impact)
  optimizationImpact.set(optimizationId, list)

  logger.info('optimization impact recorded', {
    optimizationId,
    savingsAchieved: `$${savingsAchieved.toFixed(2)}`,
    status,
  })

  return impact
}

/**
 * Get optimization impact history.
 */
export function getOptimizationImpactHistory(
  optimizationId: string,
  days: number = 30
): OptimizationImpact[] {
  const list = optimizationImpact.get(optimizationId) || []
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  return list.filter((impact) => impact.date >= cutoff)
}

/**
 * Calculate ROI of optimization.
 */
export function calculateOptimizationROI(
  optimizationId: string
): {
  totalEstimatedSavings: number
  totalActualSavings: number
  averageMonthlyROI: number
  impactCount: number
} {
  const impacts = optimizationImpact.get(optimizationId) || []

  const totalEstimatedSavings = impacts.reduce((sum, i) => sum + i.estimatedCost, 0)
  const totalActualSavings = impacts.reduce((sum, i) => sum + i.savingsAchieved, 0)
  const averageMonthlyROI =
    impacts.length > 0 ? totalActualSavings / impacts.length : 0

  return {
    totalEstimatedSavings,
    totalActualSavings,
    averageMonthlyROI,
    impactCount: impacts.length,
  }
}

/**
 * Create approval workflow for optimization.
 */
export function createApprovalWorkflow(
  workspaceId: string,
  optimizationId: string,
  approvalLevel: ApprovalLevel,
  requiredApprovers: string[]
): ApprovalWorkflow {
  const workflow: ApprovalWorkflow = {
    optimizationId,
    workspaceId,
    approvalLevel,
    requiredApprovers,
    approvedBy: [],
    status: 'pending',
    createdAt: new Date(),
  }

  const list = approvalWorkflows.get(workspaceId) || []
  list.push(workflow)
  approvalWorkflows.set(workspaceId, list)

  logger.info('approval workflow created', {
    workspaceId,
    optimizationId,
    approvalLevel,
    requiredApprovers: requiredApprovers.length,
  })

  return workflow
}

/**
 * Approve optimization.
 */
export function approveOptimization(
  workspaceId: string,
  optimizationId: string,
  approver: string
): boolean {
  const list = approvalWorkflows.get(workspaceId) || []
  const workflow = list.find((w) => w.optimizationId === optimizationId)

  if (!workflow || workflow.status !== 'pending') return false

  if (!workflow.approvedBy.includes(approver)) {
    workflow.approvedBy.push(approver)
  }

  // Check if all required approvers have approved
  const allApproved = workflow.requiredApprovers.every((approver) =>
    workflow.approvedBy.includes(approver)
  )

  if (allApproved) {
    workflow.status = 'approved'
    workflow.respondedAt = new Date()
  }

  return true
}

/**
 * Reject optimization.
 */
export function rejectOptimization(
  workspaceId: string,
  optimizationId: string,
  reason: string
): boolean {
  const list = approvalWorkflows.get(workspaceId) || []
  const workflow = list.find((w) => w.optimizationId === optimizationId)

  if (!workflow || workflow.status !== 'pending') return false

  workflow.status = 'rejected'
  workflow.rejectionReason = reason
  workflow.respondedAt = new Date()

  return true
}

/**
 * Get approval workflow for optimization.
 */
export function getApprovalWorkflow(
  workspaceId: string,
  optimizationId: string
): ApprovalWorkflow | null {
  const list = approvalWorkflows.get(workspaceId) || []
  return list.find((w) => w.optimizationId === optimizationId) || null
}

/**
 * Get ROI-ranked optimization suggestions (highest savings first).
 */
export function getOptimizationSuggestions(
  workspaceId: string,
  limit: number = 10
): Optimization[] {
  const opts = getOptimizations(workspaceId, 'recommended')

  return opts
    .sort((a, b) => {
      const roiA = (a.estimatedMonthlySavings / (a.estimatedImplementationHours || 1)) * (a.confidenceScore / 100)
      const roiB = (b.estimatedMonthlySavings / (b.estimatedImplementationHours || 1)) * (b.confidenceScore / 100)
      return roiB - roiA
    })
    .slice(0, limit)
}

/**
 * Get total potential savings from all recommendations.
 */
export function getTotalPotentialSavings(workspaceId: string): number {
  return getOptimizations(workspaceId, 'recommended').reduce(
    (sum, opt) => sum + opt.estimatedMonthlySavings,
    0
  )
}

/**
 * Get total realized savings from applied optimizations.
 */
export function getTotalRealizedSavings(workspaceId: string): number {
  const applied = getOptimizations(workspaceId, 'applied')

  return applied.reduce((sum, opt) => {
    const roi = calculateOptimizationROI(opt.id)
    return sum + roi.totalActualSavings
  }, 0)
}

/**
 * Register optimization template.
 */
export function registerOptimizationTemplate(template: OptimizationTemplate): void {
  templates.set(template.id, template)

  logger.info('optimization template registered', {
    templateId: template.id,
    type: template.type,
    autoApplyThreshold: `${template.autoApplyThreshold}%`,
  })
}

/**
 * Get optimization template.
 */
export function getOptimizationTemplate(templateId: string): OptimizationTemplate | null {
  return templates.get(templateId) || null
}

/**
 * Initialize default optimization templates.
 */
export function initializeDefaultTemplates(): void {
  registerOptimizationTemplate({
    id: 'scale_down_vm',
    type: 'scale_down',
    name: 'Scale Down VM',
    description: 'Downsize underutilized virtual machines',
    defaultApprovalLevel: 'auto',
    autoApplyThreshold: 50,
    parameters: { cpuThreshold: 20, memoryThreshold: 25, duration: '7d' },
  })

  registerOptimizationTemplate({
    id: 'archive_old_data',
    type: 'archive_data',
    name: 'Archive Old Data',
    description: 'Move unused data to cold storage',
    defaultApprovalLevel: 'manager',
    autoApplyThreshold: 30,
    parameters: { ageThreshold: '90d', storageClass: 'cold' },
  })

  registerOptimizationTemplate({
    id: 'schedule_batch_jobs',
    type: 'schedule_batch',
    name: 'Schedule Batch Jobs',
    description: 'Run batch jobs during off-peak hours',
    defaultApprovalLevel: 'auto',
    autoApplyThreshold: 40,
    parameters: { scheduleWindow: '02:00-06:00', dayOfWeek: 'any' },
  })

  registerOptimizationTemplate({
    id: 'reserve_capacity',
    type: 'reserved_instance',
    name: 'Reserve Capacity',
    description: 'Purchase reserved instances for stable workloads',
    defaultApprovalLevel: 'director',
    autoApplyThreshold: 25,
    parameters: { commitmentTerm: '1y', paymentOption: 'upfront' },
  })

  logger.info('default optimization templates initialized')
}

/**
 * Clear optimization data (for testing).
 */
export function clearOptimizations(): void {
  optimizations.clear()
  optimizationImpact.clear()
  approvalWorkflows.clear()
}
