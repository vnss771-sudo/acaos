# Phase 6: Enterprise Governance and Self-Service

## Overview

Phase 6 delivers enterprise-grade governance, organizational structures, compliance frameworks, and analytics. The system enables large organizations to implement role-based access control, multi-level budget delegation, policy enforcement, and comprehensive cost analytics across all business dimensions.

**Key Capabilities:**
- Role-based access control (RBAC) with 13 fine-grained permissions
- Multi-level organizational hierarchies (Company → Department → Team → User)
- Budget delegation workflows with approval chains
- Policy enforcement engine with compliance reporting
- Hierarchical analytics and KPI tracking
- Comprehensive audit trails (365-day retention)
- Self-service cost visibility with scoped access

**Architecture Components:**

1. **rbac.ts** (~700 LOC): Role-based access control with permissions, approval authority, cost visibility scopes, and audit logging
2. **organizationalHierarchy.ts** (~750 LOC): Multi-level org structure, budget delegation, and hierarchical cost views
3. **governanceEngine.ts** (~700 LOC): Policy definition, enforcement, and compliance tracking
4. **organizationalAnalytics.ts** (~650 LOC): Hierarchical KPIs, benchmarking, and cost trends
5. **phase6-governance.ts** (~1100 LOC): 45+ REST API endpoints
6. **Integration**: RBAC audit logs capture all governance actions

---

## Core Libraries

### 1. rbac.ts - Role-Based Access Control

Implements fine-grained authorization with hierarchical approval workflows.

**Permission Types (13):**
- `view_costs` - View cost data
- `export_costs` - Export cost reports
- `manage_budgets` - Create/modify budgets
- `approve_optimizations` - Approve cost recommendations
- `manage_policies` - Create/enforce policies
- `manage_users` - Add/remove users
- `manage_roles` - Create/assign roles
- `view_audit_log` - Access audit trail
- `manage_webhooks` - Configure webhooks
- `view_forecasts` - View cost forecasts
- `approve_budget_requests` - Approve budget changes
- `manage_rate_limits` - Control API rate limits
- `disable_features` - Disable platform features

**Cost Visibility Scopes:**
- `org_wide` - See all organization costs
- `department` - See department and teams within
- `team` - See only assigned team
- `self_only` - See only personal costs

**Approval Authority Levels:**
- `none` - Cannot approve
- `team_lead` - Approve up to $0 (auto-approve)
- `manager` - Approve up to configurable amount ($1K-$10K)
- `director` - Approve up to $10K
- `cfo` - Unlimited approval authority

**Default Roles:**

| Role | Permissions | Authority | Visibility | Max Approval |
|------|-----------|-----------|-----------|-------------|
| Admin | All 13 | CFO | org_wide | Unlimited |
| CFO | 8 permissions | CFO | org_wide | Unlimited |
| Director | 7 permissions | director | department | $10,000 |
| Manager | 5 permissions | manager | team | $1,000 |
| Developer | 2 permissions | none | team | $0 |
| Analyst | 4 permissions | none | org_wide | $0 |

**Audit Logging:**
Every action is logged with:
- User ID, action, resource type/ID
- Success/failure with denial reason
- Full change tracking (before/after)
- 365-day retention policy
- Indexed by resource for compliance queries

**Key Functions:**
```typescript
// Role management
createRole(name, description, permissions, approvalAuthority, costVisibilityScope, maxApprovalAmount)
getRole(roleId)

// User role assignment
assignUserRole(workspaceId, userId, roleId, departmentId, teamId)
getUserRole(workspaceId, userId)

// Permission checking (most used)
hasPermission(workspaceId, userId, permission) → boolean
canApproveAmount(workspaceId, userId, amount) → boolean
getCostVisibilityScope(workspaceId, userId) → CostVisibilityScope

// Audit trail
logAuditEntry(workspaceId, userId, action, resourceType, resourceId, result, denialReason, changes)
getAuditLog(workspaceId, days, limit)
getResourceAuditLog(workspaceId, resourceType, resourceId)
```

---

### 2. organizationalHierarchy.ts - Multi-Level Budget Structure

Enables organizations to define hierarchical structures with automatic budget rollup.

**Hierarchy Levels:**
```
Organization (total budget)
├── Department 1 (allocated budget)
│   ├── Team 1 (allocated budget)
│   │   ├── User A
│   │   └── User B
│   └── Team 2 (allocated budget)
└── Department 2 (allocated budget)
    └── Team X (allocated budget)
```

