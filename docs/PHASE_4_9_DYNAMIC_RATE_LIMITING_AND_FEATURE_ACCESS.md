# Phase 4.9: Dynamic Rate Limiting and Feature Access Control

**Last Updated:** 2026-09-19  
**Status:** Complete  
**Phase Goal:** Implement token bucket rate limiting with request prioritization, time-of-day pricing multipliers, and budget-driven feature degradation to control resource consumption and ensure fair allocation across workspaces.

## Executive Summary

Phase 4.9 closes the feedback loop from cost control to cost prevention by implementing two critical systems:

1. **Dynamic Rate Limiting** — Token bucket algorithm with priority-based request queuing and time-of-day multipliers for fair allocation and peak-hour cost management.
2. **Feature Access Control** — Plan tier matrices with budget-driven degradation that progressively disables non-critical features as budget depletes, maintaining service stability while preventing runaway costs.

This phase transforms budgets (4.8) from policy enforcement to actual operational limits, preventing cost overruns before they happen.

## Architecture Overview

### Rate Limiting System

The rate limiting system uses the **token bucket algorithm** for fairness and proven production reliability:

```
┌─────────────────────────────────────────┐
│     RateLimitBucket (per workspace)     │
├─────────────────────────────────────────┤
│ capacity: 1000 tokens (max)             │
│ refillRate: 10 tokens/sec               │
│ tokens: (auto-refilled over time)       │ ◄── refillTokens() called on each check
│ lastRefillAt: (timestamp)               │
├─────────────────────────────────────────┤
│ consumeTokens(50)                       │
│   ✓ if tokens >= 50: deduct & allow    │
│   ✗ if tokens < 50: queue & defer      │
└─────────────────────────────────────────┘

Time-based Refill:
  tokens = min(capacity, tokens + (secondsElapsed × refillRate))
  
Example: 5 seconds elapsed, refillRate=10 tokens/sec
  tokens = min(1000, current + (5 × 10)) = min(1000, current + 50)
```

### Feature Access Control System

Features are organized in a **plan tier matrix** with **degradation order** controlling which features disable first when budget is tight:

```
Free Tier ($0/month, 100 req/min):
  ✓ basic_api (order 1, critical)
  ✓ email_notifications (order 2, core)

Starter Tier ($99/month, 1000 req/min):
  ✓ All free features
  ✓ slack_integration (order 3)
  ✓ advanced_analytics (order 4)
  ✓ realtime_sync (order 6)
  ✓ data_export (order 5)

Growth Tier ($499/month, 10000 req/min):
  ✓ All starter features
  ✓ ml_training (order 9, expensive)
  ✓ custom_webhooks (order 7)
  ✓ audit_logs (order 8)
```

**Degradation Thresholds** (based on budget remaining):

- **>75% budget remaining:** All features enabled (no degradation)
- **50-75% remaining:** Disable features with `degradationOrder > 7` (optional features only)
- **25-50% remaining:** Disable features with `degradationOrder > 5` (optional + analytics)
- **10-25% remaining:** Disable features with `degradationOrder > 3` (keep critical + notifications)
- **<10% remaining:** Only keep critical features (`degradationOrder <= 1`)

### Time-of-Day Pricing

The system applies **cost and capacity multipliers** based on current hour to incentivize off-peak usage:

```
00:00-06:00 (night):    refill × 0.5  |  cost × 0.5   (off-peak discount)
06:00-09:00 (morning):  refill × 1.0  |  cost × 1.0   (normal)
09:00-17:00 (business): refill × 1.5  |  cost × 1.5   (peak pricing)
17:00-20:00 (evening):  refill × 1.0  |  cost × 1.0   (normal)
20:00-24:00 (night):    refill × 0.7  |  cost × 0.7   (off-peak discount)
```

Example: A request normally costing $0.001 costs $0.0005 at 2 AM (× 0.5), but $0.0015 at 2 PM (× 1.5).

### Request Queuing

When tokens are unavailable, requests are queued with three priority levels:

