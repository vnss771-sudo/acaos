# Phase 7: Real-Time Cost Monitoring, Chargeback & Self-Service Portal

## Overview

Phase 7 delivers operational visibility and cost management tooling for organizations. The system provides real-time cost monitoring with spike detection, internal billing and chargeback workflows, and a self-service portal for cost exploration respecting RBAC boundaries from Phase 6.

**Key Capabilities:**
- Real-time cost aggregation with 1-hour granularity
- Statistical anomaly detection (cost spikes using σ thresholds)
- Budget pace tracking (% spent vs % elapsed)
- Period-over-period cost change analysis
- Showback and chargeback statement generation
- Internal invoicing with markup and reconciliation
- Self-service cost portal with dashboards
- RBAC-gated cost visibility
- Report generation and download
- Comprehensive audit logging

**Architecture Components:**

1. **costMonitoring.ts** (~850 LOC): Real-time cost tracking, baseline modeling, spike detection, budget pace
2. **chargebackEngine.ts** (~700 LOC): Showback/chargeback statements, invoicing, allocation rules, reconciliation
3. **selfServicePortal.ts** (~750 LOC): Dashboards, cost views, alerts, reports, user preferences
4. **phase7-monitoring.ts** (~1100 LOC): 38 REST API endpoints
5. **Integration**: Works with Phases 4-6, respects RBAC visibility scopes

---

## Core Libraries

### 1. costMonitoring.ts - Real-Time Cost Monitoring

Implements live cost tracking, baseline modeling, and anomaly detection.

**Cost Data Points:**
- Recorded at 1-hour granularity (can aggregate to higher frequencies)
- Includes breakdown by service/team/resource type
- 90-day rolling window retention
- Time-series data for trend analysis

**Cost Baselines:**
- Calculated from 30 days of historical data
- Mean + standard deviation (σ) for statistical anomaly detection
- Trend analysis: month-over-month % change
- Seasonal factors: weekday vs. weekend, time-of-day multipliers
- Updated on-demand as new data arrives

**Cost Spike Detection:**
- Threshold: > 1.5σ above baseline (configurable)
- Severity levels:
  - `low`: 1.5σ - 2σ
  - `medium`: 2σ - 2.5σ
  - `high`: 2.5σ - 3σ
  - `critical`: > 3σ
- Captures affected services
- Manual resolution workflow

**Budget Pace Tracking:**
- Hierarchical: organization, department, team
- Metrics:
  - `percentSpent`: $ spent / budget * 100
  - `percentElapsed`: days elapsed / period total * 100
  - `onTrack`: percentSpent ≤ percentElapsed (healthy)
  - `projectedFinalCost`: linear projection to period end
  - `projectedOverage`: max(0, projected - budget)
  - `daysRemaining`: calendar days until period end

**Cost Change Analysis:**
- Period-over-period comparison (default: 7 days)
- Absolute and percentage change
- Direction: increase/decrease/stable (±5% threshold)
- Top contributors: services driving change
- Rolling 30-day history

**Live Aggregates:**
- Real-time cost summaries
- Time windows: last hour, last day, last week, last month, running month
- Trend: hour-over-hour change %
- Updated on each data point
- Used for dashboard refresh

**Alerts:**
- Types: spike, budget_pace, threshold, anomaly
- Severity: low/medium/high/critical
- Acknowledgment workflow with user tracking
- Auto-escalation: unacknowledged alerts after 24h

**Key Functions:**
```typescript
// Data points
recordCostDataPoint(organizationId, totalCost, breakdown)
getCostDataPoints(organizationId, hours)

// Baselines
calculateCostBaseline(organizationId, metric, historicalDays)
getCostBaseline(organizationId, metric)

// Spikes
detectCostSpike(organizationId, currentCost, affectedServices) → CostSpike | null
getActiveSpikes(organizationId)
resolveSpike(organizationId, spikeId)

// Budget pace
calculateBudgetPace(organizationId, budgetAmount, spentAmount, periodStartDate, periodEndDate)
getBudgetPace(organizationId, departmentId, teamId)

// Cost changes
calculateCostChange(organizationId, currentPeriodStart, currentPeriodEnd, previousPeriodDays)
getCostChanges(organizationId, days)

// Live aggregates
updateLiveAggregate(organizationId) → LiveCostAggregate
getLiveAggregate(organizationId)

// Alerts
createAlert(organizationId, type, severity, message) → CostAlert
getActiveAlerts(organizationId)
acknowledgeAlert(organizationId, alertId, userId)
```

