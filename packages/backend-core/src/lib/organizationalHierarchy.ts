// Phase 6: Organizational hierarchy with multi-level budget delegation and cost rollup.
// Enables company-wide structure with department/team scoping and automatic budget aggregation.

import { logger } from './logger.js'

export interface Organization {
  id: string
  name: string
  description?: string
  totalBudget: number // $
  createdAt: Date
  updatedAt: Date
}

export interface Department {
  id: string
  organizationId: string
  name: string
  description?: string
  parentDepartmentId?: string // for nested departments
  managerId: string // userId
  budget: number // $ allocated to this department
  createdAt: Date
  updatedAt: Date
}

export interface Team {
  id: string
  organizationId: string
  departmentId: string
  name: string
  description?: string
  leadId: string // userId
  budget: number // $ allocated to this team
  memberIds: string[]
  createdAt: Date
  updatedAt: Date
}

export interface HierarchicalBudget {
  organizationId: string
  departmentId?: string
  teamId?: string
  userId?: string
  allocatedBudget: number // $ allocated
  spentBudget: number // $ spent
  remainingBudget: number // allocated - spent
  lastUpdated: Date
}

export interface BudgetDelegation {
  id: string
  organizationId: string
  fromUserId: string // manager/director approving
  toUserId: string // recipient
  departmentId?: string
  teamId?: string
  budgetAmount: number // $ delegated
  approvalStatus: 'pending' | 'approved' | 'rejected'
  delegatedAt: Date
  expiresAt?: Date // optional expiration
}

export interface HierarchicalCostView {
  organizationId: string
  level: 'organization' | 'department' | 'team' | 'user'
  entityId: string
  totalCost: number
  breakdown: Record<string, number> // by department/team/cost-type
  trend: number // % change from prior period
  costPerUnit?: number // normalized cost metric
}

// Storage
const organizations = new Map<string, Organization>()
const departments = new Map<string, Department>()
const teams = new Map<string, Team>()
const hierarchicalBudgets = new Map<string, HierarchicalBudget>()
const budgetDelegations = new Map<string, BudgetDelegation[]>()
const costViews = new Map<string, HierarchicalCostView>()

/**
 * Create organization.
 */
export function createOrganization(
  name: string,
  description: string,
  totalBudget: number
): Organization {
  const org: Organization = {
    id: `org-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name,
    description,
    totalBudget,
    createdAt: new Date(),
    updatedAt: new Date(),
  }

  organizations.set(org.id, org)

  logger.info('organization created', {
    organizationId: org.id,
    name,
    totalBudget,
  })

  return org
}

/**
 * Get organization by ID.
 */
export function getOrganization(organizationId: string): Organization | null {
  return organizations.get(organizationId) || null
}

/**
 * Update organization budget.
 */
export function updateOrganizationBudget(organizationId: string, newBudget: number): boolean {
  const org = organizations.get(organizationId)
  if (!org) return false

  org.totalBudget = newBudget
  org.updatedAt = new Date()

  logger.info('organization budget updated', {
    organizationId,
    newBudget,
  })

  return true
}

/**
 * Create department.
 */
export function createDepartment(
  organizationId: string,
  name: string,
  description: string,
  managerId: string,
  budget: number,
  parentDepartmentId?: string
): Department {
  const dept: Department = {
    id: `dept-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    organizationId,
    name,
    description,
    parentDepartmentId,
    managerId,
    budget,
    createdAt: new Date(),
    updatedAt: new Date(),
  }

  departments.set(dept.id, dept)

  logger.info('department created', {
    departmentId: dept.id,
    organizationId,
    name,
    managerId,
    budget,
    parentDepartmentId,
  })

  return dept
}

/**
 * Get department by ID.
 */
export function getDepartment(departmentId: string): Department | null {
  return departments.get(departmentId) || null
}

/**
 * Get all departments for organization.
 */
export function getOrganizationDepartments(organizationId: string): Department[] {
  return Array.from(departments.values()).filter((d) => d.organizationId === organizationId)
}

/**
 * Get subdepartments (direct children only).
 */
export function getSubdepartments(parentDepartmentId: string): Department[] {
  return Array.from(departments.values()).filter((d) => d.parentDepartmentId === parentDepartmentId)
}

/**
 * Create team.
 */
