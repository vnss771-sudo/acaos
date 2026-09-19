import { Router, Request, Response } from 'express'
import { requireAuth } from '../../middleware/auth.js'
import {
  createRole, getRole, assignUserRole, getUserRole, hasPermission, canApproveAmount,
  getCostVisibilityScope, setCostVisibilityRule, logAuditEntry, getAuditLog, getResourceAuditLog,
  initializeDefaultRoles, clearRBAC,
} from '@acaos/backend-core/lib/rbac.js'
import {
  createOrganization, getOrganization, updateOrganizationBudget, createDepartment, getDepartment,
  getOrganizationDepartments, getSubdepartments, createTeam, getTeam, getDepartmentTeams,
  addTeamMember, removeTeamMember, setHierarchicalBudget, getHierarchicalBudget,
  calculateOrganizationBudgetRollup, calculateDepartmentBudgetRollup, delegateBudget,
  approveBudgetDelegation, rejectBudgetDelegation, getPendingDelegations, createCostView,
  getCostView, getOrganizationCostView, getDepartmentCostViews, clearOrganizationHierarchy,
} from '@acaos/backend-core/lib/organizationalHierarchy.js'
import {
  createPolicy, getPolicy, getWorkspacePolicies, updatePolicy, enablePolicy, disablePolicy,
  deletePolicy, enforcePolicies, getEnforcementHistory, recordAuditTrail, getPolicyAuditTrail,
  generateComplianceReport, getComplianceReports, clearGovernance,
} from '@acaos/backend-core/lib/governanceEngine.js'
import {
  recordCostMetric, getEntityMetrics, setPerformanceKPI, getOrganizationKPIs, createBenchmark,
  getOrganizationBenchmarks, trackCostTrend, getCostTrend, createCostBreakdown, getCostBreakdown,
  calculateCostPerSeat, calculateCostPerTransaction, calculateCostPerUnit, getAnalyticsSummary,
  clearAnalytics,
} from '@acaos/backend-core/lib/organizationalAnalytics.js'

export const phase6GovernanceRouter = Router()

// ============================================================================
// RBAC ENDPOINTS
// ============================================================================

// Roles
phase6GovernanceRouter.post('/roles', requireAuth, (req: Request, res: Response) => {
  const { name, description, permissions, approvalAuthority, costVisibilityScope, maxApprovalAmount } = req.body
  const role = createRole(name, description, permissions, approvalAuthority, costVisibilityScope, maxApprovalAmount)
  res.json(role)
})

phase6GovernanceRouter.get('/roles/:roleId', requireAuth, (req: Request, res: Response) => {
  const role = getRole(req.params.roleId)
  res.json(role || { error: 'Role not found' })
})

// User Roles
phase6GovernanceRouter.post('/user-roles', requireAuth, (req: Request, res: Response) => {
  const { workspaceId, userId, roleId, departmentId, teamId } = req.body
  const userRole = assignUserRole(workspaceId, userId, roleId, departmentId, teamId)
  res.json(userRole)
})

phase6GovernanceRouter.get('/user-roles/:userId/:workspaceId', requireAuth, (req: Request, res: Response) => {
  const userRole = getUserRole(req.params.workspaceId, req.params.userId)
  res.json(userRole || { error: 'User role not found' })
})

// Permission Checking
phase6GovernanceRouter.post('/check-permission', requireAuth, (req: Request, res: Response) => {
  const { workspaceId, userId, permission } = req.body
  const allowed = hasPermission(workspaceId, userId, permission)
  res.json({ allowed })
})

// Approval Authority
phase6GovernanceRouter.post('/check-approval', requireAuth, (req: Request, res: Response) => {
  const { workspaceId, userId, amount } = req.body
  const canApprove = canApproveAmount(workspaceId, userId, amount)
  res.json({ canApprove })
})

// Cost Visibility
phase6GovernanceRouter.get('/cost-visibility/:userId/:workspaceId', requireAuth, (req: Request, res: Response) => {
  const scope = getCostVisibilityScope(req.params.workspaceId, req.params.userId)
  res.json({ scope })
})