---

### 2. chargebackEngine.ts - Chargeback & Internal Billing

Implements cost allocation, showback, chargeback, and invoicing workflows.

**Allocation Rules:**
- Define how costs are distributed across cost centers
- Allocation rule: maps cost center → departments with percentages
- Validation: percentages must sum to 100%
- Markup factor: overhead rate (e.g., 1.2x = 20% markup)
- Enable/disable for flexible activation

**Showback Statements:**
- Informational cost views (no charges applied)
- Per department per month
- Breakdown by service/project/team
- Trend: % change from previous month
- Used for transparency and awareness

**Chargeback Statements:**
- Cost allocation with financial implications
- Base cost + markup amount = total charge
- Workflow: draft → issued → paid
- 30-day payment terms (configurable)
- Due date enforcement
- Overdue tracking

**Chargeback Allocations:**
- Record how costs are assigned to departments
- Types: direct (100% to one dept), shared (split), overhead (allocation rule)
- Basis: headcount, usage, equal_split, custom
- Full audit trail: cost → source → target
- Supports complex multi-level allocation

**Internal Invoices:**
- Formal billing documents
- Invoice number: INV-{timestamp}-{random}
- Line items: description, quantity, unit cost
- Subtotal + 10% tax + markup
- Status: draft → sent → paid
- Payment tracking: full/partial payments
- Notes field for payment instructions

**Charge Reconciliation:**
- Monthly reconciliation report
- Compares budgeted vs allocated vs charged
- Variance analysis: amount and %
- Per-department breakdown
- Identifies over/under-allocation

**Key Functions:**
```typescript
// Allocation rules
createAllocationRule(organizationId, name, costCenterId, allocation, markupFactor)
getAllocationRules(organizationId, enabled)
updateAllocationRule(organizationId, ruleId, updates)

// Showback
generateShowbackStatement(organizationId, departmentId, period, totalCost, breakdown, trend)
getShowbackStatements(organizationId, departmentId, months)

// Chargeback
generateChargebackStatement(organizationId, departmentId, period, baseCost, breakdown, markupFactor)
getChargebackStatements(organizationId, departmentId, status)
issueChargebackStatement(organizationId, statementId)
markChargebackPaid(organizationId, statementId)

// Allocations
recordChargebackAllocation(organizationId, costId, sourceDeptId, targetDeptId, type, amount, basis)
getChargebackAllocations(organizationId, departmentId)

// Invoices
createInternalInvoice(organizationId, departmentId, period, items, markupFactor)
getInternalInvoices(organizationId, departmentId, status)
sendInvoice(organizationId, invoiceId)
recordPayment(organizationId, invoiceId, paidAmount)

// Reconciliation
generateChargeReconciliation(organizationId, period, departmentBudgets)
getChargeReconciliations(organizationId, months)
```

---

### 3. selfServicePortal.ts - Self-Service Cost Portal

Implements RBAC-gated dashboards, cost views, and reporting.

**Dashboards:**
- Types: executive, department, team, project, custom
- Configurable widgets (8 types):
  - Cost summary
  - Budget pace visualization
  - Cost trend chart
  - Top services breakdown
  - Active alerts
  - Optimization recommendations
  - Multi-dimensional breakdown
  - Custom widget
- Widget positioning: x, y, width, height for layout
- Refresh interval: 5 minutes default (configurable)

**Cost Breakdown Views:**
- Multi-dimensional cost analysis
- Dimensions: team, service, region, project, customer (custom)
- Top-to-bottom sorted by cost
- Percentage of total calculated
- Optimized for pivot/drill-down UI

**Portal Alerts:**
- Types: spike, budget, recommendation, policy
- User-specific: tied to userId + organizationId
- Dismissal workflow: unacknowledged → dismissed
- Action URLs: link to recommended action
- Combined with real-time alerts from costMonitoring

**Report Generation:**
- 6 report types:
  - `executive_summary`: High-level cost overview
  - `detailed_cost_analysis`: Deep dive by dimension
  - `budget_variance`: Actual vs budgeted analysis
  - `recommendations`: Optimization opportunities
  - `compliance`: Policy violations and compliance status
  - `custom`: User-defined report
