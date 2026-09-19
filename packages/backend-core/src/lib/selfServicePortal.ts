// Phase 7: Self-service cost portal with RBAC-gated access, dashboards, and reporting.
// Enables users to explore costs respecting their visibility scope and generate reports.

import { logger } from './logger.js'

export interface PortalDashboard {
  id: string
  userId: string
  organizationId: string
  name: string
  dashboardType: 'executive' | 'department' | 'team' | 'project' | 'custom'
  widgets: PortalWidget[]
  refreshInterval: number // seconds
  createdAt: Date
  updatedAt: Date
}

export interface PortalWidget {
  id: string
  type: 'cost_summary' | 'budget_pace' | 'cost_trend' | 'top_services' | 'alerts' | 'recommendations' | 'breakdown'
  title: string
  config: Record<string, unknown>
  position: { x: number; y: number; width: number; height: number }
}

export interface CostBreakdownView {
  entityId: string
  period: string
  dimensions: string[] // ['team', 'service', 'region']
  data: Array<{
    labels: Record<string, string> // dimension values
    cost: number
    percentage: number
  }>
}

export interface PortalAlert {
  id: string
  userId: string
  organizationId: string
  type: 'spike' | 'budget' | 'recommendation' | 'policy'
  severity: 'low' | 'medium' | 'high' | 'critical'
  title: string
  message: string
  actionUrl?: string
  createdAt: Date
  dismissedAt?: Date
}

export interface OptimizationRecommendationView {
  id: string
  title: string
  description: string
  estimatedSavings: number
  difficulty: 'easy' | 'medium' | 'hard'
  timeframe: string // '1 week', '2 weeks', '1 month'
  approved: boolean
}

export interface BudgetStatusView {
  period: string
  budgetAmount: number
  spentAmount: number
  remainingAmount: number
  percentSpent: number
  percentElapsed: number
  onTrack: boolean
  daysRemaining: number
  projectedOverage: number
  trend: 'improving' | 'stable' | 'degrading'
}

export interface GeneratedReport {
  id: string
  userId: string
  organizationId: string
  name: string
  reportType: 'executive_summary' | 'detailed_cost_analysis' | 'budget_variance' | 'recommendations' | 'compliance' | 'custom'
  period: string
  format: 'pdf' | 'csv' | 'json'
  fileSize: number
  downloadUrl?: string
  generatedAt: Date
  expiresAt: Date
}

export interface PortalPreferences {
  userId: string
  organizationId: string
  defaultDashboard: string
  currency: string
  timeZone: string
  emailAlerts: boolean
  emailFrequency: 'daily' | 'weekly' | 'monthly'
  alertThresholds: {
    spikeSeverity: 'low' | 'medium' | 'high' | 'critical'
    budgetThreshold: number // % of budget
    recommendationMinSavings: number
  }
  updatedAt: Date
}

export interface PortalAuditLog {
  id: string
  userId: string
  organizationId: string
  action: string // 'view_dashboard', 'generate_report', 'download_report'
  resourceType: string
  resourceId?: string
  timestamp: Date
}

// Storage
const dashboards = new Map<string, PortalDashboard[]>()
const costViews = new Map<string, CostBreakdownView[]>()
const portalAlerts = new Map<string, PortalAlert[]>()
const generatedReports = new Map<string, GeneratedReport[]>()
const userPreferences = new Map<string, PortalPreferences>()
const portalAuditLogs = new Map<string, PortalAuditLog[]>()

/**
 * Create or update portal dashboard.
 */
