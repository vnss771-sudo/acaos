import { Router, Request, Response } from 'express'
import { requireAuth } from '../../middleware/auth.js'
import {
  recordCostDataPoint, getCostDataPoints, calculateCostBaseline, getCostBaseline, detectCostSpike,
  getActiveSpikes, resolveSpike, calculateBudgetPace, getBudgetPace, calculateCostChange,
  getCostChanges, updateLiveAggregate, getLiveAggregate, createAlert, getActiveAlerts,
  acknowledgeAlert, clearMonitoring,
} from '../../../backend-core/src/lib/costMonitoring.js'
import {
  createAllocationRule, getAllocationRules, updateAllocationRule, generateShowbackStatement,
  getShowbackStatements, generateChargebackStatement, getChargebackStatements, issueChargebackStatement,
  markChargebackPaid, recordChargebackAllocation, getChargebackAllocations, createInternalInvoice,
  getInternalInvoices, sendInvoice, recordPayment, generateChargeReconciliation, getChargeReconciliations,
  clearChargeback,
} from '../../../backend-core/src/lib/chargebackEngine.js'
import {
  createDashboard, getUserDashboards, getDashboard, updateDashboardWidgets, createCostBreakdownView,
  getCostBreakdownView, createPortalAlert, getUserAlerts, dismissAlert, generateReport, getUserReports,
  createReportDownloadUrl, getUserPreferences, updateUserPreferences, recordActivity, getPortalAuditLogs,
  getUserAuditLogs, createBudgetStatusView, clearPortal,
} from '../../../backend-core/src/lib/selfServicePortal.js'

export const phase7MonitoringRouter = Router()

// ============================================================================
// REAL-TIME COST MONITORING ENDPOINTS
// ============================================================================

// Cost Data
phase7MonitoringRouter.post('/cost-data', requireAuth, (req: Request, res: Response) => {
  const { organizationId, totalCost, breakdown } = req.body
  const dataPoint = recordCostDataPoint(organizationId, totalCost, breakdown)
  res.json(dataPoint)
})

phase7MonitoringRouter.get('/cost-data/:organizationId', requireAuth, (req: Request, res: Response) => {
  const { hours = 24 } = req.query
  const data = getCostDataPoints(req.params.organizationId, Number(hours))
  res.json(data)
})

// Cost Baselines
phase7MonitoringRouter.post('/baselines', requireAuth, (req: Request, res: Response) => {
  const { organizationId, metric, historicalDays } = req.body
  const baseline = calculateCostBaseline(organizationId, metric, historicalDays)
  res.json(baseline)
})

phase7MonitoringRouter.get('/baselines/:organizationId/:metric', requireAuth, (req: Request, res: Response) => {
  const baseline = getCostBaseline(req.params.organizationId, req.params.metric)
  res.json(baseline || { error: 'Baseline not found' })
})

// Cost Spikes
phase7MonitoringRouter.post('/detect-spike', requireAuth, (req: Request, res: Response) => {
  const { organizationId, currentCost, affectedServices } = req.body
  const spike = detectCostSpike(organizationId, currentCost, affectedServices)
  res.json(spike || { message: 'No spike detected' })
})

phase7MonitoringRouter.get('/spikes/:organizationId', requireAuth, (req: Request, res: Response) => {
  const spikes = getActiveSpikes(req.params.organizationId)
  res.json(spikes)
})

phase7MonitoringRouter.post('/spikes/:organizationId/:spikeId/resolve', requireAuth, (req: Request, res: Response) => {
  const success = resolveSpike(req.params.organizationId, req.params.spikeId)
  res.json({ success })
})

// Budget Pace
phase7MonitoringRouter.post('/budget-pace', requireAuth, (req: Request, res: Response) => {
  const { organizationId, budgetAmount, spentAmount, periodStartDate, periodEndDate, departmentId, teamId } = req.body
  const pace = calculateBudgetPace(
    organizationId,
    budgetAmount,
    spentAmount,
    new Date(periodStartDate),
    new Date(periodEndDate),
    departmentId,
    teamId
  )
  res.json(pace)
})