- Formats: PDF, CSV, JSON
- Asynchronous generation (simulated)
- 30-day file retention with expiration
- Download URLs with time-limited access tokens

**User Preferences:**
- Currency, timezone, email settings
- Default dashboard selection
- Alert thresholds:
  - Spike severity filter (show only high+ spikes)
  - Budget threshold: alert when > X% spent
  - Recommendation minimum savings: filter by ROI
- Email frequency: daily, weekly, monthly
- Persistent across sessions

**Portal Audit Logs:**
- Track: dashboard views, report generation, downloads
- Per-user activity tracking
- 365-day retention
- Compliance-ready: all cost access logged

**Budget Status View:**
- Helper for dashboard widgets
- Calculates: pace, trend, projection
- Trend analysis: improving/stable/degrading based on history
- Used for budget-focused dashboards

**Key Functions:**
```typescript
// Dashboards
createDashboard(userId, organizationId, name, dashboardType, widgets, refreshInterval)
getUserDashboards(userId, organizationId)
getDashboard(dashboardId, userId, organizationId)
updateDashboardWidgets(dashboardId, userId, organizationId, widgets)

// Cost views
createCostBreakdownView(entityId, period, dimensions, data)
getCostBreakdownView(entityId, period)

// Portal alerts
createPortalAlert(userId, organizationId, type, severity, title, message, actionUrl)
getUserAlerts(userId, organizationId)
dismissAlert(userId, organizationId, alertId)

// Reports
generateReport(userId, organizationId, name, reportType, period, format)
getUserReports(userId, organizationId)
createReportDownloadUrl(userId, organizationId, reportId)

// Preferences
getUserPreferences(userId, organizationId)
updateUserPreferences(userId, organizationId, updates)

// Audit
recordActivity(userId, organizationId, action, resourceType, resourceId)
getPortalAuditLogs(organizationId, days)
getUserAuditLogs(userId, organizationId, days)

// Budget status
createBudgetStatusView(period, budgetAmount, spentAmount, percentElapsed)
```

---

## API Endpoints (38 Total)

### Real-Time Monitoring Endpoints (12)

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/monitoring/cost-data` | Record cost data point |
| GET | `/monitoring/cost-data/:organizationId` | Get cost history |
| POST | `/monitoring/baselines` | Calculate baseline |
| GET | `/monitoring/baselines/:organizationId/:metric` | Get baseline |
| POST | `/monitoring/detect-spike` | Detect cost spike |
| GET | `/monitoring/spikes/:organizationId` | Get active spikes |
| POST | `/monitoring/spikes/:organizationId/:spikeId/resolve` | Resolve spike |
| POST | `/monitoring/budget-pace` | Calculate budget pace |
| GET | `/monitoring/budget-pace/:organizationId` | Get budget pace |
| POST | `/monitoring/cost-changes` | Calculate cost change |
| GET | `/monitoring/cost-changes/:organizationId` | Get cost changes |
| POST/GET | `/monitoring/live-aggregate/:organizationId` | Update/get live aggregate |

### Chargeback & Invoicing Endpoints (15)

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/monitoring/allocation-rules` | Create allocation rule |
| GET | `/monitoring/allocation-rules/:organizationId` | List rules |
| PUT | `/monitoring/allocation-rules/:organizationId/:ruleId` | Update rule |
| POST | `/monitoring/showback` | Generate showback |
| GET | `/monitoring/showback/:organizationId` | Get showback statements |
| POST | `/monitoring/chargeback` | Generate chargeback |
| GET | `/monitoring/chargeback/:organizationId` | Get chargeback statements |
| POST | `/monitoring/chargeback/:organizationId/:statementId/issue` | Issue statement |
| POST | `/monitoring/chargeback/:organizationId/:statementId/mark-paid` | Mark paid |
| POST | `/monitoring/chargeback-allocation` | Record allocation |
| GET | `/monitoring/chargeback-allocation/:organizationId` | Get allocations |
| POST | `/monitoring/invoices` | Create invoice |
| GET | `/monitoring/invoices/:organizationId` | Get invoices |
| POST | `/monitoring/invoices/:organizationId/:invoiceId/send` | Send invoice |
| POST | `/monitoring/invoices/:organizationId/:invoiceId/payment` | Record payment |