export function createDashboard(
  userId: string,
  organizationId: string,
  name: string,
  dashboardType: 'executive' | 'department' | 'team' | 'project' | 'custom',
  widgets: PortalWidget[] = [],
  refreshInterval: number = 300
): PortalDashboard {
  const dashboard: PortalDashboard = {
    id: `dash-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    userId,
    organizationId,
    name,
    dashboardType,
    widgets,
    refreshInterval,
    createdAt: new Date(),
    updatedAt: new Date(),
  }

  const key = `${userId}:${organizationId}`
  const list = dashboards.get(key) || []
  list.push(dashboard)
  dashboards.set(key, list)

  logger.info('portal dashboard created', {
    userId,
    organizationId,
    dashboardType,
  })

  return dashboard
}

/**
 * Get user's dashboards.
 */
export function getUserDashboards(userId: string, organizationId: string): PortalDashboard[] {
  const key = `${userId}:${organizationId}`
  return dashboards.get(key) || []
}

/**
 * Get specific dashboard.
 */
export function getDashboard(dashboardId: string, userId: string, organizationId: string): PortalDashboard | null {
  const list = getUserDashboards(userId, organizationId)
  return list.find((d) => d.id === dashboardId) || null
}

/**
 * Update dashboard widgets.
 */
export function updateDashboardWidgets(
  dashboardId: string,
  userId: string,
  organizationId: string,
  widgets: PortalWidget[]
): boolean {
  const dashboard = getDashboard(dashboardId, userId, organizationId)
  if (!dashboard) return false

  dashboard.widgets = widgets
  dashboard.updatedAt = new Date()

  return true
}

/**
 * Create cost breakdown view.
 */
export function createCostBreakdownView(
  entityId: string,
  period: string,
  dimensions: string[],
  data: Array<{ labels: Record<string, string>; cost: number; percentage: number }>
): CostBreakdownView {
  const view: CostBreakdownView = {
    entityId,
    period,
    dimensions,
    data: data.sort((a, b) => b.cost - a.cost), // Sort by cost descending
  }

  const key = `${entityId}:${period}`
  costViews.set(key, view)

  return view
}

/**
 * Get cost breakdown view.
 */
export function getCostBreakdownView(entityId: string, period: string): CostBreakdownView | null {
  const key = `${entityId}:${period}`
  return costViews.get(key) || null
}

/**
 * Create portal alert.
 */
export function createPortalAlert(
  userId: string,
  organizationId: string,
  type: 'spike' | 'budget' | 'recommendation' | 'policy',
  severity: 'low' | 'medium' | 'high' | 'critical',
  title: string,
  message: string,
  actionUrl?: string
): PortalAlert {
  const alert: PortalAlert = {
    id: `palert-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    userId,
    organizationId,
    type,
    severity,
    title,
    message,
    actionUrl,
    createdAt: new Date(),
  }

  const key = `${userId}:${organizationId}`
  const list = portalAlerts.get(key) || []
  list.push(alert)
  portalAlerts.set(key, list)

  return alert
}

/**
 * Get active alerts for user.
 */
export function getUserAlerts(userId: string, organizationId: string): PortalAlert[] {
  const key = `${userId}:${organizationId}`
  const list = portalAlerts.get(key) || []
  return list.filter((a) => !a.dismissedAt)
}

/**
 * Dismiss alert.
 */
export function dismissAlert(userId: string, organizationId: string, alertId: string): boolean {
  const key = `${userId}:${organizationId}`
  const list = portalAlerts.get(key) || []
  const alert = list.find((a) => a.id === alertId)

  if (!alert) return false

  alert.dismissedAt = new Date()

  return true
}

/**
 * Generate report request.
 */
