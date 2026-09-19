# Phase 10: Autonomous Agents & Intelligent Automation

**Status**: Complete
**Version**: 1.0  
**Date**: September 2026

---

## Overview

Phase 10 introduces **Autonomous Agents** — intelligent systems that leverage Phase 9's ML models and recommendations to autonomously execute operational decisions across cost optimization, crew scheduling, and anomaly response. These agents operate within configurable risk profiles, automatically approve low-risk actions, and escalate high-stakes decisions to humans for review.

**Key Objective**: Transform FinOps from reactive (alerts + manual response) to proactive (agents constantly optimizing) and autonomous (self-executing decisions within guardrails).

---

## Architecture

### Autonomous Agent Framework

```
┌─────────────────────────────────────────────────────────────────┐
│                   Autonomous Agent Layer                         │
├─────────────────────────────────────────────────────────────────┤
│  Decision Engine       Execution Engine      Approval Gates      │
│  ┌──────────────┐     ┌──────────────┐     ┌────────────────┐   │
│  │ Propose      │────▶│ Auto-Approve │────▶│ Risk Scoring   │   │
│  │ Decision     │     │ or Escalate  │     │ Threshold Gate │   │
│  └──────────────┘     └──────────────┘     └────────────────┘   │
│         ▲                     │                      ▲            │
│         │                     ▼                      │            │
│    Phase 9 ML           Execute Action         Manual Review     │
│    Insights             Record Results         (High Risk)       │
│    & Forecasts          Update Metrics         Audit Log         │
└─────────────────────────────────────────────────────────────────┘
     │                                               │
     ▼                                               ▼
 Phase 6-9                                    Human Operators
 Intelligence                                 Approvers
```

### Four Agent Types

1. **Cost Optimization Agent**
   - Auto-rightsizes resources based on utilization forecasts
   - Executes purchasing optimizations
   - Identifies and eliminates waste
   - Decision: Auto-execute if savings > threshold and confidence > 0.85

2. **Crew Scheduling Agent**
   - Optimizes shifts for demand, fatigue, and cost
   - Balances coverage with crew wellbeing
   - Suggests swaps and redistributions
   - Decision: Auto-apply if coverage maintained and fatigue reduced

3. **Anomaly Response Agent**
   - Auto-diagnoses operational anomalies
   - Executes remediation workflows
   - Escalates unknown/high-impact anomalies
   - Decision: Auto-remediate if success rate > 90% historically

4. **Workflow Automation Agent**
   - Chains decisions across agent types
   - Coordinates multi-step optimizations
   - Tracks cross-functional impact
   - Decision: Requires approval for expensive multi-step changes

---

## Core Components

### 1. autonomousAgents.ts (700 LOC)

**Core Agent Lifecycle**

```typescript
interface Agent {
  id: string
  organizationId: string
  name: string
  type: 'cost_optimization' | 'crew_scheduling' | 'capacity_planning' | 'anomaly_response' | 'workflow_automation'
  status: 'active' | 'paused' | 'suspended'
  riskProfile: 'conservative' | 'balanced' | 'aggressive'
  autoApprovalThreshold: number // max cost per auto-approved action ($)
  executionMode: 'dry_run' | 'manual_approval' | 'autonomous'
  metrics: {
    decisionsProposed: number
    decisionsExecuted: number
    decisionsRejected: number
    actionsSuccessful: number
    actionsFailed: number
    totalSavingsGenerated: number
    successRate: number // 0-1
  }
}
```

**Decision Proposal & Approval Flow**

```
proposeDecision()
  ├─ Calculate riskScore (0-1)
  ├─ Evaluate estimatedCost vs. autoApprovalThreshold
  ├─ Auto-approve if riskScore ≤ 0.7 AND cost ≤ threshold
  └─ Return: Decision (proposed | approved)

approveDecision()
  └─ Set: approvedByUserId, approvedAt, status='approved'

executeDecision()
  └─ Record: result.success, result.actualCost
  └─ Update: agent.metrics (successRate, totalSavings)
  └─ Return: Decision with outcome
```

**Key Functions**

- `createAgent()` — Initialize agent with risk profile and execution mode
- `proposeDecision()` — Propose action; auto-approve if low-risk
- `approveDecision()` / `rejectDecision()` — Human override
- `executeDecision()` — Execute approved decision, record outcome
- `recordExecution()` — Batch execution summary (useful for cron runs)
- `recordPerformance()` — Daily/weekly/monthly agent effectiveness snapshot
- `getPerformance()` — Query agent metrics over time

**Retention Policy**

