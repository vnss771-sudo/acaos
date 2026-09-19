// Phase 6: Governance engine with policy definition, enforcement, and compliance tracking.
// Enables organizations to define and enforce cost control policies with audit trails.

import { logger } from './logger.js'

export type PolicyType = 'budget_limit' | 'cost_threshold' | 'approval_requirement' | 'resource_restriction' | 'compliance'
export type PolicyScope = 'organization' | 'department' | 'team' | 'user'
export type ComplianceStatus = 'compliant' | 'at_risk' | 'non_compliant'

export interface Policy {
  id: string
  workspaceId: string
  name: string
  description?: string
  type: PolicyType
  scope: PolicyScope
  entityId?: string // department/team/user ID if scoped
  rules: Record<string, unknown> // type-specific rules
  enabled: boolean
  priority: number // 1-10, higher = enforce first
  createdAt: Date
  updatedAt: Date
}

export interface PolicyEnforcement {
  id: string
  policyId: string
  workspaceId: string
  entityId: string // user/team/department being evaluated
  status: 'pass' | 'fail' | 'warning'
  violations: Array<{
    rule: string
    actual: unknown
    limit: unknown
    severity: 'warning' | 'critical'
  }>
  checkedAt: Date
}

export interface ComplianceReport {
  id: string
  workspaceId: string
  period: 'daily' | 'weekly' | 'monthly'
  generatedAt: Date
  overallStatus: ComplianceStatus
  policyResults: Array<{
    policyId: string
    policyName: string
    passCount: number
    failCount: number
    compliance: number // 0-100%
  }>
  recommendations: string[]
}

export interface AuditTrail {
  id: string
  workspaceId: string
  policyId: string
  entityId: string
  action: string
  result: 'approved' | 'denied' | 'warning'
  reason?: string
  metadata: Record<string, unknown>
  timestamp: Date
}

// Storage
const policies = new Map<string, Policy[]>()
const enforcements = new Map<string, PolicyEnforcement[]>()
const complianceReports = new Map<string, ComplianceReport[]>()
const auditTrails = new Map<string, AuditTrail[]>()

/**
 * Create policy.
 */