phase6GovernanceRouter.post('/cost-visibility-rule', requireAuth, (req: Request, res: Response) => {
  const { workspaceId, userId, scope, visibleDepartments, visibleTeams } = req.body
  const rule = setCostVisibilityRule(workspaceId, userId, scope, visibleDepartments, visibleTeams)
  res.json(rule)
})

// Audit Log
phase6GovernanceRouter.post('/audit-log', requireAuth, (req: Request, res: Response) => {
  const { workspaceId, userId, action, resourceType, resourceId, result, denialReason, changes } = req.body
  const entry = logAuditEntry(workspaceId, userId, action, resourceType, resourceId, result, denialReason, changes)
  res.json(entry)
})

phase6GovernanceRouter.get('/audit-log/:workspaceId', requireAuth, (req: Request, res: Response) => {
  const { days = 30, limit = 100 } = req.query
  const log = getAuditLog(req.params.workspaceId, Number(days), Number(limit))
  res.json(log)
})

phase6GovernanceRouter.get('/audit-log/:workspaceId/resource/:resourceType/:resourceId', requireAuth, (req: Request, res: Response) => {
  const log = getResourceAuditLog(req.params.workspaceId, req.params.resourceType, req.params.resourceId)
  res.json(log)
})

// Initialize default roles
phase6GovernanceRouter.post('/initialize-roles', requireAuth, (req: Request, res: Response) => {
  initializeDefaultRoles()
  res.json({ message: 'Default roles initialized' })
})

// ============================================================================
// ORGANIZATIONAL HIERARCHY ENDPOINTS
// ============================================================================

// Organization
phase6GovernanceRouter.post('/organizations', requireAuth, (req: Request, res: Response) => {
  const { name, description, totalBudget } = req.body
  const org = createOrganization(name, description, totalBudget)
  res.json(org)
})

phase6GovernanceRouter.get('/organizations/:organizationId', requireAuth, (req: Request, res: Response) => {
  const org = getOrganization(req.params.organizationId)
  res.json(org || { error: 'Organization not found' })
})

phase6GovernanceRouter.put('/organizations/:organizationId/budget', requireAuth, (req: Request, res: Response) => {
  const { newBudget } = req.body
  const success = updateOrganizationBudget(req.params.organizationId, newBudget)
  res.json({ success })
})

// Departments
phase6GovernanceRouter.post('/departments', requireAuth, (req: Request, res: Response) => {
  const { organizationId, name, description, managerId, budget, parentDepartmentId } = req.body
  const dept = createDepartment(organizationId, name, description, managerId, budget, parentDepartmentId)
  res.json(dept)
})

phase6GovernanceRouter.get('/departments/:departmentId', requireAuth, (req: Request, res: Response) => {
  const dept = getDepartment(req.params.departmentId)
  res.json(dept || { error: 'Department not found' })
})

phase6GovernanceRouter.get('/departments/organization/:organizationId', requireAuth, (req: Request, res: Response) => {
  const depts = getOrganizationDepartments(req.params.organizationId)
  res.json(depts)
})

phase6GovernanceRouter.get('/subdepartments/:parentDepartmentId', requireAuth, (req: Request, res: Response) => {
  const depts = getSubdepartments(req.params.parentDepartmentId)
  res.json(depts)
})

// Teams
phase6GovernanceRouter.post('/teams', requireAuth, (req: Request, res: Response) => {
  const { organizationId, departmentId, name, description, leadId, budget, memberIds } = req.body
  const team = createTeam(organizationId, departmentId, name, description, leadId, budget, memberIds)
  res.json(team)
})

phase6GovernanceRouter.get('/teams/:teamId', requireAuth, (req: Request, res: Response) => {
  const team = getTeam(req.params.teamId)
  res.json(team || { error: 'Team not found' })
})

phase6GovernanceRouter.get('/teams/department/:departmentId', requireAuth, (req: Request, res: Response) => {
  const teams = getDepartmentTeams(req.params.departmentId)
  res.json(teams)
})