### Portal Endpoints (10)

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/monitoring/dashboards` | Create dashboard |
| GET | `/monitoring/dashboards/:userId/:organizationId` | List dashboards |
| GET | `/monitoring/dashboards/:userId/:organizationId/:dashboardId` | Get dashboard |
| PUT | `/monitoring/dashboards/:userId/:organizationId/:dashboardId` | Update dashboard |
| POST | `/monitoring/cost-breakdown` | Create breakdown view |
| GET | `/monitoring/cost-breakdown/:entityId/:period` | Get breakdown |
| POST | `/monitoring/portal-alerts` | Create alert |
| GET | `/monitoring/portal-alerts/:userId/:organizationId` | Get alerts |
| POST | `/monitoring/portal-alerts/:userId/:organizationId/:alertId/dismiss` | Dismiss alert |
| GET | `/monitoring/preferences/:userId/:organizationId` | Get preferences |

### Report Endpoints (3)

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/monitoring/reports/generate` | Generate report |
| GET | `/monitoring/reports/:userId/:organizationId` | List reports |
| POST | `/monitoring/reports/:userId/:organizationId/:reportId/download-url` | Get download URL |

### Audit & Utility Endpoints (3)

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/monitoring/portal-activity` | Record activity |
| GET | `/monitoring/portal-activity/:organizationId` | Get audit logs |
| GET | `/monitoring/portal-activity/:userId/:organizationId` | Get user activity |

---

## Workflows

### Real-Time Spike Alerting

```
1. recordCostDataPoint() every hour
2. calculateCostBaseline() on schedule or on-demand
3. detectCostSpike() checks current vs baseline
4. createAlert() if spike detected
5. Portal shows active alerts
6. User acknowledgment or auto-escalation
7. resolveSpike() when addressed
```

### Monthly Chargeback Process

```
1. Generate showback statements (informational)
   - Managers review for accuracy
2. Apply allocation rules if needed
3. Generate chargeback statements (draft)
   - Based on actual costs + markups
4. issueChargebackStatement() to finance
5. createInternalInvoice() for billing
6. sendInvoice() to department managers
7. recordPayment() as payments arrive
8. generateChargeReconciliation() at month-end
```

### Cost Exploration in Portal

```
1. User logs in, sees their RBAC-scoped costs
2. Select dashboard type
3. View cost breakdown by dimensions
4. Check budget pace and remaining
5. View optimization recommendations
6. Generate report for stakeholders
7. Download as CSV/PDF/JSON
8. Portal records activity in audit log
```

---

## Integration Points

### With Phase 6 (Governance)
- Cost visibility scopes applied to portal dashboards
- User roles determine which dashboards available
- Department managers see their dept costs only
- RBAC enforces: view_costs permission required
- Audit logs record all cost access
- Policy violations appear as alerts

### With Phase 5 (Optimization)
- Optimization recommendations appear as portal alerts
- Cost spikes trigger anomaly-based recommendations
- Savings projected in chargeback statements
- Top cost drivers identified in cost breakdown

### With Phase 4.8 (Budgets)
- Budget pace calculations use budget amounts
- Budget exceeded triggers alert
- Budget forecasts inform chargeback rates

---

## Performance Characteristics

| Operation | Complexity | Notes |
|-----------|-----------|-------|
| Record cost point | O(1) | Direct storage |
| Calculate baseline | O(n) | n = historical days (30) |
| Detect spike | O(1) | Baseline lookup + comparison |
| Get budget pace | O(1) | Direct calculation |
| Cost change analysis | O(n) | n = metric periods (7-30) |
| Generate chargeback | O(d) | d = departments |
| Generate report | O(m) | m = metrics/allocations |
| Cost breakdown query | O(log n) | Indexed by entityId:period |
| Dashboard load | O(w) | w = widgets (typically 5-10) |

**Optimization Strategies:**
- Cost baselines cached after calculation
- Live aggregates updated incrementally
- Dashboard widget rendering optimized (lazy load)
- Report generation async with queue
- Audit logs pruned to 365 days

---

## Usage Examples

### Example 1: Spike Detection & Alerting

```typescript
// Record hourly costs
recordCostDataPoint('org-123', 5000, {
  compute: 3000,
  storage: 1500,
  network: 500
});