export function createPolicy(
  workspaceId: string,
  name: string,
  description: string,
  type: PolicyType,
  scope: PolicyScope,
  rules: Record<string, unknown>,
  entityId?: string,
  priority: number = 5
): Policy {
  const policy: Policy = {
    id: `policy-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    workspaceId,
    name,
    description,
    type,
    scope,
    entityId,
    rules,
    enabled: true,
    priority,
    createdAt: new Date(),
    updatedAt: new Date(),
  }

  const list = policies.get(workspaceId) || []
  list.push(policy)
  policies.set(workspaceId, list)

  logger.info('policy created', {
    policyId: policy.id,
    workspaceId,
    name,
    type,
    scope,
  })

  return policy
}

/**
 * Get policy by ID.
 */
export function getPolicy(workspaceId: string, policyId: string): Policy | null {
  const list = policies.get(workspaceId) || []
  return list.find((p) => p.id === policyId) || null
}

/**
 * Get all policies for workspace.
 */
export function getWorkspacePolicies(workspaceId: string, type?: PolicyType): Policy[] {
  const list = policies.get(workspaceId) || []
  return type ? list.filter((p) => p.type === type && p.enabled) : list.filter((p) => p.enabled)
}

/**
 * Update policy.
 */
export function updatePolicy(
  workspaceId: string,
  policyId: string,
  updates: Partial<Policy>
): boolean {
  const list = policies.get(workspaceId) || []
  const policy = list.find((p) => p.id === policyId)

  if (!policy) return false

  Object.assign(policy, { ...updates, updatedAt: new Date() })

  logger.info('policy updated', {
    workspaceId,
    policyId,
  })

  return true
}

/**
 * Enable policy.
 */
export function enablePolicy(workspaceId: string, policyId: string): boolean {
  return updatePolicy(workspaceId, policyId, { enabled: true })
}

/**
 * Disable policy.
 */
export function disablePolicy(workspaceId: string, policyId: string): boolean {
  return updatePolicy(workspaceId, policyId, { enabled: false })
}

/**
 * Delete policy.
 */
export function deletePolicy(workspaceId: string, policyId: string): boolean {
  const list = policies.get(workspaceId) || []
  const filtered = list.filter((p) => p.id !== policyId)
  policies.set(workspaceId, filtered)
  return filtered.length < list.length
}

/**
 * Evaluate policy against entity data.
 */
function evaluatePolicy(
  policy: Policy,
  entityData: Record<string, unknown>
): {
  passed: boolean
  violations: Array<{ rule: string; actual: unknown; limit: unknown; severity: 'warning' | 'critical' }>
} {
  const violations: Array<{ rule: string; actual: unknown; limit: unknown; severity: 'warning' | 'critical' }> = []

  try {
    switch (policy.type) {
      case 'budget_limit': {
        const limit = (policy.rules.amount as number) || 0
        const spent = (entityData.spent as number) || 0
        if (spent > limit) {
          violations.push({
            rule: 'budget_exceeded',
            actual: spent,
            limit,
            severity: 'critical',
          })
        }
        break
      }

      case 'cost_threshold': {
        const threshold = (policy.rules.threshold as number) || 0
        const cost = (entityData.cost as number) || 0
        if (cost > threshold) {
          violations.push({
            rule: 'cost_threshold_exceeded',
            actual: cost,
            limit: threshold,
            severity: (policy.rules.severity as 'warning' | 'critical') || 'warning',
          })
        }
        break
      }

      case 'approval_requirement': {
        const required = policy.rules.required as boolean
        const hasApproval = entityData.approved as boolean
        if (required && !hasApproval) {
          violations.push({
            rule: 'approval_missing',
            actual: false,
            limit: true,
            severity: 'critical',
          })
        }
        break
      }

      case 'resource_restriction': {
        const allowed = policy.rules.allowed as string[]
        const resourceType = entityData.type as string
        if (!allowed.includes(resourceType)) {
          violations.push({
            rule: 'resource_not_allowed',
            actual: resourceType,
            limit: `allowed: ${allowed.join(',')}`,
            severity: 'critical',
          })
        }
        break
      }

      case 'compliance': {
        const rules = policy.rules as Record<string, unknown>
        for (const [rule, limit] of Object.entries(rules)) {
          const actual = entityData[rule]
          if (actual !== limit) {
            violations.push({
              rule,
              actual,
              limit,
              severity: 'warning',
            })
          }
        }
        break
      }
    }
  } catch (error) {
    logger.error('policy evaluation error', { error, policyId: policy.id })
  }

  return {
    passed: violations.length === 0,
    violations,
  }
}

/**
 * Enforce policies against entity.
 */
export function enforcePolicies(
  workspaceId: string,
  entityId: string,
  entityData: Record<string, unknown>
): PolicyEnforcement {
  const policyList = getWorkspacePolicies(workspaceId)
    .filter((p) => !p.entityId || p.entityId === entityId)
    .sort((a, b) => b.priority - a.priority)

  const violations: Array<{
    rule: string
    actual: unknown
    limit: unknown
    severity: 'warning' | 'critical'
  }> = []
  let status: 'pass' | 'fail' | 'warning' = 'pass'

  for (const policy of policyList) {
    const result = evaluatePolicy(policy, entityData)
    violations.push(...result.violations)

    if (!result.passed) {
      if (violations.some((v) => v.severity === 'critical')) {
        status = 'fail'
      } else {
        status = 'warning'
      }
    }
  }

  const enforcement: PolicyEnforcement = {
    id: `enforce-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    policyId: policyList[0]?.id || 'none',
    workspaceId,
    entityId,
    status,
    violations,
    checkedAt: new Date(),
  }

  const list = enforcements.get(workspaceId) || []
  list.push(enforcement)
  enforcements.set(workspaceId, list)

  logger.info('policy enforcement completed', {
    workspaceId,
    entityId,
    status,
    violationCount: violations.length,
  })

  return enforcement
}