export function createTeam(
  organizationId: string,
  departmentId: string,
  name: string,
  description: string,
  leadId: string,
  budget: number,
  memberIds: string[] = []
): Team {
  const team: Team = {
    id: `team-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    organizationId,
    departmentId,
    name,
    description,
    leadId,
    budget,
    memberIds,
    createdAt: new Date(),
    updatedAt: new Date(),
  }

  teams.set(team.id, team)

  logger.info('team created', {
    teamId: team.id,
    departmentId,
    organizationId,
    name,
    leadId,
    budget,
    memberCount: memberIds.length,
  })

  return team
}

/**
 * Get team by ID.
 */
export function getTeam(teamId: string): Team | null {
  return teams.get(teamId) || null
}

/**
 * Get all teams for department.
 */
export function getDepartmentTeams(departmentId: string): Team[] {
  return Array.from(teams.values()).filter((t) => t.departmentId === departmentId)
}

/**
 * Add member to team.
 */
export function addTeamMember(teamId: string, userId: string): boolean {
  const team = teams.get(teamId)
  if (!team) return false

  if (!team.memberIds.includes(userId)) {
    team.memberIds.push(userId)
    team.updatedAt = new Date()

    logger.info('team member added', {
      teamId,
      userId,
    })
  }

  return true
}

/**
 * Remove member from team.
 */
export function removeTeamMember(teamId: string, userId: string): boolean {
  const team = teams.get(teamId)
  if (!team) return false

  const index = team.memberIds.indexOf(userId)
  if (index >= 0) {
    team.memberIds.splice(index, 1)
    team.updatedAt = new Date()

    logger.info('team member removed', {
      teamId,
      userId,
    })
  }

  return true
}

/**
 * Set hierarchical budget allocation.
 */
export function setHierarchicalBudget(
  organizationId: string,
  spentBudget: number,
  departmentId?: string,
  teamId?: string,
  userId?: string
): HierarchicalBudget {
  const key = [organizationId, departmentId, teamId, userId].filter(Boolean).join(':')

  // Calculate allocated budget based on hierarchy
  let allocatedBudget = 0
  if (!departmentId) {
    // Organization level
    const org = getOrganization(organizationId)
    allocatedBudget = org?.totalBudget || 0
  } else if (!teamId) {
    // Department level
    const dept = getDepartment(departmentId)
    allocatedBudget = dept?.budget || 0
  } else if (!userId) {
    // Team level
    const team = getTeam(teamId)
    allocatedBudget = team?.budget || 0
  }

  const budget: HierarchicalBudget = {
    organizationId,
    departmentId,
    teamId,
    userId,
    allocatedBudget,
    spentBudget,
    remainingBudget: allocatedBudget - spentBudget,
    lastUpdated: new Date(),
  }

  hierarchicalBudgets.set(key, budget)

  return budget
}

/**
 * Get hierarchical budget.
 */
export function getHierarchicalBudget(
  organizationId: string,
  departmentId?: string,
  teamId?: string,
  userId?: string
): HierarchicalBudget | null {
  const key = [organizationId, departmentId, teamId, userId].filter(Boolean).join(':')
  return hierarchicalBudgets.get(key) || null
}

/**
 * Calculate budget rollup for organization.
 */
export function calculateOrganizationBudgetRollup(organizationId: string): {
  totalAllocated: number
  totalSpent: number
  totalRemaining: number
  departmentBreakdown: Record<string, { allocated: number; spent: number; remaining: number }>
} {
  const depts = getOrganizationDepartments(organizationId)
  const breakdown: Record<string, { allocated: number; spent: number; remaining: number }> = {}

  let totalAllocated = 0
  let totalSpent = 0

  for (const dept of depts) {
    const budget = getHierarchicalBudget(organizationId, dept.id)
    const allocated = budget?.allocatedBudget || 0
    const spent = budget?.spentBudget || 0

    breakdown[dept.id] = {
      allocated,
      spent,
      remaining: allocated - spent,
    }

    totalAllocated += allocated
    totalSpent += spent
  }

  return {
    totalAllocated,
    totalSpent,
    totalRemaining: totalAllocated - totalSpent,
    departmentBreakdown: breakdown,
  }
}

/**
 * Calculate budget rollup for department.
 */
export function calculateDepartmentBudgetRollup(departmentId: string): {
  totalAllocated: number
  totalSpent: number
  totalRemaining: number
  teamBreakdown: Record<string, { allocated: number; spent: number; remaining: number }>
} {
  const dept = getDepartment(departmentId)
  if (!dept) {
    return { totalAllocated: 0, totalSpent: 0, totalRemaining: 0, teamBreakdown: {} }
  }

  const teamList = getDepartmentTeams(departmentId)
  const breakdown: Record<string, { allocated: number; spent: number; remaining: number }> = {}

  let totalAllocated = 0
  let totalSpent = 0

  for (const team of teamList) {
    const budget = getHierarchicalBudget(dept.organizationId, departmentId, team.id)
    const allocated = budget?.allocatedBudget || 0
    const spent = budget?.spentBudget || 0

    breakdown[team.id] = {
      allocated,
      spent,
      remaining: allocated - spent,
    }

    totalAllocated += allocated
    totalSpent += spent
  }

  return {
    totalAllocated,
    totalSpent,
    totalRemaining: totalAllocated - totalSpent,
    teamBreakdown: breakdown,
  }
}

/**
 * Delegate budget to user/team.
 */
export function delegateBudget(
  organizationId: string,
  fromUserId: string,
  toUserId: string,
  budgetAmount: number,
  departmentId?: string,
  teamId?: string,
  expiresAt?: Date
): BudgetDelegation {
  const delegation: BudgetDelegation = {
    id: `deleg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    organizationId,
    fromUserId,
    toUserId,
    departmentId,
    teamId,
    budgetAmount,
    approvalStatus: 'pending',
    delegatedAt: new Date(),
    expiresAt,
  }

  const list = budgetDelegations.get(organizationId) || []
  list.push(delegation)
  budgetDelegations.set(organizationId, list)

  logger.info('budget delegation created', {
    delegationId: delegation.id,
    organizationId,
    fromUserId,
    toUserId,
    budgetAmount,
    departmentId,
    teamId,
  })

  return delegation
}