```
Priority: critical → normal → bulk
Oldest critical requests processed first (after critical queue empty)
                            ↓
                    normal requests (queue order)
                            ↓
                      bulk requests (dropped first if queue exceeds MAX_QUEUE_SIZE)

Queue Management:
  - Max 100,000 requests per queue
  - Auto-truncate: sort by priority, remove oldest bulk requests if full
  - Per-request timeout: default 5 minutes (300,000 ms)
```

## API Endpoints

### Rate Limit Bucket Management

#### POST /api/ops/ratelimit/:workspaceId/buckets
Create a new rate limit bucket for a workspace/team/endpoint.

**Request:**
```json
{
  "teamId": "team-123",
  "endpoint": "/api/ml/train",
  "capacity": 1000,
  "refillRate": 10,
  "priority": "normal"
}
```

**Response:**
```json
{
  "success": true,
  "bucket": {
    "id": "bucket-1726752000000-abc123",
    "workspaceId": "ws-456",
    "teamId": "team-123",
    "endpoint": "/api/ml/train",
    "capacity": 1000,
    "refillRate": 10,
    "priority": "normal",
    "createdAt": "2026-09-19T14:00:00Z"
  },
  "message": "Rate limit bucket created"
}
```

#### GET /api/ops/ratelimit/:workspaceId/buckets
Get current status of a rate limit bucket.

**Query Parameters:**
- `teamId` (optional): Filter by team
- `endpoint` (optional): Filter by endpoint

**Response:**
```json
{
  "bucketId": "bucket-1726752000000-abc123",
  "tokens": 850,
  "capacity": 1000,
  "refillRate": 10,
  "priority": "normal",
  "percentageAvailable": "85.0%",
  "status": "available",
  "requestsInQueue": 3,
  "estimatedWaitMs": 1250
}
```

#### PUT /api/ops/ratelimit/:workspaceId/buckets/refill-rate
Update the refill rate of a bucket (e.g., due to budget change or plan upgrade).

**Request:**
```json
{
  "teamId": "team-123",
  "endpoint": "/api/ml/train",
  "newRefillRate": 20
}
```

**Response:**
```json
{
  "success": true,
  "message": "Refill rate updated"
}
```

### Token Consumption

#### POST /api/ops/ratelimit/:workspaceId/consume
Attempt to consume tokens from a bucket. If sufficient tokens available, deducts and returns `true`. Otherwise queues request and returns `false`.

**Request:**
```json
{
  "tokensRequired": 50,
  "teamId": "team-123",
  "endpoint": "/api/ml/train"
}
```

**Response (Success):**
```json
{
  "allowed": true,
  "tokensRequired": 50,
  "message": "Tokens consumed successfully"
}
```

**Response (Queued):**
```json
{
  "allowed": false,
  "tokensRequired": 50,
  "message": "Insufficient tokens; request queued"
}
```

#### GET /api/ops/ratelimit/:workspaceId/status
Get current rate limit status without consuming tokens (read-only check).

**Query Parameters:**
- `teamId` (optional)
- `endpoint` (optional)

**Response:**
```json
{
  "bucketId": "bucket-1726752000000-abc123",
  "tokens": 850,
  "capacity": 1000,
  "refillRate": 10,
  "percentageAvailable": "85.0%",
  "status": "available",
  "requestsInQueue": 3,
  "estimatedWaitMs": 1250
}
```

**Status Values:**
- `available`: ≥25% tokens available
- `limited`: 10-24% tokens available
- `queued`: <25% tokens + requests in queue
- `exceeded`: <10% tokens

### Request Queue Management

#### POST /api/ops/ratelimit/:workspaceId/queue
Queue a request for later execution.

**Request:**
```json
{
  "requestId": "req-789",
  "endpoint": "/api/ml/train",
  "priority": "normal",
  "teamId": "team-123",
  "timeout": 300000
}
```

**Response:**
```json
{
  "success": true,
  "queuedRequest": {
    "id": "queued-1726752000000-def456",
    "requestId": "req-789",
    "priority": "normal",
    "queuedAt": "2026-09-19T14:15:30Z",
    "estimatedWaitMs": 2500,
    "timeout": 300000
  },
  "message": "Request queued for later execution"
}
```

#### GET /api/ops/ratelimit/:workspaceId/queue
Get queued requests (recent N requests, most recent first).