**Budget Allocation Model:**
- Organization has total budget (e.g., $1M/month)
- Departments allocated % of org budget
- Teams allocated % of department budget
- Automatic rollup: Team spending sums to Department, Department to Organization
- Real-time remaining budget visibility at each level

**Budget Delegation:**
- Manager delegates budget to team lead
- Director delegates to manager
- CFO delegates to director
- Approval workflow: pending → approved/rejected
- Optional expiration dates
- Auto-expiration prevents budget leakage

**Cost Views (Hierarchical):**
Track costs at each organizational level with breakdown:
- By resource type (compute, storage, network, API)
- By team/project
- Trend analysis (% change from previous period)
- Cost per unit metrics (per seat, per transaction, etc.)

**Key Functions:**
```typescript
// Organization
createOrganization(name, description, totalBudget)
updateOrganizationBudget(organizationId, newBudget)

// Department
createDepartment(organizationId, name, description, managerId, budget, parentDepartmentId)
getOrganizationDepartments(organizationId)
getSubdepartments(parentDepartmentId) // nested departments

// Team
createTeam(organizationId, departmentId, name, description, leadId, budget, memberIds)
getDepartmentTeams(departmentId)
addTeamMember(teamId, userId)
removeTeamMember(teamId, userId)

// Budget Allocation
setHierarchicalBudget(organizationId, spentBudget, departmentId, teamId, userId)
calculateOrganizationBudgetRollup(organizationId) // totals by department
calculateDepartmentBudgetRollup(departmentId) // totals by team

// Budget Delegation
delegateBudget(organizationId, fromUserId, toUserId, budgetAmount, departmentId, teamId, expiresAt)
approveBudgetDelegation(organizationId, delegationId)
rejectBudgetDelegation(organizationId, delegationId)
getPendingDelegations(organizationId)

// Cost Views
createCostView(organizationId, level, entityId, totalCost, breakdown, trend, costPerUnit)
getOrganizationCostView(organizationId)
getDepartmentCostViews(organizationId)
```

---

### 3. governanceEngine.ts - Policy Enforcement & Compliance

Implements policy definition, automated enforcement, and compliance reporting.

**Policy Types (5):**

1. **budget_limit**: Enforce maximum spending per entity
   - Rule: `{ amount: 50000 }` (max $50K)
   - Violation: spending > amount

2. **cost_threshold**: Alert on cost exceeding threshold
   - Rule: `{ threshold: 75000, severity: 'critical' }`
   - Violation: cost > threshold (severity-based)

3. **approval_requirement**: Mandate approval before action
   - Rule: `{ required: true }`
   - Violation: action taken without approval

4. **resource_restriction**: Whitelist allowed resource types
   - Rule: `{ allowed: ['compute', 'storage'] }`
   - Violation: resource type not in whitelist

5. **compliance**: Custom compliance rules
   - Rule: arbitrary key-value pairs
   - Violation: actual value ≠ expected value

**Policy Enforcement Flow:**
1. Policy created with conditions and scope
2. On entity action, enforcePolicies() evaluates all applicable policies
3. Violations reported with severity (warning/critical)
4. Enforcement status: pass/fail/warning
5. Results logged to audit trail

**Compliance Reporting:**
- Daily/weekly/monthly automated reports
- Per-policy compliance percentage (0-100%)
- Organization-wide compliance status:
  - ≥95%: compliant
  - ≥80%: at_risk
  - <80%: non_compliant
- Recommendations for low-compliance policies
- 30-day rolling window

**Audit Trail:**
- Records policy evaluations and enforcement actions
- Tracks violations with details (rule, actual, limit, severity)
- 365-day retention
- Indexed by policy/entity for reports

**Key Functions:**
```typescript
// Policy Management
createPolicy(workspaceId, name, description, type, scope, rules, entityId, priority)
getWorkspacePolicies(workspaceId, type)
updatePolicy(workspaceId, policyId, updates)
enablePolicy/disablePolicy(workspaceId, policyId)
deletePolicy(workspaceId, policyId)

// Policy Enforcement
enforcePolicies(workspaceId, entityId, entityData) → PolicyEnforcement
getEnforcementHistory(workspaceId, entityId, days)

// Audit Trail
recordAuditTrail(workspaceId, policyId, entityId, action, result, reason, metadata)
getPolicyAuditTrail(workspaceId, policyId, days)

// Compliance
generateComplianceReport(workspaceId, period) // daily/weekly/monthly
getComplianceReports(workspaceId, days, limit)
```

---

### 4. organizationalAnalytics.ts - Hierarchical Analytics & KPIs

Provides cost analytics across organizational dimensions with trend analysis and benchmarking.