- Decisions: last 5000 per organization (FIFO)
- Executions: last 1000 per organization (FIFO)
- Performance: last 500 monthly metrics per organization

---

### 2. autonomousCostOptimization.ts (650 LOC)

**Cost Optimization Actions**

Autonomous cost-saving actions covering:
- **Right-sizing**: VM/container memory/CPU based on utilization history
- **Consolidation**: Merging underutilized resources
- **Scheduling**: Running batch jobs in off-peak windows
- **Purchasing**: Bulk discounts, reserved instances, spot instances
- **Waste Elimination**: Unused storage, orphaned resources, idle databases

```typescript
interface CostOptimizationAction {
  id: string
  type: 'right_sizing' | 'resource_consolidation' | 'scheduling_optimization' | 'purchasing_optimization' | 'waste_elimination'
  targetResource: string
  estimatedMonthlySavings: number
  confidence: number // 0-1
  paybackMonths?: number // implementationCost / estimatedMonthlySavings
  status: 'proposed' | 'approved' | 'executing' | 'completed' | 'failed' | 'rolled_back'
  actualSavings?: number // tracked post-execution
}
```

**Optimization Strategies**

Organizations define reusable strategies:

```typescript
interface CostOptimizationStrategy {
  name: string
  type: 'continuous' | 'periodic' | 'threshold_based'
  targetMetrics: string[] // e.g., ['cpu_utilization', 'memory_waste']
  optimizationRules: Array<{
    condition: string // e.g., "avg_cpu_utilization < 20% for 7 days"
    action: string // e.g., "downsize VM by 1 tier"
    riskLevel: 'low' | 'medium' | 'high'
  }>
  targetSavingsPerMonth: number
}
```

Strategies run on schedule (e.g., daily/weekly):

1. **Continuous**: Agent polls metrics every N minutes
2. **Periodic**: Scheduled daily/weekly optimization run
3. **Threshold-based**: Triggered when metric crosses threshold

**Wastage Analysis**

Agent analyzes resource consumption patterns:

```typescript
analyzeWastage(
  resourceType: 'storage' | 'compute' | 'bandwidth' | 'licenses'
  currentUsage: number
  optimalUsage: number // derived from forecasts + safety margin
  commonPatterns: string[] // ['seasonal_spike', 'unused_daily_between_22-6', ...]
  recommendations: [{ title, estimatedSavings }, ...]
)
```

Output helps humans understand *why* resources are oversized and *when* they're actually needed.

**Key Functions**

- `createOptimizationAction()` — Propose action; auto-approve if high-confidence
- `executeOptimizationAction()` — Execute and track actual savings
- `createStrategy()` — Define reusable optimization rules
- `recordOptimizationRun()` — Summary of strategy execution (actions proposed, executed, actual savings)
- `analyzeWastage()` — Diagnose waste patterns and suggest actions
- `getWastageAnalyses()` — Track wastage trends over time

**Auto-Approval Logic**

```
execute = confidence > 0.85
       && estimatedCost < strategy.budget
       && !estimatedCost // no implementation cost, or low cost
       && agent.executionMode != 'manual_approval'
```

---

### 3. autonomousScheduling.ts (650 LOC)

**Scheduling Optimization**

Agent autonomously optimizes crew schedules across four dimensions:

1. **Demand Matching**: Adjust staffing to forecasted demand
2. **Fatigue Optimization**: Reduce cumulative fatigue via smarter shifts
3. **Cost Optimization**: Lower overtime, premium shifts
4. **Coverage Balancing**: Ensure expertise distribution and compliance

```typescript
interface SchedulingOptimization {
  optimizationType: 'demand_matching' | 'fatigue_optimization' | 'cost_optimization' | 'coverage_balancing'
  proposedChanges: Array<{
    crewMemberId: string
    currentShift: string
    proposedShift: string
    reason: string // e.g., "demand forecast shows 30% lower need 2-4pm"
  }>
  estimatedCostSavings: number
  estimatedFatigueReduction: number // 0-100
  estimatedCoverageImprovement: number // 0-100
  confidence: number // 0-1
  riskFactors: string[] // e.g., ["new_schedule_untested", "swaps_for_2_crew_members"]
}
```

**Demand Forecasting**

Agent uses Phase 9 forecasts to predict demand:

```typescript
interface DemandForecast {
  date: Date
  timeSlot: string // "14:00" (hourly granularity)
  expectedDemand: number // tasks/calls/jobs expected
  requiredStaff: number // derived from demand / avg_task_per_hour
  availableStaff: number // current schedule
  coverageGap: number // max(0, requiredStaff - availableStaff)
  confidenceLevel: number // 0-1
  historicalAccuracy: number // actual demand vs. forecast last month
}
```