phase7MonitoringRouter.get('/budget-pace/:organizationId', requireAuth, (req: Request, res: Response) => {
  const { departmentId, teamId } = req.query
  const pace = getBudgetPace(req.params.organizationId, departmentId as string, teamId as string)
  res.json(pace || { error: 'Budget pace not found' })
})

// Cost Changes
phase7MonitoringRouter.post('/cost-changes', requireAuth, (req: Request, res: Response) => {
  const { organizationId, currentPeriodStart, currentPeriodEnd, previousPeriodDays } = req.body
  const change = calculateCostChange(
    organizationId,
    new Date(currentPeriodStart),
    new Date(currentPeriodEnd),
    previousPeriodDays
  )
  res.json(change)
})

phase7MonitoringRouter.get('/cost-changes/:organizationId', requireAuth, (req: Request, res: Response) => {
  const { days = 30 } = req.query
  const changes = getCostChanges(req.params.organizationId, Number(days))
  res.json(changes)
})

// Live Aggregates
phase7MonitoringRouter.post('/live-aggregate/:organizationId', requireAuth, (req: Request, res: Response) => {
  const aggregate = updateLiveAggregate(req.params.organizationId)
  res.json(aggregate)
})

phase7MonitoringRouter.get('/live-aggregate/:organizationId', requireAuth, (req: Request, res: Response) => {
  const aggregate = getLiveAggregate(req.params.organizationId)
  res.json(aggregate || { error: 'Live aggregate not found' })
})

// Alerts
phase7MonitoringRouter.post('/alerts', requireAuth, (req: Request, res: Response) => {
  const { organizationId, type, severity, message, affectedServices } = req.body
  const alert = createAlert(organizationId, type, severity, message)
  res.json(alert)
})

phase7MonitoringRouter.get('/alerts/:organizationId', requireAuth, (req: Request, res: Response) => {
  const alerts = getActiveAlerts(req.params.organizationId)
  res.json(alerts)
})

phase7MonitoringRouter.post('/alerts/:organizationId/:alertId/acknowledge', requireAuth, (req: Request, res: Response) => {
  const { userId } = req.body
  const success = acknowledgeAlert(req.params.organizationId, req.params.alertId, userId)
  res.json({ success })
})

// ============================================================================
// CHARGEBACK & INTERNAL BILLING ENDPOINTS
// ============================================================================

// Allocation Rules
phase7MonitoringRouter.post('/allocation-rules', requireAuth, (req: Request, res: Response) => {
  const { organizationId, name, costCenterId, allocation, markupFactor } = req.body
  const rule = createAllocationRule(organizationId, name, costCenterId, allocation, markupFactor)
  res.json(rule)
})

phase7MonitoringRouter.get('/allocation-rules/:organizationId', requireAuth, (req: Request, res: Response) => {
  const { enabled } = req.query
  const rules = getAllocationRules(req.params.organizationId, enabled === 'true')
  res.json(rules)
})

phase7MonitoringRouter.put('/allocation-rules/:organizationId/:ruleId', requireAuth, (req: Request, res: Response) => {
  const success = updateAllocationRule(req.params.organizationId, req.params.ruleId, req.body)
  res.json({ success })
})

// Showback Statements
phase7MonitoringRouter.post('/showback', requireAuth, (req: Request, res: Response) => {
  const { organizationId, departmentId, period, totalCost, breakdown, trend } = req.body
  const statement = generateShowbackStatement(organizationId, departmentId, period, totalCost, breakdown, trend)
  res.json(statement)
})

phase7MonitoringRouter.get('/showback/:organizationId', requireAuth, (req: Request, res: Response) => {
  const { departmentId, months = 12 } = req.query
  const statements = getShowbackStatements(req.params.organizationId, departmentId as string, Number(months))
  res.json(statements)
})

// Chargeback Statements
phase7MonitoringRouter.post('/chargeback', requireAuth, (req: Request, res: Response) => {
  const { organizationId, departmentId, period, baseCost, breakdown, markupFactor } = req.body
  const statement = generateChargebackStatement(organizationId, departmentId, period, baseCost, breakdown, markupFactor)
  res.json(statement)
})

phase7MonitoringRouter.get('/chargeback/:organizationId', requireAuth, (req: Request, res: Response) => {
  const { departmentId, status } = req.query
  const statements = getChargebackStatements(req.params.organizationId, departmentId as string, status as string)
  res.json(statements)
})