**Cost Metrics:**
Record costs by dimension:
- Entity: organization/department/team/project/customer
- Period: YYYY-MM-DD
- Total cost and breakdown by resource type
- Trend: % change from previous period
- Support for multi-period analysis (12+ months)

**Performance KPIs:**
Track organization-wide KPIs:
- Cost per seat (total cost / headcount)
- Cost per transaction (total cost / transaction count)
- Cost per unit (total cost / unit count)
- Target vs. actual with status (on_track/at_risk/off_track)
- Trend analysis (% change period-over-period)

**Benchmarking:**
Compare against:
- Industry benchmarks (e.g., "typical SaaS costs")
- Peer organizations (e.g., "similar-sized companies")
- Internal benchmarks (e.g., "our last quarter")
- Variance calculation: (actual - benchmark) / benchmark
- Status: above_average/average/below_average

**Cost Trends:**
Analyze cost direction:
- Direction: increasing/decreasing/stable (±5% = stable)
- Change percentage: compound change rate
- 3-period moving averages to smooth noise
- Optional forecast projections
- Support for multi-year trend analysis

**Cost Breakdowns:**
Multi-dimensional cost analysis:
- By team/department
- By project/product
- By resource type (compute, storage, network, API, ML, etc.)
- By customer (for SaaS providers)
- By region (for geographic analysis)
- Flexible for custom dimensions

**Analytics Summary:**
Executive dashboard:
- All KPIs with status
- Benchmarks vs. targets
- Trend analysis (top 5 cost drivers)
- Automatic recommendations

**Key Functions:**
```typescript
// Metrics
recordCostMetric(entityId, entityType, period, totalCost, breakdown, trend)
getEntityMetrics(entityId, entityType, periods)

// KPIs
setPerformanceKPI(organizationId, name, description, metric, targetValue, actualValue, period)
getOrganizationKPIs(organizationId)

// Benchmarks
createBenchmark(organizationId, name, benchmark, metric, benchmarkValue, actualValue)
getOrganizationBenchmarks(organizationId, benchmarkType)

// Trends
trackCostTrend(entityId, entityType, metric, periods)
getCostTrend(entityId, entityType, metric)

// Breakdowns
createCostBreakdown(entityId, period, byTeam, byProject, byResourceType, byCustomer, byRegion)
getCostBreakdown(entityId, period)

// Calculations
calculateCostPerSeat(totalCost, headcount)
calculateCostPerTransaction(totalCost, transactionCount)
calculateCostPerUnit(totalCost, unitCount)

// Summary
getAnalyticsSummary(organizationId) // KPIs + benchmarks + trends + top drivers
```

---

## API Endpoints (45+)

### RBAC Endpoints (10)

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/governance/roles` | Create role |
| GET | `/governance/roles/:roleId` | Get role |
| POST | `/governance/user-roles` | Assign role to user |
| GET | `/governance/user-roles/:userId/:workspaceId` | Get user's role |
| POST | `/governance/check-permission` | Check if user has permission |
| POST | `/governance/check-approval` | Check if user can approve amount |
| GET | `/governance/cost-visibility/:userId/:workspaceId` | Get cost visibility scope |
| POST | `/governance/cost-visibility-rule` | Set custom visibility rule |
| POST | `/governance/audit-log` | Log audit entry |
| GET | `/governance/audit-log/:workspaceId` | Get audit log |

### Organizational Hierarchy Endpoints (20)

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/governance/organizations` | Create organization |
| GET | `/governance/organizations/:organizationId` | Get organization |
| PUT | `/governance/organizations/:organizationId/budget` | Update org budget |
| POST | `/governance/departments` | Create department |
| GET | `/governance/departments/:departmentId` | Get department |
| GET | `/governance/departments/organization/:organizationId` | List departments |
| GET | `/governance/subdepartments/:parentDepartmentId` | Get nested departments |
| POST | `/governance/teams` | Create team |
| GET | `/governance/teams/:teamId` | Get team |
| GET | `/governance/teams/department/:departmentId` | List teams |
| POST | `/governance/teams/:teamId/members/:userId` | Add team member |
| DELETE | `/governance/teams/:teamId/members/:userId` | Remove team member |
| POST | `/governance/hierarchical-budget` | Set budget allocation |
| GET | `/governance/hierarchical-budget/:organizationId` | Get budget |
| GET | `/governance/budget-rollup/organization/:organizationId` | Get org budget rollup |
| GET | `/governance/budget-rollup/department/:departmentId` | Get dept budget rollup |
| POST | `/governance/budget-delegation` | Delegate budget |
| POST | `/governance/budget-delegation/:organizationId/:delegationId/approve` | Approve delegation |
| POST | `/governance/budget-delegation/:organizationId/:delegationId/reject` | Reject delegation |
| GET | `/governance/budget-delegations/pending/:organizationId` | Get pending delegations |