phase6GovernanceRouter.post('/teams/:teamId/members/:userId', requireAuth, (req: Request, res: Response) => {
  const success = addTeamMember(req.params.teamId, req.params.userId)
  res.json({ success })
})

phase6GovernanceRouter.delete('/teams/:teamId/members/:userId', requireAuth, (req: Request, res: Response) => {
  const success = removeTeamMember(req.params.teamId, req.params.userId)
  res.json({ success })
})

// Budget Management
phase6GovernanceRouter.post('/hierarchical-budget', requireAuth, (req: Request, res: Response) => {
  const { organizationId, spentBudget, departmentId, teamId, userId } = req.body
  const budget = setHierarchicalBudget(organizationId, spentBudget, departmentId, teamId, userId)
  res.json(budget)
})

phase6GovernanceRouter.get('/hierarchical-budget/:organizationId', requireAuth, (req: Request, res: Response) => {
  const { departmentId, teamId, userId } = req.query
  const budget = getHierarchicalBudget(
    req.params.organizationId,
    departmentId as string,
    teamId as string,
    userId as string
  )
  res.json(budget || { error: 'Budget not found' })
})

phase6GovernanceRouter.get('/budget-rollup/organization/:organizationId', requireAuth, (req: Request, res: Response) => {
  const rollup = calculateOrganizationBudgetRollup(req.params.organizationId)
  res.json(rollup)
})

phase6GovernanceRouter.get('/budget-rollup/department/:departmentId', requireAuth, (req: Request, res: Response) => {
  const rollup = calculateDepartmentBudgetRollup(req.params.departmentId)
  res.json(rollup)
})

// Budget Delegation
phase6GovernanceRouter.post('/budget-delegation', requireAuth, (req: Request, res: Response) => {
  const { organizationId, fromUserId, toUserId, budgetAmount, departmentId, teamId, expiresAt } = req.body
  const delegation = delegateBudget(organizationId, fromUserId, toUserId, budgetAmount, departmentId, teamId, expiresAt)
  res.json(delegation)
})

phase6GovernanceRouter.post('/budget-delegation/:organizationId/:delegationId/approve', requireAuth, (req: Request, res: Response) => {
  const success = approveBudgetDelegation(req.params.organizationId, req.params.delegationId)
  res.json({ success })
})

phase6GovernanceRouter.post('/budget-delegation/:organizationId/:delegationId/reject', requireAuth, (req: Request, res: Response) => {
  const success = rejectBudgetDelegation(req.params.organizationId, req.params.delegationId)
  res.json({ success })
})

phase6GovernanceRouter.get('/budget-delegations/pending/:organizationId', requireAuth, (req: Request, res: Response) => {
  const delegations = getPendingDelegations(req.params.organizationId)
  res.json(delegations)
})

// Cost Views
phase6GovernanceRouter.post('/cost-views', requireAuth, (req: Request, res: Response) => {
  const { organizationId, level, entityId, totalCost, breakdown, trend, costPerUnit } = req.body
  const view = createCostView(organizationId, level, entityId, totalCost, breakdown, trend, costPerUnit)
  res.json(view)
})

phase6GovernanceRouter.get('/cost-views/:organizationId/:level/:entityId', requireAuth, (req: Request, res: Response) => {
  const view = getCostView(req.params.organizationId, req.params.level as any, req.params.entityId)
  res.json(view || { error: 'Cost view not found' })
})

phase6GovernanceRouter.get('/cost-views/organization/:organizationId', requireAuth, (req: Request, res: Response) => {
  const view = getOrganizationCostView(req.params.organizationId)
  res.json(view || { error: 'Cost view not found' })
})

phase6GovernanceRouter.get('/cost-views/departments/:organizationId', requireAuth, (req: Request, res: Response) => {
  const views = getDepartmentCostViews(req.params.organizationId)
  res.json(views)
})

// ============================================================================
// GOVERNANCE POLICY ENDPOINTS
// ============================================================================

// Policies
phase6GovernanceRouter.post('/policies', requireAuth, (req: Request, res: Response) => {
  const { workspaceId, name, description, type, scope, rules, entityId, priority } = req.body
  const policy = createPolicy(workspaceId, name, description, type, scope, rules, entityId, priority)
  res.json(policy)
})