phase7MonitoringRouter.post('/chargeback/:organizationId/:statementId/issue', requireAuth, (req: Request, res: Response) => {
  const success = issueChargebackStatement(req.params.organizationId, req.params.statementId)
  res.json({ success })
})

phase7MonitoringRouter.post('/chargeback/:organizationId/:statementId/mark-paid', requireAuth, (req: Request, res: Response) => {
  const success = markChargebackPaid(req.params.organizationId, req.params.statementId)
  res.json({ success })
})

// Chargeback Allocations
phase7MonitoringRouter.post('/chargeback-allocation', requireAuth, (req: Request, res: Response) => {
  const { organizationId, costId, sourceDepartmentId, targetDepartmentId, allocationType, amount, allocationBasis } = req.body
  const allocation = recordChargebackAllocation(
    organizationId,
    costId,
    sourceDepartmentId,
    targetDepartmentId,
    allocationType,
    amount,
    allocationBasis
  )
  res.json(allocation)
})

phase7MonitoringRouter.get('/chargeback-allocation/:organizationId', requireAuth, (req: Request, res: Response) => {
  const { departmentId } = req.query
  const allocations = getChargebackAllocations(req.params.organizationId, departmentId as string)
  res.json(allocations)
})

// Internal Invoices
phase7MonitoringRouter.post('/invoices', requireAuth, (req: Request, res: Response) => {
  const { organizationId, departmentId, period, items, markupFactor } = req.body
  const invoice = createInternalInvoice(organizationId, departmentId, period, items, markupFactor)
  res.json(invoice)
})

phase7MonitoringRouter.get('/invoices/:organizationId', requireAuth, (req: Request, res: Response) => {
  const { departmentId, status } = req.query
  const invoices = getInternalInvoices(req.params.organizationId, departmentId as string, status as string)
  res.json(invoices)
})

phase7MonitoringRouter.post('/invoices/:organizationId/:invoiceId/send', requireAuth, (req: Request, res: Response) => {
  const success = sendInvoice(req.params.organizationId, req.params.invoiceId)
  res.json({ success })
})

phase7MonitoringRouter.post('/invoices/:organizationId/:invoiceId/payment', requireAuth, (req: Request, res: Response) => {
  const { paidAmount } = req.body
  const success = recordPayment(req.params.organizationId, req.params.invoiceId, paidAmount)
  res.json({ success })
})

// Charge Reconciliation
phase7MonitoringRouter.post('/reconciliation', requireAuth, (req: Request, res: Response) => {
  const { organizationId, period, departmentBudgets } = req.body
  const reconciliation = generateChargeReconciliation(organizationId, period, departmentBudgets)
  res.json(reconciliation)
})

phase7MonitoringRouter.get('/reconciliation/:organizationId', requireAuth, (req: Request, res: Response) => {
  const { months = 12 } = req.query
  const reconciliations = getChargeReconciliations(req.params.organizationId, Number(months))
  res.json(reconciliations)
})

// ============================================================================
// SELF-SERVICE PORTAL ENDPOINTS
// ============================================================================

// Dashboards
phase7MonitoringRouter.post('/dashboards', requireAuth, (req: Request, res: Response) => {
  const { userId, organizationId, name, dashboardType, widgets, refreshInterval } = req.body
  const dashboard = createDashboard(userId, organizationId, name, dashboardType, widgets, refreshInterval)
  res.json(dashboard)
})

phase7MonitoringRouter.get('/dashboards/:userId/:organizationId', requireAuth, (req: Request, res: Response) => {
  const dashboards = getUserDashboards(req.params.userId, req.params.organizationId)
  res.json(dashboards)
})

phase7MonitoringRouter.get('/dashboards/:userId/:organizationId/:dashboardId', requireAuth, (req: Request, res: Response) => {
  const dashboard = getDashboard(req.params.dashboardId, req.params.userId, req.params.organizationId)
  res.json(dashboard || { error: 'Dashboard not found' })
})

phase7MonitoringRouter.put('/dashboards/:userId/:organizationId/:dashboardId', requireAuth, (req: Request, res: Response) => {
  const { widgets } = req.body
  const success = updateDashboardWidgets(req.params.dashboardId, req.params.userId, req.params.organizationId, widgets)
  res.json({ success })
})

