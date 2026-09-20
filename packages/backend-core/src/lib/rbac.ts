// Phase 6: Role-based access control with granular permissions and cost visibility scoping.
// Enables fine-grained authorization and cost data isolation per user/role.

import { logger } from './logger.js'

export type Permission =
  | 'view_costs' | 'export_costs' | 'manage_budgets' | 'approve_optimizations' | 'manage_policies'
  | 'manage_users' | 'manage_roles' | 'view_audit_log' | 'manage_webhooks' | 'view_forecasts'
  | 'approve_budget_requests' | 'manage_rate_limits' | 'disable_features'

export type CostVisibilityScope = 'org_wide' | 'department' | 'team' | 'self_only'
export type ApprovalAuthority = 'none' | 'team_lead' | 'manager' | 'director' | 'cfo'

export interface Role {
  id: string
  name: string
  description?: string
  permissions: Permission[]
  approvalAuthority: ApprovalAuthority
  costVisibilityScope: CostVisibilityScope
  maxApprovalAmount: number // $, 0 = unlimited
  createdAt: Date
}

export interface UserRole {
  userId: string
  workspaceId: string
  roleId: string
  departmentId?: string
  teamId?: string
  assignedAt: Date
}

export interface RolePermission {
  roleId: string
  permission: Permission
  grantedAt: Date
}

export interface CostVisibilityRule {
  userId: string
  workspaceId: string
  scope: CostVisibilityScope
  visibleDepartments?: string[] // if scope=department
  visibleTeams?: string[] // if scope=team
  createdAt: Date
}

export interface AuditLogEntry {
  id: string
  workspaceId: string
  userId: string
  action: string
  resourceType: string
  resourceId: string
  changes?: Record<string, { before: unknown; after: unknown }>
  result: 'success' | 'denied'
  denialReason?: string
  timestamp: Date
}

// Storage
const roles = new Map<string, Role>()
const userRoles = new Map<string, UserRole[]>()
const costVisibilityRules = new Map<string, CostVisibilityRule[]>()
const auditLog = new Map<string, AuditLogEntry[]>()

// Default roles
const defaultRoles = new Map<string, Role>()

/**
 * Create role with permissions.
 */
export function createRole(
  name: string,
  description: string,
  permissions: Permission[],
  approvalAuthority: ApprovalAuthority = 'none',
  costVisibilityScope: CostVisibilityScope = 'self_only',
  maxApprovalAmount: number = 0
): Role {
  const role: Role = {
    id: `role-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name,
    description,
    permissions,
    approvalAuthority,
    costVisibilityScope,
    maxApprovalAmount,
    createdAt: new Date(),
  }

  roles.set(role.id, role)

  logger.info('role created', {
    roleId: role.id,
    name,
    permissionCount: permissions.length,
    approvalAuthority,
  })

  return role
}

/**
 * Get role by ID.
 */
export function getRole(roleId: string): Role | null {
  return roles.get(roleId) || null
}

/**
 * Assign role to user.
 */
export function assignUserRole(
  workspaceId: string,
  userId: string,
  roleId: string,
  departmentId?: string,
  teamId?: string
): UserRole {
  const userRole: UserRole = {
    userId,
    workspaceId,
    roleId,
    departmentId,
    teamId,
    assignedAt: new Date(),
  }

  const list = userRoles.get(userId) || []
  // Remove existing role for this workspace
  const filtered = list.filter((ur) => ur.workspaceId !== workspaceId)
  filtered.push(userRole)
  userRoles.set(userId, filtered)

  logger.info('user role assigned', {
    userId,
    workspaceId,
    roleId,
    departmentId,
    teamId,
  })

  return userRole
}

/**
 * Get user's role in workspace.
 */
export function getUserRole(workspaceId: string, userId: string): UserRole | null {
  const list = userRoles.get(userId) || []
  return list.find((ur) => ur.workspaceId === workspaceId) || null
}

/**
 * Check if user has permission.
 */
export function hasPermission(
  workspaceId: string,
  userId: string,
  permission: Permission
): boolean {
  const userRole = getUserRole(workspaceId, userId)
  if (!userRole) return false

  const role = getRole(userRole.roleId)
  if (!role) return false

  return role.permissions.includes(permission)
}

/**
 * Check if user can approve amount.
 */
export function canApproveAmount(
  workspaceId: string,
  userId: string,
  amount: number
): boolean {
  const userRole = getUserRole(workspaceId, userId)
  if (!userRole) return false

  const role = getRole(userRole.roleId)
  if (!role || role.approvalAuthority === 'none') return false

  if (role.maxApprovalAmount === 0) return true // Unlimited
  return amount <= role.maxApprovalAmount
}

/**
 * Get cost visibility scope for user.
 */
export function getCostVisibilityScope(
  workspaceId: string,
  userId: string
): CostVisibilityScope {
  const userRole = getUserRole(workspaceId, userId)
  if (!userRole) return 'self_only'

  const role = getRole(userRole.roleId)
  return role?.costVisibilityScope || 'self_only'
}

/**
 * Set custom cost visibility rule.
 */
export function setCostVisibilityRule(
  workspaceId: string,
  userId: string,
  scope: CostVisibilityScope,
  visibleDepartments?: string[],
  visibleTeams?: string[]
): CostVisibilityRule {
  const rule: CostVisibilityRule = {
    userId,
    workspaceId,
    scope,
    visibleDepartments,
    visibleTeams,
    createdAt: new Date(),
  }

  const list = costVisibilityRules.get(userId) || []
  const filtered = list.filter((r) => r.workspaceId !== workspaceId)
  filtered.push(rule)
  costVisibilityRules.set(userId, filtered)

  return rule
}

/**
 * Record audit log entry.
 */
export function logAuditEntry(
  workspaceId: string,
  userId: string,
  action: string,
  resourceType: string,
  resourceId: string,
  result: 'success' | 'denied',
  denialReason?: string,
  changes?: Record<string, { before: unknown; after: unknown }>
): AuditLogEntry {
  const entry: AuditLogEntry = {
    id: `audit-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    workspaceId,
    userId,
    action,
    resourceType,
    resourceId,
    changes,
    result,
    denialReason,
    timestamp: new Date(),
  }

  const list = auditLog.get(workspaceId) || []
  list.push(entry)

  // Keep last 365 days
  const cutoff = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000)
  const filtered = list.filter((e) => e.timestamp >= cutoff)
  auditLog.set(workspaceId, filtered)

  if (result === 'denied') {
    logger.warn('access denied', {
      userId,
      action,
      resourceType,
      reason: denialReason,
    })
  }

  return entry
}