phase6GovernanceRouter.get('/policies/:workspaceId/:policyId', requireAuth, (req: Request, res: Response) => {
  const policy = getPolicy(req.params.workspaceId, req.params.policyId)
  res.json(policy || { error: 'Policy not found' })
})

phase6GovernanceRouter.get('/policies/:workspaceId', requireAuth, (req: Request, res: Response) => {
  const { type } = req.query
  const policies = getWorkspacePolicies(req.params.workspaceId, type as any)
  res.json(policies)
})

phase6GovernanceRouter.put('/policies/:workspaceId/:policyId', requireAuth, (req: Request, res: Response) => {
  const success = updatePolicy(req.params.workspaceId, req.params.policyId, req.body)
  res.json({ success })
})

phase6GovernanceRouter.post('/policies/:workspaceId/:policyId/enable', requireAuth, (req: Request, res: Response) => {
  const success = enablePolicy(req.params.workspaceId, req.params.policyId)
  res.json({ success })
})

phase6GovernanceRouter.post('/policies/:workspaceId/:policyId/disable', requireAuth, (req: Request, res: Response) => {
  const success = disablePolicy(req.params.workspaceId, req.params.policyId)
  res.json({ success })
})

phase6GovernanceRouter.delete('/policies/:workspaceId/:policyId', requireAuth, (req: Request, res: Response) => {
  const success = deletePolicy(req.params.workspaceId, req.params.policyId)
  res.json({ success })
})

// Policy Enforcement
phase6GovernanceRouter.post('/enforce-policies', requireAuth, (req: Request, res: Response) => {
  const { workspaceId, entityId, entityData } = req.body
  const enforcement = enforcePolicies(workspaceId, entityId, entityData)
  res.json(enforcement)
})

phase6GovernanceRouter.get('/enforcement-history/:workspaceId/:entityId', requireAuth, (req: Request, res: Response) => {
  const { days = 30 } = req.query
  const history = getEnforcementHistory(req.params.workspaceId, req.params.entityId, Number(days))
  res.json(history)
})

// Policy Audit Trail
phase6GovernanceRouter.post('/policy-audit', requireAuth, (req: Request, res: Response) => {
  const { workspaceId, policyId, entityId, action, result, reason, metadata } = req.body
  const trail = recordAuditTrail(workspaceId, policyId, entityId, action, result, reason, metadata)
  res.json(trail)
})

phase6GovernanceRouter.get('/policy-audit/:workspaceId/:policyId', requireAuth, (req: Request, res: Response) => {
  const { days = 30 } = req.query
  const trail = getPolicyAuditTrail(req.params.workspaceId, req.params.policyId, Number(days))
  res.json(trail)
})

// Compliance Reports
phase6GovernanceRouter.post('/compliance-reports/:workspaceId', requireAuth, (req: Request, res: Response) => {
  const { period = 'weekly' } = req.body
  const report = generateComplianceReport(req.params.workspaceId, period)
  res.json(report)
})

phase6GovernanceRouter.get('/compliance-reports/:workspaceId', requireAuth, (req: Request, res: Response) => {
  const { days = 90, limit = 10 } = req.query
  const reports = getComplianceReports(req.params.workspaceId, Number(days), Number(limit))
  res.json(reports)
})

// ============================================================================
// ANALYTICS ENDPOINTS
// ============================================================================

// Cost Metrics
phase6GovernanceRouter.post('/cost-metrics', requireAuth, (req: Request, res: Response) => {
  const { entityId, entityType, period, totalCost, breakdown, trend } = req.body
  const metric = recordCostMetric(entityId, entityType, period, totalCost, breakdown, trend)
  res.json(metric)
})

phase6GovernanceRouter.get('/cost-metrics/:entityId/:entityType', requireAuth, (req: Request, res: Response) => {
  const { periods = 12 } = req.query
  const metrics = getEntityMetrics(req.params.entityId, req.params.entityType, Number(periods))
  res.json(metrics)
})