/**
 * Get enforcement history for entity.
 */
export function getEnforcementHistory(
  workspaceId: string,
  entityId: string,
  days: number = 30
): PolicyEnforcement[] {
  const list = enforcements.get(workspaceId) || []
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  return list.filter((e) => e.entityId === entityId && e.checkedAt >= cutoff)
}

/**
 * Record audit trail entry.
 */
export function recordAuditTrail(
  workspaceId: string,
  policyId: string,
  entityId: string,
  action: string,
  result: 'approved' | 'denied' | 'warning',
  reason?: string,
  metadata?: Record<string, unknown>
): AuditTrail {
  const trail: AuditTrail = {
    id: `audit-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    workspaceId,
    policyId,
    entityId,
    action,
    result,
    reason,
    metadata: metadata || {},
    timestamp: new Date(),
  }

  const list = auditTrails.get(workspaceId) || []
  list.push(trail)

  // Keep last 365 days
  const cutoff = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000)
  const filtered = list.filter((e) => e.timestamp >= cutoff)
  auditTrails.set(workspaceId, filtered)

  return trail
}

/**
 * Get audit trail for policy.
 */
export function getPolicyAuditTrail(
  workspaceId: string,
  policyId: string,
  days: number = 30
): AuditTrail[] {
  const list = auditTrails.get(workspaceId) || []
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  return list.filter((e) => e.policyId === policyId && e.timestamp >= cutoff)
}

/**
 * Generate compliance report.
 */
export function generateComplianceReport(
  workspaceId: string,
  period: 'daily' | 'weekly' | 'monthly' = 'weekly'
): ComplianceReport {
  const policyList = getWorkspacePolicies(workspaceId)
  const enforcementList = enforcements.get(workspaceId) || []

  const policyResults = policyList.map((policy) => {
    const matchingEnforcements = enforcementList.filter(
      (e) => e.policyId === policy.id && e.checkedAt > new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    )

    const passCount = matchingEnforcements.filter((e) => e.status === 'pass').length
    const failCount = matchingEnforcements.filter((e) => e.status === 'fail').length
    const total = matchingEnforcements.length || 1
    const compliance = Math.round((passCount / total) * 100)

    return {
      policyId: policy.id,
      policyName: policy.name,
      passCount,
      failCount,
      compliance,
    }
  })

  const avgCompliance = policyResults.length > 0
    ? Math.round(policyResults.reduce((sum, r) => sum + r.compliance, 0) / policyResults.length)
    : 100

  const overallStatus: ComplianceStatus =
    avgCompliance >= 95 ? 'compliant' : avgCompliance >= 80 ? 'at_risk' : 'non_compliant'

  const recommendations: string[] = []
  for (const result of policyResults) {
    if (result.compliance < 80) {
      recommendations.push(`Policy "${result.policyName}" has low compliance (${result.compliance}%)`)
    }
  }

  const report: ComplianceReport = {
    id: `report-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    workspaceId,
    period,
    generatedAt: new Date(),
    overallStatus,
    policyResults,
    recommendations,
  }

  const list = complianceReports.get(workspaceId) || []
  list.push(report)
  complianceReports.set(workspaceId, list)

  logger.info('compliance report generated', {
    workspaceId,
    period,
    overallStatus,
    policyCount: policyResults.length,
  })

  return report
}

/**
 * Get compliance reports.
 */
export function getComplianceReports(
  workspaceId: string,
  days: number = 90,
  limit: number = 10
): ComplianceReport[] {
  const list = complianceReports.get(workspaceId) || []
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  return list.filter((r) => r.generatedAt >= cutoff).slice(-limit)
}

/**
 * Clear governance data (for testing).
 */
export function clearGovernance(): void {
  policies.clear()
  enforcements.clear()
  complianceReports.clear()
  auditTrails.clear()
}