### Governance Policy Endpoints (13)

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/governance/policies` | Create policy |
| GET | `/governance/policies/:workspaceId/:policyId` | Get policy |
| GET | `/governance/policies/:workspaceId` | List policies |
| PUT | `/governance/policies/:workspaceId/:policyId` | Update policy |
| POST | `/governance/policies/:workspaceId/:policyId/enable` | Enable policy |
| POST | `/governance/policies/:workspaceId/:policyId/disable` | Disable policy |
| DELETE | `/governance/policies/:workspaceId/:policyId` | Delete policy |
| POST | `/governance/enforce-policies` | Enforce policies on entity |
| GET | `/governance/enforcement-history/:workspaceId/:entityId` | Get enforcement history |
| POST | `/governance/policy-audit` | Log policy audit trail |
| GET | `/governance/policy-audit/:workspaceId/:policyId` | Get policy audit trail |
| POST | `/governance/compliance-reports/:workspaceId` | Generate compliance report |
| GET | `/governance/compliance-reports/:workspaceId` | Get compliance reports |

### Analytics Endpoints (12)

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/governance/cost-metrics` | Record cost metric |
| GET | `/governance/cost-metrics/:entityId/:entityType` | Get cost metrics |
| POST | `/governance/kpis` | Set performance KPI |
| GET | `/governance/kpis/:organizationId` | Get KPIs |
| POST | `/governance/benchmarks` | Create benchmark |
| GET | `/governance/benchmarks/:organizationId` | Get benchmarks |
| POST | `/governance/cost-trends` | Track cost trend |
| GET | `/governance/cost-trends/:entityId/:entityType/:metric` | Get trend |
| POST | `/governance/cost-breakdowns` | Create cost breakdown |
| GET | `/governance/cost-breakdowns/:entityId/:period` | Get breakdown |
| POST | `/governance/kpi/cost-per-seat` | Calculate cost per seat |
| GET | `/governance/analytics-summary/:organizationId` | Get analytics summary |

---

## Integration Points

### With Phase 5 (Cost Optimization)
- Cost visibility scopes from RBAC filter optimization recommendations
- Approval workflows use permission/authority checking
- Policy enforcement can trigger auto-optimizations
- Compliance reports track optimization success

### With Phase 4.9 (Rate Limiting)
- Rate limits enforced per role (manager ≠ developer)
- Feature degradation integrated with budget policies
- Plan tier assignment uses RBAC roles

### With Phase 4.8 (Budget Management)
- Budget enforcement uses RBAC permissions
- Hierarchical budgets cascade from org → dept → team
- Approval workflows require appropriate authority levels

---

## Usage Examples

### Example 1: Setting Up Organization

```typescript
// Create organization
const org = createOrganization('TechCorp', 'Tech company', 1000000); // $1M/month

// Create departments
const engDept = createDepartment(org.id, 'Engineering', '...', 'mgr1', 500000);
const finDept = createDepartment(org.id, 'Finance', '...', 'mgr2', 200000);

// Create teams
const backendTeam = createTeam(org.id, engDept.id, 'Backend', '...', 'lead1', 300000, ['user1', 'user2']);
const frontendTeam = createTeam(org.id, engDept.id, 'Frontend', '...', 'lead2', 200000, ['user3', 'user4']);

// Budget rollup
const rollup = calculateOrganizationBudgetRollup(org.id);
// { totalAllocated: 700000, totalSpent: 0, totalRemaining: 700000, ... }
```

### Example 2: RBAC with Cost Visibility

```typescript
// Assign roles
const managerRole = getRole('role-manager-id');
assignUserRole(workspaceId, 'user123', managerRole.id, engDept.id, backendTeam.id);

// Check permissions
hasPermission(workspaceId, 'user123', 'view_costs'); // true
hasPermission(workspaceId, 'user123', 'manage_users'); // false

// Check approval authority
canApproveAmount(workspaceId, 'user123', 25000); // false (manager limit: $1K)
canApproveAmount(workspaceId, 'user123', 500); // true

// Get cost visibility
const scope = getCostVisibilityScope(workspaceId, 'user123'); // 'team'
// User only sees costs from their team
```

### Example 3: Policy Enforcement