Agent runs every 6 hours and proposes optimizations:

- If `coverageGap > 0` and `cost_of_extra_shift < potential_SLA_miss_cost`: suggest additional shift
- If `expectedDemand` drops 30%: suggest shift swaps or reduced hours
- If crew member's fatigue trending high: swap to lighter shifts or days off

**Shift Assignment & Completion Tracking**

```typescript
interface ShiftAssignment {
  crewMemberId: string
  shiftId: string
  estimatedFatigueLevel: number // 0-100, predicted
  costImpact: number // $, incremental cost vs. baseline
  coverageScore: number // 0-1, how well this assignment covers gaps
  status: 'scheduled' | 'confirmed' | 'completed' | 'cancelled'
  actualFatigueLevel?: number // recorded post-shift by worker or system
}
```

**Impact Reporting**

Daily/weekly/monthly reports track optimization outcomes:

```typescript
interface ScheduleImpactReport {
  period: 'daily' | 'weekly' | 'monthly'
  optimizationsApplied: number
  totalCostSavings: number
  averageFatigueReduction: number // 0-100
  coverageImprovement: number // 0-100, % of gaps closed
  crewSatisfactionImpact: number // -1 to 1, from surveys/feedback
  complianceViolations: number // labor law, union rules
  swapRequestsFulfilled: number // how many crew swap requests agent fulfilled
}
```

**Auto-Approval Logic**

```
execute = confidence > 0.9
       && fatigueReduction > 5
       && costSavings > 0
       && coverageGap <= 0 (no worsening)
       && agent.executionMode != 'manual_approval'
```

---

### 4. autonomousAnomalyResponse.ts (650 LOC)

**Incident Lifecycle**

```
Detected → Investigating → Diagnosed → Remediating → Resolved
              ↓                          ↓
         (escalate)                 (escalate)
              ↓                          ↓
          Escalated to Human          Escalated to Human
```

**Anomaly Incident**

```typescript
interface AnomalyIncident {
  anomalyId: string // from Phase 9
  metric: string // e.g., "cpu_utilization", "query_latency"
  severity: 'low' | 'medium' | 'high' | 'critical'
  detectionConfidence: number // 0-1
  baselineValue: number
  currentValue: number
  deviation: number // % change
  rootCauseHypotheses: Array<{
    cause: string
    probability: number // 0-1
    suggestedAction: string
  }>
  status: 'detected' | 'investigating' | 'diagnosed' | 'remediating' | 'resolved' | 'escalated'
  rootCauseDiagnosis?: { cause, confidence, evidence[] }
  remediationAction?: string
  escalatedToUserId?: string // if human escalation needed
}
```

**Root Cause Diagnosis**

Agent uses Phase 9 insights to diagnose:

1. **Historical Pattern Matching**: "CPU spike at 14:00 every Tuesday → scheduled batch job"
2. **Correlation Analysis**: "Query latency spike correlates with backup job start"
3. **Regression Model**: "Anomaly follows error rate increase from new deployment 2h ago"
4. **Threshold Breach**: "Latency 95th percentile exceeded 2σ threshold"