/**
 * Approve budget delegation.
 */
export function approveBudgetDelegation(organizationId: string, delegationId: string): boolean {
  const list = budgetDelegations.get(organizationId) || []
  const delegation = list.find((d) => d.id === delegationId)

  if (!delegation) return false

  delegation.approvalStatus = 'approved'

  logger.info('budget delegation approved', {
    organizationId,
    delegationId,
  })

  return true
}

/**
 * Reject budget delegation.
 */
export function rejectBudgetDelegation(organizationId: string, delegationId: string): boolean {
  const list = budgetDelegations.get(organizationId) || []
  const delegation = list.find((d) => d.id === delegationId)

  if (!delegation) return false

  delegation.approvalStatus = 'rejected'

  logger.info('budget delegation rejected', {
    organizationId,
    delegationId,
  })

  return true
}

/**
 * Get pending delegations for organization.
 */
export function getPendingDelegations(organizationId: string): BudgetDelegation[] {
  const list = budgetDelegations.get(organizationId) || []
  return list.filter((d) => d.approvalStatus === 'pending')
}

/**
 * Create hierarchical cost view.
 */
export function createCostView(
  organizationId: string,
  level: 'organization' | 'department' | 'team' | 'user',
  entityId: string,
  totalCost: number,
  breakdown: Record<string, number>,
  trend: number,
  costPerUnit?: number
): HierarchicalCostView {
  const view: HierarchicalCostView = {
    organizationId,
    level,
    entityId,
    totalCost,
    breakdown,
    trend,
    costPerUnit,
  }

  const key = `${organizationId}:${level}:${entityId}`
  costViews.set(key, view)

  return view
}

/**
 * Get cost view.
 */
export function getCostView(
  organizationId: string,
  level: 'organization' | 'department' | 'team' | 'user',
  entityId: string
): HierarchicalCostView | null {
  const key = `${organizationId}:${level}:${entityId}`
  return costViews.get(key) || null
}

/**
 * Get organization-wide cost view.
 */
export function getOrganizationCostView(organizationId: string): HierarchicalCostView | null {
  return getCostView(organizationId, 'organization', organizationId)
}

/**
 * Get all department cost views.
 */
export function getDepartmentCostViews(organizationId: string): HierarchicalCostView[] {
  return Array.from(costViews.values()).filter(
    (v) => v.organizationId === organizationId && v.level === 'department'
  )
}

/**
 * Clear organization hierarchy data (for testing).
 */
export function clearOrganizationHierarchy(): void {
  organizations.clear()
  departments.clear()
  teams.clear()
  hierarchicalBudgets.clear()
  budgetDelegations.clear()
  costViews.clear()
}