```typescript
// Create budget policy
const policy = createPolicy(
  workspaceId,
  'Team Budget Cap',
  'Prevent team spending over $100K/month',
  'budget_limit',
  'team',
  { amount: 100000 },
  backendTeam.id
);

// Check compliance
const enforcement = enforcePolicies(
  workspaceId,
  backendTeam.id,
  { spent: 95000 }
);
// { status: 'pass', violations: [] }

const enforcement2 = enforcePolicies(
  workspaceId,
  backendTeam.id,
  { spent: 105000 }
);
// { status: 'fail', violations: [{ rule: 'budget_exceeded', ... }] }
```

### Example 4: Compliance Reporting

```typescript
// Generate report
const report = generateComplianceReport(workspaceId, 'monthly');
// {
//   overallStatus: 'at_risk',
//   policyResults: [
//     { policyName: 'Team Budget Cap', compliance: 92% },
//     { policyName: 'Approval Required', compliance: 87% },
//   ],
//   recommendations: ['Tighten Team Budget Cap enforcement']
// }
```

### Example 5: Analytics

```typescript
// Record metrics
recordCostMetric('team1', 'team', '2024-09-01', 45000, {
  compute: 30000,
  storage: 10000,
  network: 5000
});

// Set KPI
setPerformanceKPI(
  org.id,
  'Cost Per Seat',
  'Monthly cost per engineer',
  'cost_per_seat',
  5000, // target
  4800, // actual
  '2024-09'
); // status: 'on_track' (96% of target)

// Create benchmark
createBenchmark(
  org.id,
  'Industry Average',
  'industry',
  'cost_per_seat',
  6000, // industry avg
  4800  // our cost
); // status: 'below_average' (20% cheaper)

// Get summary
const summary = getAnalyticsSummary(org.id);
// { kpis: [...], benchmarks: [...], trends: [...], topCostDrivers: [...] }
```

---

## Performance Characteristics

| Operation | Complexity | Notes |
|-----------|-----------|-------|
| Permission check | O(1) | Direct role lookup + permission array search |
| Budget rollup (org) | O(d) | d = number of departments |
| Budget rollup (dept) | O(t) | t = number of teams |
| Policy enforcement | O(p) | p = number of applicable policies |
| Compliance report | O(p × e) | e = enforcement records |
| Cost trend analysis | O(n log n) | n = metric periods, includes sort |
| Analytics summary | O(p + b + t + m) | Aggregates across multiple types |

**Optimization Notes:**
- Role/permission checks cached in-memory (O(1))
- Audit log keeps only 365 days (automatic pruning)
- Budget rollups calculated on-demand (could be cached)
- Policy evaluation short-circuits on critical violations

---

## Testing Recommendations

### Unit Tests
- Permission matrix: 13 × 6 role combinations
- Policy evaluation: 5 types × 10 scenarios per type
- Budget rollup: nested hierarchies 2-4 levels deep
- Compliance calculation: 90%+, 80-90%, <80% boundaries
- Trend detection: increasing/decreasing/stable thresholds

### Integration Tests
- End-to-end: Create org → dept → team → assign roles → set budgets → check permissions → enforce policies
- RBAC + audit: Every action logged with correct user/result
- Cost visibility: User at different scopes sees correct data
- Budget delegation: Approval workflow (pending → approved)
- Compliance: Policy violations trigger correct status

### Load Tests
- 1000 users × 50 roles = permission check throughput
- 1M audit entries × query by resource
- 10K policies × enforcement evaluation
- 100K metrics × analytics summary calculation

---

## Migration & Deployment

### Prerequisites
- Phase 4.8, 4.9, 5 fully deployed
- RBAC system accessible to API layer
- Audit logging infrastructure in place

### Deployment Steps
1. Deploy rbac.ts + libraries
2. Deploy phase6-governance.ts router
3. Update index.ts with mount
4. Initialize default roles via POST `/governance/initialize`
5. Migrate existing user-role mappings
6. Enable policy enforcement gradually (audit mode first)

### Backwards Compatibility
- Existing permission checks use new RBAC (additive)
- Cost visibility defaults to `self_only` if not configured
- Policies start in disabled state
- Audit logging adds to existing trail

---

## Future Enhancements

1. **Delegated Administration**: Department heads can manage their own teams/budgets
2. **Scheduled Policies**: Time-based policy activation (e.g., "freeze spending on Q4 close")
3. **Custom Roles**: Organizations define custom role templates
4. **Policy Templates**: Pre-built policy sets for industries (SaaS, Enterprise, etc.)
5. **Advanced Analytics**: Predictive compliance modeling, anomaly detection in KPIs
6. **Governance Workflows**: Visual policy builder, approval workflow engine
7. **Integration**: Slack/Teams alerts on compliance violations, Datadog dashboard sync