Each diagnosis includes:
- Root cause string
- Confidence level (0-1)
- Evidence list: ["error logs show exception X", "metric Y trending Y%, "deployment Z at time T", ...]

**Remediation Workflows**

Pre-defined workflows for common incidents:

```typescript
interface RemediationWorkflow {
  name: string // e.g., "High CPU - Scale Out"
  applicableAnomalies: string[] // metrics this applies to
  remediationSteps: Array<{
    step: number
    action: string // e.g., "trigger autoscale group to +2 instances"
    riskLevel: 'low' | 'medium' | 'high'
    estimatedDurationMs: number
    rollbackProcedure?: string
  }>
  estimatedResolutionTimeMs: number
  successRate: number // 0-1, from historical execution
  enabled: boolean
}
```

**Incident Reports**

After resolution, agent generates incident report:

```typescript
interface IncidentReport {
  title: string
  severity: 'low' | 'medium' | 'high' | 'critical'
  startTime: Date
  endTime: Date
  duration: number // ms
  affectedServices: string[]
  affectedUsers: number
  rootCause: string
  resolution: string
  timeline: Array<{ timestamp, event, actor? }>
  actionItems: Array<{ action, assignedTo?, dueDate?, completed? }>
  postmortemNotes?: string // for critical incidents
}
```

Used for compliance, learning, and post-incident review.

**Response Metrics**

Track anomaly response effectiveness:

```typescript
interface ResponseMetrics {
  period: 'day' | 'week' | 'month'
  anomaliesDetected: number
  anomaliesInvestigated: number
  anomalyResolutionRate: number // 0-1
  averageTimeToDetect: number // ms, from anomaly to start investigation
  averageTimeToResolve: number // ms, from detection to resolved/escalated
  remediationSuccessRate: number // 0-1, auto-executed resolutions that fixed issue
  escalationRate: number // 0-1, incidents that required human intervention
  preventiveActionsTaken: number // proactive mitigations before incident occurs
  costsSavedByAutomation: number // estimated SLA miss costs prevented
}
```

**Auto-Escalation Rules**

```
escalate = severity == 'critical'
        || rootCauseConfidence < 0.6
        || remediationSuccessRate < 0.75
        || estimatedImpact > org.incident_threshold
```

---

## REST API

### Agent Management

**Create Agent**
```
POST /api/ops/agents/agents
{
  organizationId: "org-123",
  name: "Cost Optimizer - Prod",
  type: "cost_optimization",
  riskProfile: "balanced",
  autoApprovalThreshold: 5000, // $ per action
  executionMode: "autonomous",
  config: { strategy_ids: ["strat-1", "strat-2"] }
}
→ { id, status, metrics, createdAt, ... }
```

**Get Agents**
```
GET /api/ops/agents/agents/:organizationId?type=cost_optimization
→ [Agent, ...]
```

**Update Agent Status**
```
PUT /api/ops/agents/agents/:organizationId/:agentId/status
{ status: "paused" }
→ { success: true }
```

### Decision Management

**Propose Decision**
```
POST /api/ops/agents/agents/:organizationId/:agentId/decisions
{
  type: "right_sizing",
  priority: "medium",
  riskScore: 0.65,
  proposedAction: {
    title: "Downsize prod-db-2",
    description: "CPU utilization <15% for 30 days",
    estimatedImpact: { monthly_savings: 800 },
    estimatedCost: 0,
    rollbackPlan: "Scale back up if query latency exceeds threshold"
  }
}
→ { id, status: "approved" | "proposed", approvalRequiredReason?, ... }
```

**Get Decisions**
```
GET /api/ops/agents/agents/:organizationId/:agentId/decisions?status=proposed
→ [Decision, ...]
```

**Approve / Reject Decision**
```
POST /api/ops/agents/agents/:organizationId/:agentId/decisions/:decisionId/approve
{ userId: "user-456" }
→ { success: true }

POST /api/ops/agents/agents/:organizationId/:agentId/decisions/:decisionId/reject
{ reason: "Waiting for maintenance window next week" }
→ { success: true }
```

**Execute Decision**
```
POST /api/ops/agents/agents/:organizationId/:agentId/decisions/:decisionId/execute
{
  success: true,
  message: "Downsize completed; db responding normally",
  actualCost: 0 // actual cost incurred (for reversals, etc.)
}
→ { decision with result, updatedMetrics, ... }
```

### Cost Optimization

**Create Optimization Action**
```
POST /api/ops/agents/optimization/actions
{
  organizationId, agentId,
  type: "right_sizing",
  targetResource: "prod-db-2",
  targetMetric: "memory_utilization",
  currentValue: 16384, // MB
  proposedValue: 8192,
  estimatedMonthlySavings: 800,
  confidence: 0.92,
  implementationCost: 0
}
→ { id, status: "approved" | "proposed", estimatedCost, paybackMonths, ... }
```

**Get Optimization Actions**
```
GET /api/ops/agents/optimization/actions/:organizationId?agentId=...&type=...
→ [CostOptimizationAction, ...]
```

**Execute Optimization Action**
```
POST /api/ops/agents/optimization/actions/:organizationId/:actionId/execute
{
  success: true,
  actualSavings: 810 // slightly higher than estimate
}
→ { success: true, updatedAction }
```

**Create Strategy**
```
POST /api/ops/agents/optimization/strategies
{
  organizationId,
  name: "Right-Size Underutilized VMs",
  description: "Automatically downsize VMs with <20% CPU for 7+ days",
  type: "continuous",
  targetMetrics: ["cpu_utilization", "memory_utilization"],
  optimizationRules: [
    {
      condition: "avg_cpu_utilization < 20% for 7 days",
      action: "downsize by 1 tier",
      riskLevel: "low"
    }
  ],
  targetSavingsPerMonth: 10000
}
→ { id, enabled: true, createdAt, ... }
```

**Analyze Wastage**
```
POST /api/ops/agents/optimization/wastage
{
  organizationId, agentId,
  resourceType: "storage",
  currentUsage: 5000, // GB
  optimalUsage: 1500,
  commonPatterns: ["seasonal_spike_mar_may", "unused_daily_22-6"],
  recommendations: [
    { title: "Archive old backups", estimatedSavings: 2000 },
    { title: "Enable compression", estimatedSavings: 500 }
  ]
}
→ { id, wastePercentage: 70%, estimatedMonthlyWaste: 3500, ... }
```

### Autonomous Scheduling

**Propose Scheduling Optimization**
```
POST /api/ops/agents/scheduling/optimizations
{
  organizationId, agentId, workspaceId,
  optimizationType: "demand_matching",
  proposedChanges: [
    {
      crewMemberId: "crew-1",
      currentShift: "08:00-16:00",
      proposedShift: "10:00-18:00",
      reason: "Demand forecast shows 40% fewer tasks 8-10am, peak 2-6pm"
    }
  ],
  estimatedCostSavings: 200,
  estimatedFatigueReduction: 15,
  estimatedCoverageImprovement: 5,
  confidence: 0.88,
  riskFactors: ["untested_schedule", "crew_1_prefers_early_shifts"]
}
→ { id, status: "approved" | "proposed", ... }
```

**Get Scheduling Optimizations**
```
GET /api/ops/agents/scheduling/optimizations/:organizationId?agentId=...&status=...
→ [SchedulingOptimization, ...]
```

**Apply Optimization**
```
POST /api/ops/agents/scheduling/optimizations/:organizationId/:optimizationId/apply
{
  actualCostSavings: 220,
  actualFatigueReduction: 18,
  actualCoverageImprovement: 4
}
→ { success: true }
```

**Create Shift Assignment**
```
POST /api/ops/agents/scheduling/assignments
{
  organizationId,
  crewMemberId: "crew-1",
  shiftId: "shift-morning-1",
  startTime: "2026-09-20T08:00:00Z",
  endTime: "2026-09-20T16:00:00Z",
  estimatedFatigueLevel: 35, // 0-100
  costImpact: -50, // $ vs. baseline
  coverageScore: 0.92, // 0-1
  assignmentReason: "Covers morning spike; crew member fresh"
}
→ { id, status: "scheduled", ... }
```

**Record Demand Forecast**
```
POST /api/ops/agents/scheduling/demand-forecast
{
  organizationId, workspaceId,
  date: "2026-09-20",
  timeSlot: "14:00",
  expectedDemand: 120,
  requiredStaff: 4,
  availableStaff: 3,
  confidenceLevel: 0.87,
  historicalAccuracy: 0.91
}
→ { id, coverageGap: 1, ... }
```

**Record Schedule Impact**
```
POST /api/ops/agents/scheduling/impact
{
  organizationId, agentId,
  period: "daily",
  optimizationsApplied: 3,
  totalCostSavings: 450,
  averageFatigueReduction: 12,
  coverageImprovement: 8,
  crewSatisfactionImpact: 0.15, // +15%
  complianceViolations: 0,
  swapRequestsFulfilled: 2
}
→ { id, date, ... }
```

### Anomaly Response

**Create Anomaly Incident**
```
POST /api/ops/agents/anomalies/incidents
{
  organizationId, agentId,
  anomalyId: "anom-456",
  metric: "query_latency_p95",
  severity: "high",
  detectionConfidence: 0.89,
  baselineValue: 50, // ms
  currentValue: 180,
  rootCauseHypotheses: [
    {
      cause: "New batch job started at 14:02",
      probability: 0.75,
      suggestedAction: "Pause batch job, deprioritize, or scale resources"
    },
    {
      cause: "Database connection pool exhaustion",
      probability: 0.45,
      suggestedAction: "Increase pool size or add read replicas"
    }
  ]
}
→ { id, status: "detected", deviation: 260, ... }
```

**Start Investigation**
```
POST /api/ops/agents/anomalies/incidents/:organizationId/:incidentId/investigate
→ { success: true, status: "investigating" }
```

**Record Diagnosis**
```
POST /api/ops/agents/anomalies/incidents/:organizationId/:incidentId/diagnose
{
  cause: "New batch job started at 14:02, scanning full table without index",
  confidence: 0.92,
  evidence: [
    "Batch job logs show table scan at 14:02:15",
    "Database slow query log shows sequential scan on orders table",
    "Timeline: latency spike starts 14:02:30, 15s after job start"
  ]
}
→ { success: true, status: "diagnosed" }
```

**Start Remediation**
```
POST /api/ops/agents/anomalies/incidents/:organizationId/:incidentId/remediate
{
  action: "Pause batch job; scale read replicas from 2→4; adjust query optimizer hints"
}
→ { success: true, status: "remediating" }
```

**Resolve Incident**
```
POST /api/ops/agents/anomalies/incidents/:organizationId/:incidentId/resolve
→ { success: true, status: "resolved" }
```

**Escalate Incident (High Risk)**
```
POST /api/ops/agents/anomalies/incidents/:organizationId/:incidentId/escalate
{
  userId: "user-ops-lead",
  reason: "Batch job impact unquantified; unknown cascade risk to other services"
}
→ { success: true, status: "escalated" }
```

**Create Remediation Workflow**
```
POST /api/ops/agents/anomalies/workflows
{
  organizationId, agentId,
  name: "High Query Latency - Scale Query Tier",
  applicableAnomalies: ["query_latency_p95", "query_latency_p99"],
  remediationSteps: [
    {
      step: 1,
      action: "Promote read replica to write-capable instance",
      riskLevel: "medium",
      estimatedDurationMs: 30000,
      rollbackProcedure: "Demote back to read replica"
    },
    {
      step: 2,
      action: "Update connection pool to use new instance",
      riskLevel: "low",
      estimatedDurationMs: 5000
    }
  ],
  estimatedResolutionTimeMs: 35000,
  successRate: 0.94
}
→ { id, enabled: true, ... }
```

**Generate Incident Report**
```
POST /api/ops/agents/anomalies/reports
{
  organizationId, agentId, incidentId,
  title: "Query Latency Spike - 2026-09-20 14:02-14:35",
  severity: "high",
  affectedServices: ["api-v2", "dashboard", "reports"],
  affectedUsers: 450,
  rootCause: "Unoptimized batch table scan on busy database",
  resolution: "Paused batch job; promoted read replica; queries normalized within 5 minutes",
  timeline: [
    { timestamp: "14:02:00", event: "Batch job started" },
    { timestamp: "14:02:30", event: "Query latency p95 rises to 180ms" },
    { timestamp: "14:03:00", event: "Alert triggered; anomaly agent started investigation" },
    { timestamp: "14:05:00", event: "Root cause diagnosed" },
    { timestamp: "14:06:00", event: "Batch job paused; latency normalizes" }
  ]
}
→ { id, startTime, endTime, duration, ... }
```

**Record Response Metrics**
```
POST /api/ops/agents/anomalies/response-metrics
{
  organizationId, agentId,
  period: "daily",
  anomaliesDetected: 12,
  anomaliesInvestigated: 11,
  averageTimeToDetect: 45000, // ms
  averageTimeToResolve: 180000,
  remediationSuccessRate: 0.92,
  escalationRate: 0.08,
  preventiveActionsTaken: 2,
  costsSavedByAutomation: 15000
}
→ { id, anomalyResolutionRate: 0.92, averageTimeToDetect, ... }
```

### Performance & Testing

**Get Agent Performance**
```
GET /api/ops/agents/agents/:organizationId/:agentId/performance?days=30
→ [AgentPerformance, ...] // daily/weekly snapshots
```

**Clear All Data (Testing)**
```
POST /api/ops/agents/clear-all
→ { message: "All Phase 10 data cleared" }
```

---

## Integration Patterns

### With Phase 9: ML & Recommendations

```typescript
// Phase 9 identifies savings opportunity
const rec = generateRecommendation(
  org, 'resource_optimization', 'Downsize prod-db-2',
  'Database CPU <15% for 30 days', 'resource_optimization',
  'medium', 800, 0 // no implementation cost
)

// Phase 10 agent proposes decision based on recommendation
const decision = proposeDecision(org, agent, 'optimize', 'medium', 0.65, {
  title: rec.title,
  description: rec.description,
  estimatedImpact: { monthly_savings: rec.estimatedMonthlySavings },
  estimatedCost: 0
})

// If auto-approved, execute immediately
if (decision.status === 'approved') {
  executeOptimizationAction(org, action.id, true, 810)
}
```

### With Phase 8: Integration & Webhooks

```typescript
// Cost optimization runs daily via scheduled webhook
POST /api/ops/agents/optimization/runs
{
  strategyId, actionsProposed, actionsExecuted, ...
}

// Phase 8 webhook triggers Phase 10 agent
// Example: daily 05:00 UTC cron → invoke all enabled agents
// Results fed back to dashboards (Phase 7)
```

### With Phase 6: Governance & RBAC

```typescript
// Only users with role='cost_admin' or 'ops_lead' can:
// - Reject high-risk decisions
// - Pause cost optimization agents
// - Escalate anomalies manually

// Audit log (Phase 6) captures:
// - Decision proposals (agent-generated)
// - Approvals (human-reviewed)
// - Executions (success/failure)
// - Metrics (agent performance)
```

### With Phase 7: Self-Service Portal

```typescript
// Users see on Operations Dashboard:
// - Agent Status: active/paused/suspended
// - Recent Decisions: proposed, approved, executed
// - Savings This Month: cost agent total
// - Open Incidents: anomalies awaiting escalation
// - Schedule Health: crew agent fatigue/coverage metrics

// Users can:
// - View proposed decisions before auto-approval
// - Approve/reject pending decisions
// - Pause agent if behavior drifts
// - Export incident reports for compliance
```

---

## Decision Auto-Approval Matrix

### Risk Scoring Formula

```
riskScore = (CONFIDENCE_INVERSE × 0.3)
          + (COST_RATIO × 0.3)
          + (IMPACT_SEVERITY × 0.2)
          + (UNTESTED_NOVELTY × 0.2)

where:
  CONFIDENCE_INVERSE = 1 - modelConfidence
  COST_RATIO = estimatedCost / org.monthly_budget
  IMPACT_SEVERITY = severity_scale(proposed_change)
  UNTESTED_NOVELTY = 1 if no prior success rate history else 0
```

### Auto-Approval Thresholds by Agent Type

| Agent Type | Risk Profile | Auto-Approve If | Manual Approval If |
|---|---|---|---|
| **Cost Optimization** | Conservative | cost ≤ $1000 & risk ≤ 0.5 | cost > $1000 or risk > 0.5 |
| | Balanced | cost ≤ $5000 & risk ≤ 0.7 | cost > $5000 or risk > 0.7 |
| | Aggressive | cost ≤ $20000 & risk ≤ 0.8 | cost > $20000 or risk > 0.8 |
| **Scheduling** | Conservative | fatigue gain & confidence > 0.9 | any risk factor present |
| | Balanced | fatigue gain & confidence > 0.85 | confidence < 0.85 or risk > 0.6 |
| | Aggressive | confidence > 0.8 & coverage OK | confidence < 0.8 |
| **Anomaly Response** | Conservative | success_rate > 0.95 & severity ≤ medium | severity > medium or untested |
| | Balanced | success_rate > 0.85 & severity ≤ high | severity > high or rate < 0.85 |
| | Aggressive | success_rate > 0.75 | success_rate < 0.75 |

---

## Monitoring & SLOs

### Agent Effectiveness Metrics

**Execution Rate**
- Target: >80% of proposed decisions executed
- Red: <60% (indicates frequent rejections or escalations)
- Investigate: Policy too conservative, or decisions poorly calibrated

**Success Rate**
- Target: >85% of executed actions achieve desired outcome
- Red: <75% (indicates poor prediction or execution)
- Investigate: Remodel, add guardrails, increase manual approval threshold

**Autonomy Level**
- Target: >70% of decisions auto-approved
- Red: <40% (indicates excessive escalations)
- Investigate: Lower risk thresholds, or rebalance approval gates

**Time to Resolution**
- **Anomaly Detection→Investigation**: Target <5 min
- **Investigation→Diagnosis**: Target <30 min
- **Diagnosis→Remediation**: Target <5 min
- **Remediation→Resolved**: Target <30 min

### Cost Impact

- **Savings Generated** (cost optimization agent):
  - Cumulative monthly savings vs. estimated forecasts
  - Variance tracking (estimate vs. actual)

- **Cost of Failures** (anomaly response agent):
  - SLA miss costs prevented
  - Downtime minutes avoided
  - Manual escalation costs (labor)

---

## Operational Patterns

### Daily Agent Runs

```
05:00 UTC: Cost Optimization
  - Analyze utilization trends from past 24h
  - Propose right-sizing actions
  - Auto-execute low-risk actions (>0.85 confidence)
  - Record daily performance snapshot

08:00 UTC: Scheduling Optimization
  - Forecast demand for next 7 days
  - Compare with current schedule
  - Propose shift swaps, additional shifts, or reductions
  - Auto-apply if crew fatigue improves & coverage maintained

12:00 UTC: Anomaly Response Batch
  - Review unresolved incidents >2h old
  - Re-diagnose if initial diagnosis < 0.7 confidence
  - Escalate if no clear root cause by 4h mark
  - Generate daily incident summary report

20:00 UTC: Weekly Performance Report (Sundays)
  - Aggregate metrics across all agents
  - Identify trends: improving/degrading success rates
  - Flag agents needing recalibration
  - Publish to admin dashboard for human review
```

### Manual Escalation Workflow

1. **Agent proposes decision** (auto-approval gates: riskScore, cost, confidence)
2. **Decision marked "proposed"** (requires human approval)
3. **Notification sent** to assigned approver (email + dashboard)
4. **Approver reviews** decision details, proposed changes, risk factors
5. **Approver approves/rejects** with optional comment
6. **Approved decision → Execute immediately** (agent runs execution logic)
7. **Rejected decision → Record reason** (used for agent recalibration)

---

## Best Practices

### For Operators

1. **Start Conservative**: Set `riskProfile='conservative'` initially
   - Observe agent behavior for 2-4 weeks
   - Track false positives, false negatives, cost impact

2. **Monitor Approval Rates**: If >40% escalations
   - Re-examine decision quality
   - Adjust risk thresholds upward or remodel
   - Check for policy conflicts

3. **Audit Rejected Decisions**: Review why humans reject agent proposals
   - Patterns reveal missed constraints or business rules
   - Feed back into agent config/rules

4. **Use Dry-Run Mode**: Deploy agents in `dry_run` mode first
   - Log all proposed decisions without executing
   - Validate decision quality before flipping to `autonomous`

### For Developers

1. **Root Cause Validation**: For anomaly diagnosis
   - Ensure evidence supports diagnosis (don't just guess)
   - Prefer multiple evidence sources over single signal

2. **Remediation Success Rates**: Track before auto-executing
   - Workflows <85% success rate should require approval
   - Update success rates weekly as new data arrives

3. **Cascading Failures**: Consider cross-agent impact
   - Scaling up (cost optimization) may increase scheduling complexity
   - Scheduling swaps affect fatigue forecasts
   - Document dependencies

---

## Troubleshooting

### Agent Proposes Suboptimal Actions

**Symptom**: Cost agent proposes right-sizing that humans reject

**Root Cause**: Utilization data insufficient or seasonal bias not accounted for

**Fix**:
1. Increase `confidence` threshold from 0.85 → 0.92
2. Require 60 days of history (not 30) for right-sizing
3. Add seasonal adjustment to baseline calculation

### High Escalation Rate

**Symptom**: >50% of decisions require manual approval

**Root Cause**: Risk threshold too conservative or cost threshold too low

**Fix**:
1. Increase `autoApprovalThreshold` by 50%
2. Lower `riskProfile` from 'conservative' → 'balanced'
3. Review rejected decisions: are humans approving them later? If so, lower threshold further.

### Agent Produces Conflicting Decisions

**Symptom**: Scheduling agent suggests higher staffing while cost agent suggests rightsizing

**Root Cause**: Agents unaware of each other; constraints not shared

**Fix**:
1. Add agent-to-agent communication: cost agent notifies scheduling of savings estimates
2. Scheduling agent adjusts resource requests based on cost constraints
3. Use workflow automation agent to coordinate multi-agent decisions

---

## Data Retention

| Data Type | Retention | Cleanup Strategy |
|---|---|---|
| Decisions | Last 5,000 | FIFO (oldest discarded) |
| Executions | Last 1,000 per org | FIFO |
| Performance Metrics | Last 500 per org | FIFO (keep 1yr+) |
| Incidents | Last 2,000 per org | FIFO |
| Incident Reports | Last 1,000 per org | Archive after 1yr |
| Shift Assignments | Last 5,000 per org | FIFO |
| Optimization Actions | Last 1,000 per org | FIFO |
| Wastage Analyses | Last 1,000 per org | FIFO |

---

## Phase 10 Completion Checklist

✅ Autonomous Agents framework (agent lifecycle, decision lifecycle, approval gates)  
✅ Cost Optimization Agent (rightsizing, consolidation, purchasing, waste elimination)  
✅ Scheduling Agent (demand matching, fatigue optimization, cost optimization, coverage)  
✅ Anomaly Response Agent (diagnosis, remediation, escalation, incident reporting)  
✅ 60+ REST endpoints for all four agent types  
✅ Integration with Phase 9 (ML models, recommendations)  
✅ RBAC enforcement (Phase 6 governance)  
✅ Audit logging (all decisions, approvals, executions)  
✅ Performance metrics and SLOs  
✅ Dry-run mode for safe testing  
✅ Comprehensive documentation  

---

## Next Steps (Phase 11+)

- **Autonomous Capacity Planning**: Predict and pre-emptively scale infrastructure
- **Autonomous Chargeback Enforcement**: Auto-invoice departments for resource usage
- **Autonomous Compliance Monitoring**: Self-audit against security/regulatory policies
- **Multi-Agent Coordination**: Resolve conflicts between agents automatically
- **Natural Language Explanations**: Agents explain decisions in plain English for non-technical users