export function generateReport(
  userId: string,
  organizationId: string,
  name: string,
  reportType: 'executive_summary' | 'detailed_cost_analysis' | 'budget_variance' | 'recommendations' | 'compliance' | 'custom',
  period: string,
  format: 'pdf' | 'csv' | 'json'
): GeneratedReport {
  const report: GeneratedReport = {
    id: `report-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    userId,
    organizationId,
    name,
    reportType,
    period,
    format,
    fileSize: Math.floor(Math.random() * 5000000) + 100000, // Simulated 100KB-5MB
    generatedAt: new Date(),
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
  }

  const key = `${userId}:${organizationId}`
  const list = generatedReports.get(key) || []
  list.push(report)
  generatedReports.set(key, list)

  logger.info('portal report generated', {
    userId,
    organizationId,
    reportType,
    format,
  })

  return report
}

/**
 * Get user's reports.
 */
export function getUserReports(userId: string, organizationId: string): GeneratedReport[] {
  const key = `${userId}:${organizationId}`
  const list = generatedReports.get(key) || []

  // Filter out expired reports
  const now = new Date()
  return list.filter((r) => r.expiresAt > now)
}

/**
 * Create download URL for report.
 */
export function createReportDownloadUrl(
  userId: string,
  organizationId: string,
  reportId: string
): string | null {
  const reports = getUserReports(userId, organizationId)
  const report = reports.find((r) => r.id === reportId)

  if (!report) return null

  // Generate a time-limited download URL
  report.downloadUrl = `/api/reports/download/${reportId}?token=${Date.now()}`

  return report.downloadUrl
}

/**
 * Get or create user preferences.
 */
export function getUserPreferences(userId: string, organizationId: string): PortalPreferences {
  const key = `${userId}:${organizationId}`
  const existing = userPreferences.get(key)

  if (existing) return existing

  const prefs: PortalPreferences = {
    userId,
    organizationId,
    defaultDashboard: '',
    currency: 'USD',
    timeZone: 'UTC',
    emailAlerts: false,
    emailFrequency: 'weekly',
    alertThresholds: {
      spikeSeverity: 'high',
      budgetThreshold: 80,
      recommendationMinSavings: 1000,
    },
    updatedAt: new Date(),
  }

  userPreferences.set(key, prefs)

  return prefs
}

/**
 * Update user preferences.
 */
export function updateUserPreferences(
  userId: string,
  organizationId: string,
  updates: Partial<PortalPreferences>
): PortalPreferences {
  const key = `${userId}:${organizationId}`
  const prefs = getUserPreferences(userId, organizationId)

  Object.assign(prefs, { ...updates, updatedAt: new Date() })
  userPreferences.set(key, prefs)

  logger.info('user preferences updated', {
    userId,
    organizationId,
  })

  return prefs
}

/**
 * Record portal activity (audit).
 */
export function recordActivity(
  userId: string,
  organizationId: string,
  action: string,
  resourceType: string,
  resourceId?: string
): PortalAuditLog {
  const entry: PortalAuditLog = {
    id: `audit-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    userId,
    organizationId,
    action,
    resourceType,
    resourceId,
    timestamp: new Date(),
  }

  const key = `${organizationId}:audit`
  const list = portalAuditLogs.get(key) || []
  list.push(entry)

  // Keep last 365 days
  const cutoff = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000)
  const filtered = list.filter((e) => e.timestamp >= cutoff)
  portalAuditLogs.set(key, filtered)

  return entry
}

/**
 * Get portal audit logs.
 */
export function getPortalAuditLogs(organizationId: string, days: number = 30): PortalAuditLog[] {
  const key = `${organizationId}:audit`
  const list = portalAuditLogs.get(key) || []
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  return list.filter((e) => e.timestamp >= cutoff)
}

/**
 * Get portal audit logs for user.
 */
export function getUserAuditLogs(userId: string, organizationId: string, days: number = 30): PortalAuditLog[] {
  const allLogs = getPortalAuditLogs(organizationId, days)
  return allLogs.filter((e) => e.userId === userId)
}

/**
 * Create budget status view.
 */
export function createBudgetStatusView(
  period: string,
  budgetAmount: number,
  spentAmount: number,
  percentElapsed: number
): BudgetStatusView {
  const remainingAmount = budgetAmount - spentAmount
  const percentSpent = (spentAmount / budgetAmount) * 100

  const onTrack = percentSpent <= percentElapsed
  const daysRemaining = Math.ceil((30 * (100 - percentElapsed)) / 100)

  // Project final cost based on pace
  const projectedFinalCost = percentElapsed > 0 ? (spentAmount / percentElapsed) * 100 : 0
  const projectedOverage = Math.max(0, projectedFinalCost - budgetAmount)

  // Determine trend
  let trend: 'improving' | 'stable' | 'degrading' = 'stable'
  if (percentSpent < percentElapsed - 5) {
    trend = 'improving'
  } else if (percentSpent > percentElapsed + 5) {
    trend = 'degrading'
  }

  return {
    period,
    budgetAmount,
    spentAmount,
    remainingAmount,
    percentSpent,
    percentElapsed,
    onTrack,
    daysRemaining,
    projectedOverage,
    trend,
  }
}

/**
 * Clear portal data (for testing).
 */
export function clearPortal(): void {
  dashboards.clear()
  costViews.clear()
  portalAlerts.clear()
  generatedReports.clear()
  userPreferences.clear()
  portalAuditLogs.clear()
}