**Query Parameters:**
- `teamId` (optional)
- `endpoint` (optional)
- `limit` (default: 50)

**Response:**
```json
{
  "count": 3,
  "requests": [
    {
      "id": "queued-1726752000000-def456",
      "requestId": "req-789",
      "priority": "normal",
      "queuedAt": "2026-09-19T14:15:30Z",
      "estimatedWaitMs": 2500,
      "timeout": 300000
    }
  ]
}
```

#### POST /api/ops/ratelimit/:workspaceId/dequeue
Remove a request from the queue (it was processed or timed out).

**Request:**
```json
{
  "requestId": "req-789",
  "teamId": "team-123",
  "endpoint": "/api/ml/train"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Request dequeued"
}
```

### Time-of-Day Multipliers

#### POST /api/ops/ratelimit/:workspaceId/time-multipliers
Set custom time-of-day multipliers for a workspace.

**Request:**
```json
{
  "multipliers": [
    { "timeWindow": "00:00-06:00", "refillMultiplier": 0.5, "costMultiplier": 0.5 },
    { "timeWindow": "06:00-09:00", "refillMultiplier": 1.0, "costMultiplier": 1.0 },
    { "timeWindow": "09:00-17:00", "refillMultiplier": 1.5, "costMultiplier": 1.5 },
    { "timeWindow": "17:00-20:00", "refillMultiplier": 1.0, "costMultiplier": 1.0 },
    { "timeWindow": "20:00-24:00", "refillMultiplier": 0.7, "costMultiplier": 0.7 }
  ]
}
```

**Response:**
```json
{
  "success": true,
  "count": 5,
  "multipliers": [
    { "timeWindow": "00:00-06:00", "refillMultiplier": 0.5, "costMultiplier": 0.5 },
    ...
  ],
  "message": "Time multipliers configured"
}
```

#### GET /api/ops/ratelimit/:workspaceId/time-multiplier
Get current time multiplier (based on current hour) and effective refill/cost rates.

**Response:**
```json
{
  "timeWindow": "09:00-17:00",
  "refillMultiplier": 1.5,
  "costMultiplier": 1.5,
  "effectiveRefillRate": "150 tokens/sec",
  "effectiveCostMultiplier": 1.5
}
```

### Feature Access Control

#### GET /api/ops/ratelimit/:workspaceId/features
Get all features and their access status for a workspace.

**Response:**
```json
{
  "workspaceId": "ws-456",
  "count": 9,
  "features": [
    {
      "featureId": "basic_api",
      "status": "available",
      "available": true,
      "reason": "Feature enabled",
      "costPerRequest": 0.0001,
      "rateLimitPerMin": null
    },
    {
      "featureId": "ml_training",
      "status": "disabled",
      "available": false,
      "reason": "Budget degradation: 5% remaining",
      "costPerRequest": 1.0,
      "rateLimitPerMin": null
    }
  ]
}
```

#### POST /api/ops/ratelimit/:workspaceId/features/:featureId/enable
Enable a feature for a workspace.

**Response:**
```json
{
  "success": true,
  "message": "Feature ml_training enabled"
}
```

#### POST /api/ops/ratelimit/:workspaceId/features/:featureId/disable
Disable a feature for a workspace.

**Request:**
```json
{
  "reason": "Budget exceeded"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Feature ml_training disabled"
}
```

#### GET /api/ops/ratelimit/:workspaceId/features/:featureId
Get detailed information about a specific feature.

**Response:**
```json
{
  "featureId": "ml_training",
  "name": "ML Model Training",
  "description": "AI/ML training jobs",
  "costPerRequest": 1.0,
  "costPerMonth": 200,
  "degradationOrder": 9,
  "minPlanTier": "growth",
  "rateLimit": null,
  "createdAt": "2026-09-19T10:00:00Z"
}
```

### Budget-Based Feature Degradation

#### POST /api/ops/ratelimit/:workspaceId/degrade-features
Apply progressive feature degradation based on remaining budget.

**Request:**
```json
{
  "budgetRemaining": 150,
  "budgetTotal": 1000
}
```