// Cost Breakdown Views
phase7MonitoringRouter.post('/cost-breakdown', requireAuth, (req: Request, res: Response) => {
  const { entityId, period, dimensions, data } = req.body
  const view = createCostBreakdownView(entityId, period, dimensions, data)
  res.json(view)
})

phase7MonitoringRouter.get('/cost-breakdown/:entityId/:period', requireAuth, (req: Request, res: Response) => {
  const view = getCostBreakdownView(req.params.entityId, req.params.period)
  res.json(view || { error: 'Cost breakdown not found' })
})

// Portal Alerts
phase7MonitoringRouter.post('/portal-alerts', requireAuth, (req: Request, res: Response) => {
  const { userId, organizationId, type, severity, title, message, actionUrl } = req.body
  const alert = createPortalAlert(userId, organizationId, type, severity, title, message, actionUrl)
  res.json(alert)
})

phase7MonitoringRouter.get('/portal-alerts/:userId/:organizationId', requireAuth, (req: Request, res: Response) => {
  const alerts = getUserAlerts(req.params.userId, req.params.organizationId)
  res.json(alerts)
})

phase7MonitoringRouter.post('/portal-alerts/:userId/:organizationId/:alertId/dismiss', requireAuth, (req: Request, res: Response) => {
  const success = dismissAlert(req.params.userId, req.params.organizationId, req.params.alertId)
  res.json({ success })
})

// Reports
phase7MonitoringRouter.post('/reports/generate', requireAuth, (req: Request, res: Response) => {
  const { userId, organizationId, name, reportType, period, format } = req.body
  const report = generateReport(userId, organizationId, name, reportType, period, format)
  res.json(report)
})

phase7MonitoringRouter.get('/reports/:userId/:organizationId', requireAuth, (req: Request, res: Response) => {
  const reports = getUserReports(req.params.userId, req.params.organizationId)
  res.json(reports)
})

phase7MonitoringRouter.post('/reports/:userId/:organizationId/:reportId/download-url', requireAuth, (req: Request, res: Response) => {
  const url = createReportDownloadUrl(req.params.userId, req.params.organizationId, req.params.reportId)
  res.json({ url: url || null, error: url ? null : 'Report not found or expired' })
})

// User Preferences
phase7MonitoringRouter.get('/preferences/:userId/:organizationId', requireAuth, (req: Request, res: Response) => {
  const prefs = getUserPreferences(req.params.userId, req.params.organizationId)
  res.json(prefs)
})

phase7MonitoringRouter.put('/preferences/:userId/:organizationId', requireAuth, (req: Request, res: Response) => {
  const prefs = updateUserPreferences(req.params.userId, req.params.organizationId, req.body)
  res.json(prefs)
})

// Portal Activity
phase7MonitoringRouter.post('/portal-activity', requireAuth, (req: Request, res: Response) => {
  const { userId, organizationId, action, resourceType, resourceId } = req.body
  const activity = recordActivity(userId, organizationId, action, resourceType, resourceId)
  res.json(activity)
})

phase7MonitoringRouter.get('/portal-activity/:organizationId', requireAuth, (req: Request, res: Response) => {
  const { days = 30 } = req.query
  const logs = getPortalAuditLogs(req.params.organizationId, Number(days))
  res.json(logs)
})

phase7MonitoringRouter.get('/portal-activity/:userId/:organizationId', requireAuth, (req: Request, res: Response) => {
  const { days = 30 } = req.query
  const logs = getUserAuditLogs(req.params.userId, req.params.organizationId, Number(days))
  res.json(logs)
})

// Budget Status View
phase7MonitoringRouter.post('/budget-status-view', requireAuth, (req: Request, res: Response) => {
  const { period, budgetAmount, spentAmount, percentElapsed } = req.body
  const view = createBudgetStatusView(period, budgetAmount, spentAmount, percentElapsed)
  res.json(view)
})

// ============================================================================
// INITIALIZATION & TESTING
// ============================================================================

phase7MonitoringRouter.post('/clear-all', requireAuth, (req: Request, res: Response) => {
  clearMonitoring()
  clearChargeback()
  clearPortal()
  res.json({ message: 'All Phase 7 data cleared' })
})