// Calculate baseline from historical data
const baseline = calculateCostBaseline('org-123', 'daily_cost', 30);
// Returns: {
//   baselineValue: 4200,
//   standardDeviation: 400,
//   trend: 5.2, // % increase month-over-month
//   seasonalFactor: 1.1
// }

// Detect if current is spike
const spike = detectCostSpike('org-123', 5500, ['compute']);
// 5500 vs (4200 * 1.1) baseline = 2.1σ above = HIGH spike
// Returns: { severity: 'high', deviation: 2.1, ... }

// Create alert
createAlert('org-123', 'spike', 'high', 'Cost 21% above expected');
```

### Example 2: Budget Pace Tracking

```typescript
// Calculate pace
const pace = calculateBudgetPace(
  'org-123',
  50000,           // $50K budget
  35000,           // $35K spent
  '2024-09-01',    // Period start
  '2024-09-30',    // Period end
  'dept-456'       // Department
);

// Returns: {
//   percentSpent: 70,
//   percentElapsed: 50,
//   onTrack: false,  // Overspending
//   daysRemaining: 11,
//   projectedFinalCost: 70000,
//   projectedOverage: 20000
// }

// Alert triggered: "On pace to overspend by $20K"
```

### Example 3: Monthly Chargeback

```typescript
// Create allocation rule
const rule = createAllocationRule(
  'org-123',
  'Cloud Services',
  'compute-center',
  {
    'dept-eng': 60,    // Engineering pays 60%
    'dept-data': 30,   // Data pays 30%
    'dept-admin': 10   // Admin pays 10%
  },
  1.1  // 10% markup for overhead
);

// Generate chargeback
const statement = generateChargebackStatement(
  'org-123',
  'dept-eng',
  '2024-09-01',
  50000,  // Base cost
  { compute: 40000, storage: 10000 },
  1.1
);
// statement.totalCharge = 50000 + 5000 = $55K

// Create invoice for billing
const invoice = createInternalInvoice(
  'org-123',
  'dept-eng',
  '2024-09',
  [{ description: 'Cloud Services', quantity: 1, unitCost: 55000 }]
);

// Send to manager
sendInvoice('org-123', invoice.id);

// Process payment
recordPayment('org-123', invoice.id, 55000);
```

### Example 4: Self-Service Dashboard

```typescript
// Create dashboard
const dashboard = createDashboard(
  'user-123',
  'org-456',
  'Team Cost Dashboard',
  'team',
  [
    { type: 'cost_summary', title: 'This Month' },
    { type: 'budget_pace', title: 'Budget Status' },
    { type: 'cost_trend', title: 'Last 12 Months' },
    { type: 'top_services', title: 'Top Cost Drivers' }
  ]
);

// View costs (respects RBAC visibility scope)
const breakdown = createCostBreakdownView(
  'team-789',
  '2024-09',
  ['service', 'region'],
  [
    { labels: { service: 'compute', region: 'us-east' }, cost: 15000, percentage: 50 },
    { labels: { service: 'storage', region: 'us-west' }, cost: 9000, percentage: 30 }
  ]
);

// Generate report
const report = generateReport(
  'user-123',
  'org-456',
  'September Cost Analysis',
  'detailed_cost_analysis',
  '2024-09',
  'pdf'
);

// Download
const downloadUrl = createReportDownloadUrl('user-123', 'org-456', report.id);
// /api/reports/download/{reportId}?token=1726767240000
```

---

## Security & Compliance

- **RBAC Integration**: All cost views enforce Phase 6 visibility scopes
- **Audit Logging**: All portal access logged with user/timestamp/action
- **Data Retention**: Cost data 90 days, audit logs 365 days
- **Access Control**: Cost breakdown respects department/team boundaries
- **Report Access**: Time-limited download URLs with token expiration
- **Encryption**: Sensitive financial data encrypted at rest (application layer)

---

## Future Enhancements

1. **ML Forecasting**: Predict spikes using ARIMA or Prophet
2. **Anomaly Explanation**: Root cause analysis for cost spikes
3. **Chargeback Automation**: Scheduled showback/chargeback generation
4. **Portal Customization**: Drag-drop dashboard builder for users
5. **Export Integration**: Push cost data to data warehouse (Snowflake, BigQuery)
6. **Budget Simulation**: What-if scenarios for budget planning
7. **Approval Workflows**: Department head approval before chargeback issuance
8. **Comparative Analytics**: Compare costs vs peer departments/industry