**Response:**
```json
{
  "success": true,
  "changed": 2,
  "disabledFeatures": ["ml_training", "custom_webhooks"],
  "message": "2 feature(s) disabled due to budget constraints"
}
```

#### POST /api/ops/ratelimit/:workspaceId/restore-features
Restore features when budget recovers.

**Request:**
```json
{
  "budgetRemaining": 850,
  "budgetTotal": 1000
}
```

**Response:**
```json
{
  "success": true,
  "changed": 2,
  "enabledFeatures": ["custom_webhooks", "audit_logs"],
  "message": "2 feature(s) restored due to budget recovery"
}
```

### Plan Tier Configuration

#### GET /api/ops/ratelimit/:workspaceId/plan-tiers/:tier
Get the plan tier matrix (what features/limits are included).

**Response:**
```json
{
  "tier": "starter",
  "monthlyPrice": "$99",
  "featureCount": 6,
  "features": [
    "basic_api",
    "email_notifications",
    "slack_integration",
    "advanced_analytics",
    "realtime_sync",
    "data_export"
  ],
  "rateLimit": "1000 requests/min",
  "storageGB": "100GB",
  "supportLevel": "priority"
}
```

#### POST /api/ops/ratelimit/:workspaceId/plan-tiers
Configure a plan tier matrix.

**Request:**
```json
{
  "tier": "starter",
  "monthlyPrice": 99,
  "features": [
    "basic_api",
    "email_notifications",
    "slack_integration",
    "advanced_analytics",
    "realtime_sync",
    "data_export"
  ],
  "rateLimit": 1000,
  "storageGB": 100,
  "supportLevel": "priority"
}
```

**Response:**
```json
{
  "success": true,
  "matrix": {
    "tier": "starter",
    "monthlyPrice": "$99",
    "featureCount": 6,
    "rateLimit": "1000 requests/min",
    "storageGB": "100GB",
    "supportLevel": "priority"
  },
  "message": "Plan tier 'starter' configured"
}
```

#### GET /api/ops/ratelimit/:workspaceId/plan-tiers/:tier/features
Get features included in a plan tier.

**Response:**
```json
{
  "tier": "starter",
  "count": 6,
  "features": [
    {
      "id": "basic_api",
      "name": "Basic API Access",
      "costPerRequest": 0.0001,
      "costPerMonth": 0,
      "degradationOrder": 1
    }
  ]
}
```

#### GET /api/ops/ratelimit/:workspaceId/features/check/:featureId/tier/:tier
Check if a feature is included in a plan tier.

**Response:**
```json
{
  "featureId": "ml_training",
  "tier": "starter",
  "included": false
}
```

### Feature Cost Analysis

#### POST /api/ops/ratelimit/:workspaceId/feature-costs
Calculate cost breakdown for used features.

**Request:**
```json
{
  "usage": {
    "basic_api": 10000,
    "advanced_analytics": 500,
    "ml_training": 50
  }
}
```

**Response:**
```json
{
  "workspaceId": "ws-456",
  "count": 3,
  "breakdown": [
    {
      "featureId": "ml_training",
      "name": "ML Model Training",
      "requestCount": 50,
      "costPerRequest": 1.0,
      "totalCost": "$50.00"
    },
    {
      "featureId": "advanced_analytics",
      "name": "Advanced Analytics",
      "requestCount": 500,
      "costPerRequest": 0.05,
      "totalCost": "$25.00"
    },
    {
      "featureId": "basic_api",
      "name": "Basic API Access",
      "requestCount": 10000,
      "costPerRequest": 0.0001,
      "totalCost": "$1.00"
    }
  ],
  "totalCost": "$76.00"
}
```

#### GET /api/ops/ratelimit/:workspaceId/subscription-cost
Get monthly subscription cost for a set of features.

**Query Parameters:**
- `featureIds`: comma-separated or array of feature IDs

**Response:**
```json
{
  "count": 3,
  "features": ["basic_api", "advanced_analytics", "ml_training"],
  "monthlySubscriptionCost": "$250.00"
}
```

### Metrics and Monitoring

#### GET /api/ops/ratelimit/:workspaceId/metrics
Get rate limit metrics for a workspace.