// KPIs
phase6GovernanceRouter.post('/kpis', requireAuth, (req: Request, res: Response) => {
  const { organizationId, name, description, metric, targetValue, actualValue, period } = req.body
  const kpi = setPerformanceKPI(organizationId, name, description, metric, targetValue, actualValue, period)
  res.json(kpi)
})

phase6GovernanceRouter.get('/kpis/:organizationId', requireAuth, (req: Request, res: Response) => {
  const kpis = getOrganizationKPIs(req.params.organizationId)
  res.json(kpis)
})

// Benchmarks
phase6GovernanceRouter.post('/benchmarks', requireAuth, (req: Request, res: Response) => {
  const { organizationId, name, benchmark, metric, benchmarkValue, actualValue } = req.body
  const bm = createBenchmark(organizationId, name, benchmark, metric, benchmarkValue, actualValue)
  res.json(bm)
})

phase6GovernanceRouter.get('/benchmarks/:organizationId', requireAuth, (req: Request, res: Response) => {
  const { benchmarkType } = req.query
  const benchmarks = getOrganizationBenchmarks(req.params.organizationId, benchmarkType as any)
  res.json(benchmarks)
})

// Cost Trends
phase6GovernanceRouter.post('/cost-trends', requireAuth, (req: Request, res: Response) => {
  const { entityId, entityType, metric, periods } = req.body
  const trend = trackCostTrend(entityId, entityType, metric, periods)
  res.json(trend)
})

phase6GovernanceRouter.get('/cost-trends/:entityId/:entityType/:metric', requireAuth, (req: Request, res: Response) => {
  const trend = getCostTrend(req.params.entityId, req.params.entityType, req.params.metric)
  res.json(trend || { error: 'Trend not found' })
})

// Cost Breakdowns
phase6GovernanceRouter.post('/cost-breakdowns', requireAuth, (req: Request, res: Response) => {
  const { entityId, period, byTeam, byProject, byResourceType, byCustomer, byRegion } = req.body
  const breakdown = createCostBreakdown(entityId, period, byTeam, byProject, byResourceType, byCustomer, byRegion)
  res.json(breakdown)
})

phase6GovernanceRouter.get('/cost-breakdowns/:entityId/:period', requireAuth, (req: Request, res: Response) => {
  const breakdown = getCostBreakdown(req.params.entityId, req.params.period)
  res.json(breakdown || { error: 'Breakdown not found' })
})

// KPI Calculations
phase6GovernanceRouter.post('/kpi/cost-per-seat', requireAuth, (req: Request, res: Response) => {
  const { totalCost, headcount } = req.body
  const costPerSeat = calculateCostPerSeat(totalCost, headcount)
  res.json({ costPerSeat })
})

phase6GovernanceRouter.post('/kpi/cost-per-transaction', requireAuth, (req: Request, res: Response) => {
  const { totalCost, transactionCount } = req.body
  const costPerTransaction = calculateCostPerTransaction(totalCost, transactionCount)
  res.json({ costPerTransaction })
})

phase6GovernanceRouter.post('/kpi/cost-per-unit', requireAuth, (req: Request, res: Response) => {
  const { totalCost, unitCount } = req.body
  const costPerUnit = calculateCostPerUnit(totalCost, unitCount)
  res.json({ costPerUnit })
})

// Analytics Summary
phase6GovernanceRouter.get('/analytics-summary/:organizationId', requireAuth, (req: Request, res: Response) => {
  const summary = getAnalyticsSummary(req.params.organizationId)
  res.json(summary)
})

// ============================================================================
// INITIALIZATION & TESTING
// ============================================================================

phase6GovernanceRouter.post('/initialize', requireAuth, (req: Request, res: Response) => {
  initializeDefaultRoles()
  res.json({ message: 'Phase 6 governance initialized' })
})

phase6GovernanceRouter.post('/clear-all', requireAuth, (req: Request, res: Response) => {
  clearRBAC()
  clearOrganizationHierarchy()
  clearGovernance()
  clearAnalytics()
  res.json({ message: 'All Phase 6 data cleared' })
})