/**
 * Get audit log for workspace.
 */
export function getAuditLog(
  workspaceId: string,
  days: number = 30,
  limit: number = 100
): AuditLogEntry[] {
  const list = auditLog.get(workspaceId) || []
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  return list
    .filter((e) => e.timestamp >= cutoff)
    .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
    .slice(0, limit)
}

/**
 * Get audit log for specific resource.
 */
export function getResourceAuditLog(
  workspaceId: string,
  resourceType: string,
  resourceId: string
): AuditLogEntry[] {
  const list = auditLog.get(workspaceId) || []

  return list
    .filter((e) => e.resourceType === resourceType && e.resourceId === resourceId)
    .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
}

/**
 * Initialize default roles.
 */
export function initializeDefaultRoles(): void {
  const adminRole = createRole(
    'Admin',
    'Full platform access',
    [
      'view_costs',
      'export_costs',
      'manage_budgets',
      'approve_optimizations',
      'manage_policies',
      'manage_users',
      'manage_roles',
      'view_audit_log',
      'manage_webhooks',
      'view_forecasts',
      'approve_budget_requests',
      'manage_rate_limits',
      'disable_features',
    ],
    'cfo',
    'org_wide',
    0 // unlimited
  )

  const cfoRole = createRole(
    'CFO',
    'Executive financial oversight',
    [
      'view_costs',
      'export_costs',
      'manage_budgets',
      'approve_optimizations',
      'manage_policies',
      'view_audit_log',
      'view_forecasts',
      'approve_budget_requests',
    ],
    'cfo',
    'org_wide',
    0 // unlimited
  )

  const directorRole = createRole(
    'Director',
    'Department-level cost management',
    [
      'view_costs',
      'export_costs',
      'manage_budgets',
      'approve_optimizations',
      'view_audit_log',
      'view_forecasts',
      'approve_budget_requests',
    ],
    'director',
    'department',
    10000 // $10K
  )

  const managerRole = createRole(
    'Manager',
    'Team-level cost management',
    ['view_costs', 'export_costs', 'manage_budgets', 'view_forecasts', 'approve_budget_requests'],
    'manager',
    'team',
    1000 // $1K
  )

  const developerRole = createRole(
    'Developer',
    'View own team costs',
    ['view_costs', 'view_forecasts'],
    'none',
    'team',
    0
  )

  const analyticsRole = createRole(
    'Analyst',
    'Cost analysis and reporting',
    ['view_costs', 'export_costs', 'view_forecasts', 'view_audit_log'],
    'none',
    'org_wide',
    0
  )

  defaultRoles.set(adminRole.id, adminRole)
  defaultRoles.set(cfoRole.id, cfoRole)
  defaultRoles.set(directorRole.id, directorRole)
  defaultRoles.set(managerRole.id, managerRole)
  defaultRoles.set(developerRole.id, developerRole)
  defaultRoles.set(analyticsRole.id, analyticsRole)

  logger.info('default roles initialized', { count: 6 })
}

/**
 * Clear RBAC data (for testing).
 */
export function clearRBAC(): void {
  roles.clear()
  userRoles.clear()
  costVisibilityRules.clear()
  auditLog.clear()
  defaultRoles.clear()
}