**Response:**
```json
{
  "workspaceId": "ws-456",
  "totalBuckets": 5,
  "totalQueuedRequests": 12,
  "averageTokenPercentage": "42.5%",
  "criticalBuckets": 2,
  "health": "warning"
}
```

Health Levels:
- `healthy`: ≥50% average token availability
- `warning`: 25-50% average token availability
- `critical`: <25% average token availability

## Workflows

### Workflow 1: Basic Rate Limiting (Token Bucket)

**Scenario:** API endpoint needs to enforce 100 requests/minute.

```
1. Admin creates bucket:
   POST /api/ops/ratelimit/ws-456/buckets
   {
     "endpoint": "/api/v1/data",
     "capacity": 100,
     "refillRate": 1.67  # (100 tokens / 60 seconds)
   }

2. Client attempts request:
   POST /api/ops/ratelimit/ws-456/consume
   {
     "tokensRequired": 1,
     "endpoint": "/api/v1/data"
   }
   
   Response: { "allowed": true }  (if tokens available)
   
3. At end of period, refill happens automatically:
   After 60 seconds: tokens refill from ~0 back to ~100

4. During peak times (9 AM), apply multiplier:
   GET /api/ops/ratelimit/ws-456/time-multiplier
   Response: { "refillMultiplier": 1.5 }
   Effective refillRate: 1.67 × 1.5 = 2.5 tokens/sec
```

### Workflow 2: Priority Queuing During Overload

**Scenario:** ML training endpoint is at capacity; need to queue requests.

```
1. Client sends critical request:
   POST /api/ops/ratelimit/ws-456/queue
   {
     "requestId": "critical-job-001",
     "endpoint": "/api/ml/train",
     "priority": "critical",
     "timeout": 600000  # 10 minutes
   }
   Response: { "id": "queued-xxx", "estimatedWaitMs": 15000 }

2. Later, bulk request:
   POST /api/ops/ratelimit/ws-456/queue
   {
     "requestId": "bulk-job-002",
     "endpoint": "/api/ml/train",
     "priority": "bulk"
   }

3. When tokens available, critical request processes first
4. Check queue status:
   GET /api/ops/ratelimit/ws-456/queue
   (shows critical requests first, bulk last)

5. After processing:
   POST /api/ops/ratelimit/ws-456/dequeue
   { "requestId": "critical-job-001" }
```

### Workflow 3: Budget-Based Feature Degradation

**Scenario:** Workspace has $1000/month budget, costs are climbing.

```
Budget Status Timeline:
├─ $900 remaining (90%) — All features enabled
├─ $700 remaining (70%) — Apply light degradation
│  └─ Disable features with degradationOrder > 7:
│     (custom_webhooks disabled, but ml_training still available)
│
├─ $400 remaining (40%) — Apply moderate degradation
│  └─ Disable features with degradationOrder > 5:
│     (ml_training, audit_logs, custom_webhooks disabled)
│
├─ $150 remaining (15%) — Apply aggressive degradation
│  └─ Disable features with degradationOrder > 3:
│     (only basic_api, email_notifications, slack_integration available)
│
└─ $50 remaining (5%) — Emergency mode
   └─ Disable all except degradationOrder <= 1:
      (only basic_api, email_notifications available)

Implementation:
1. Budget service calculates: $1000 - $600 spent = $400 remaining (40%)
2. Calls degradation API:
   POST /api/ops/ratelimit/ws-456/degrade-features
   {
     "budgetRemaining": 400,
     "budgetTotal": 1000
   }

3. System identifies features to disable:
   - ml_training (order 9) ✓ disabled
   - audit_logs (order 8) ✓ disabled
   - custom_webhooks (order 7) ✓ disabled
   - advanced_analytics (order 4) — kept (order 4 ≤ 5)

4. Budget recovery ($600 spent → $300 spent):
   POST /api/ops/ratelimit/ws-456/restore-features
   {
     "budgetRemaining": 700,
     "budgetTotal": 1000
   }

5. System restores in reverse priority order:
   - custom_webhooks (order 7) ✓ restored first
   - audit_logs (order 8) ✓ restored
   - ml_training (order 9) ✓ restored last
```

### Workflow 4: Time-of-Day Pricing Integration

**Scenario:** Encourage off-peak usage for cost-sensitive workloads.

```
Default Multipliers:
├─ 00:00-06:00: refill × 0.5, cost × 0.5  (off-peak)
├─ 06:00-09:00: refill × 1.0, cost × 1.0  (normal)
├─ 09:00-17:00: refill × 1.5, cost × 1.5  (peak business hours)
├─ 17:00-20:00: refill × 1.0, cost × 1.0  (normal)
└─ 20:00-24:00: refill × 0.7, cost × 0.7  (off-peak)

Cost Examples (ml_training @ $1.0/request):
├─ 2 AM (night):  $1.0 × 0.5 = $0.50
├─ 8 AM (morning):$1.0 × 1.0 = $1.00
├─ 2 PM (peak):   $1.0 × 1.5 = $1.50
├─ 6 PM (evening):$1.0 × 1.0 = $1.00
└─ 10 PM (night): $1.0 × 0.7 = $0.70

Workflow:
1. Client checks current multiplier:
   GET /api/ops/ratelimit/ws-456/time-multiplier

2. If response shows "peak" pricing (1.5x), consider deferring
3. Budget service uses multiplier in cost calculations:
   actual_cost = basePrice × effectiveCostMultiplier

4. Custom multipliers can be set per workspace:
   POST /api/ops/ratelimit/ws-456/time-multipliers
   (useful for businesses with non-standard operating hours)
```

### Workflow 5: Plan Tier Upgrade/Downgrade

**Scenario:** Customer upgrades from Starter to Growth plan.

```
1. Get current feature set:
   GET /api/ops/ratelimit/ws-456/plan-tiers/starter
   (returns: basic_api, email_notifications, slack_integration, ...)

2. Upgrade triggered:
   POST /api/ops/ratelimit/ws-456/plan-tiers
   {
     "tier": "growth",
     "monthlyPrice": 499,
     "features": ["basic_api", "email_notifications", ..., "ml_training", "audit_logs"],
     "rateLimit": 10000,
     "storageGB": 10000,
     "supportLevel": "dedicated"
   }

3. New features automatically enabled:
   - ml_training now available
   - custom_webhooks now available
   - audit_logs now available
   - Rate limits increase from 1000 → 10000 req/min

4. Verify features enabled:
   GET /api/ops/ratelimit/ws-456/features
   (ml_training shows status: "available")

5. Get new rate limits:
   GET /api/ops/ratelimit/ws-456/plan-tiers/growth
```

## Feature Details

### Default Features (9 Total)

| Feature ID | Name | Cost/Request | Cost/Month | Degradation Order | Min Plan Tier | Description |
|------------|------|--------------|------------|-------------------|---------------|-------------|
| basic_api | Basic API Access | $0.0001 | $0 | 1 | free | Standard API endpoints (CRITICAL) |
| email_notifications | Email Notifications | $0.001 | $0 | 2 | free | Send email alerts |
| slack_integration | Slack Integration | $0.002 | $10 | 3 | starter | Post to Slack channels |
| advanced_analytics | Advanced Analytics | $0.05 | $50 | 4 | starter | Detailed usage analytics |
| data_export | Data Export | $0.005 | $30 | 5 | starter | Export workspace data |
| realtime_sync | Real-time Sync | $0.001 | $25 | 6 | starter | Live data synchronization |
| custom_webhooks | Custom Webhooks | $0.01 | $75 | 7 | growth | Custom webhook integrations |
| audit_logs | Audit Logging | $0.01 | $99 | 8 | growth | Complete audit trail |
| ml_training | ML Model Training | $1.0 | $200 | 9 | growth | AI/ML training jobs (EXPENSIVE) |

### Default Plan Tiers

**Free Tier** ($0/month)
- Rate Limit: 100 requests/min
- Storage: 1 GB
- Support: Email
- Features: basic_api, email_notifications

**Starter Tier** ($99/month)
- Rate Limit: 1000 requests/min
- Storage: 100 GB
- Support: Priority
- Features: Free + slack_integration, advanced_analytics, realtime_sync, data_export

**Growth Tier** ($499/month)
- Rate Limit: 10,000 requests/min
- Storage: 10 TB
- Support: Dedicated
- Features: Starter + ml_training, custom_webhooks, audit_logs

## Integration with Previous Phases

### Phase 4.8 → 4.9 Integration

```
Phase 4.8 (Budgets):                Phase 4.9 (Rate Limiting):
├─ Define budget amount              ├─ Create rate limit buckets
├─ Set enforcement thresholds        ├─ Configure token refill rates
└─ Track spending & usage            └─ Auto-degrade features based on spend

Flow:
1. Budget $1000/month created (4.8)
2. Spending tracked: $600/month
3. Budget remaining: 40% ($400)
4. Budget service calls:
   POST /api/ops/ratelimit/ws-456/degrade-features
   { "budgetRemaining": 400, "budgetTotal": 1000 }
5. Phase 4.9 disables non-critical features automatically
6. User experience degrades gracefully, cost is prevented
```

### Phase 4.7 → 4.9 Integration

```
Phase 4.7 (Analytics):              Phase 4.9 (Rate Limiting):
├─ Detect anomalies                 ├─ Enforce limits proactively
├─ Identify cost drivers            ├─ Queue requests fairly
└─ Recommend optimizations          └─ Degrade on budget threshold

Flow:
1. Analytics detects spike in ml_training usage (4.7)
2. Projects budget overage in 3 days (4.7)
3. Creates optimization recommendation (4.7)
4. Budget service triggers degradation (4.9):
   - Lowers ml_training priority in queue
   - Increases cost multiplier during peak hours
   - Warns on consumption
5. User is informed before critical action taken
```

## Performance Characteristics

### Token Bucket Algorithm

- **Time Complexity:** O(1) for token consumption and refill
- **Space Complexity:** O(n) where n = number of buckets
- **Refill Efficiency:** Lazy evaluation (refill on access, not periodic timer)

### Request Queue

- **Insertion:** O(1) to queue (append to end)
- **Dequeue:** O(n) worst-case (linear search for requestId)
- **Deletion:** O(n/2) average (sort + truncate if full)
- **Memory:** Bounded to MAX_QUEUE_SIZE (100,000 requests)

### Feature Access

- **Feature Lookup:** O(1) per feature (Map-based storage)
- **Degradation:** O(f × log f) where f = number of features (due to sort)
- **Plan Tier Lookup:** O(1) constant-time matrix access

## Testing Recommendations

### Unit Tests

```typescript
// Token Bucket Tests
- consumeTokens succeeds with sufficient tokens
- consumeTokens fails without sufficient tokens
- refillTokens correctly updates token count based on elapsed time
- refillTokens caps tokens at capacity
- getRateLimitStatus returns correct percentageAvailable

// Request Queue Tests
- queueRequest adds request to queue
- queueRequest respects priority ordering
- dequeueRequest removes request by requestId
- Queue auto-truncates when exceeding MAX_QUEUE_SIZE
- Queue preserves critical requests over bulk requests

// Feature Degradation Tests
- applyFeatureDegradation disables correct features at each threshold
- restoreFeaturesForBudget re-enables features in reverse order
- Feature status reflects enabled/disabled state
- Plan tier matrix correctly maps features to tiers

// Time Multiplier Tests
- getTimeMultiplier returns correct window for current hour
- getEffectiveRefillRate multiplies base rate correctly
- getEffectiveCostMultiplier returns current window's cost factor
```

### Integration Tests

```typescript
// Full Workflow Tests
- Create bucket → Consume tokens → Check status → Refill → Consume again
- Overflow → Queue request → Check queue → Dequeue → Verify status
- Degrade features at threshold → Check feature status → Restore → Verify re-enabled
- Time multiplier changes → Verify refill rate changes → Verify cost factor changes
- Plan upgrade → Verify new features enabled → Verify rate limit increased
```

### Load Tests

- 10,000 concurrent consumeTokens calls (token bucket fairness)
- 50,000 queued requests (queue performance under load)
- 1,000 concurrent degradation calls (feature access performance)
- Peak hour time multiplier changes (system stability at transitions)

## API Examples

### Example 1: Rate Limit a Data Export Feature

```bash
# Create bucket for exports (1000 requests/day = ~0.69 tokens/sec)
curl -X POST http://localhost:3000/api/ops/ratelimit/ws-456/buckets \
  -H "Content-Type: application/json" \
  -d '{
    "endpoint": "/api/v1/export",
    "capacity": 1000,
    "refillRate": 0.69,
    "priority": "normal"
  }'

# Client attempts to export
curl -X POST http://localhost:3000/api/ops/ratelimit/ws-456/consume \
  -H "Content-Type: application/json" \
  -d '{
    "tokensRequired": 100,
    "endpoint": "/api/v1/export"
  }'

# If response is { "allowed": false }, queue the request
curl -X POST http://localhost:3000/api/ops/ratelimit/ws-456/queue \
  -H "Content-Type: application/json" \
  -d '{
    "requestId": "export-12345",
    "endpoint": "/api/v1/export",
    "priority": "bulk"
  }'
```

### Example 2: Degrade Features on Budget Alert

```bash
# Budget service detected high spend (10% remaining)
curl -X POST http://localhost:3000/api/ops/ratelimit/ws-456/degrade-features \
  -H "Content-Type: application/json" \
  -d '{
    "budgetRemaining": 100,
    "budgetTotal": 1000
  }'

# Response shows what was disabled
# { "changed": 4, "disabledFeatures": ["ml_training", "audit_logs", ...] }

# Check feature status
curl http://localhost:3000/api/ops/ratelimit/ws-456/features

# User sees only critical features available (basic_api, email_notifications)
```

### Example 3: Calculate Feature Cost Breakdown

```bash
# Get cost breakdown for usage
curl -X POST http://localhost:3000/api/ops/ratelimit/ws-456/feature-costs \
  -H "Content-Type: application/json" \
  -d '{
    "usage": {
      "basic_api": 50000,
      "advanced_analytics": 1000,
      "ml_training": 100
    }
  }'

# Response:
# {
#   "breakdown": [
#     { "featureId": "ml_training", "totalCost": "$100.00" },
#     { "featureId": "advanced_analytics", "totalCost": "$50.00" },
#     { "featureId": "basic_api", "totalCost": "$5.00" }
#   ],
#   "totalCost": "$155.00"
# }
```

## Common Issues and Troubleshooting

### Issue: Tokens Not Refilling

**Cause:** Bucket refillRate is too low or bucket not configured.  
**Solution:** 
1. Check bucket exists: `GET /api/ops/ratelimit/:workspaceId/buckets`
2. Verify refillRate matches desired request rate
3. Ensure enough time has elapsed since last refill

### Issue: Requests Always Queued

**Cause:** Capacity is set too low or refillRate is near zero.  
**Solution:**
1. Increase capacity: `PUT /api/ops/ratelimit/:workspaceId/buckets/refill-rate`
2. Monitor average token percentage: `GET /api/ops/ratelimit/:workspaceId/metrics`
3. Adjust plan tier rate limits if needed

### Issue: Features Not Degrading

**Cause:** Budget threshold not reached or degradation not called.  
**Solution:**
1. Verify budget remaining < degradation threshold (75%)
2. Call degrade-features endpoint explicitly
3. Check degradationOrder values are correct (1-10 scale)

### Issue: Time Multipliers Not Applying

**Cause:** Custom multipliers not set or system using defaults.  
**Solution:**
1. Call setTimeMultipliers to configure: `POST /api/ops/ratelimit/:workspaceId/time-multipliers`
2. Verify current hour matches expected window
3. Check effectiveRefillRate via time-multiplier endpoint

## Summary

Phase 4.9 implements the final enforcement layer of cost control:

- **Token Bucket:** Fair allocation with time-of-day pricing
- **Feature Degradation:** Progressive service reduction prevents cost overruns
- **Request Queuing:** Critical requests prioritized during contention
- **Plan Tiers:** Feature access aligned with subscription level
- **Budget Integration:** Automatic control based on spending trends

Together with Phases 4.7 (Analytics), 4.8 (Budgets), and 4.9 (Rate Limiting), the system closes the loop from "observe costs" → "understand costs" → "control costs" → "prevent costs."
