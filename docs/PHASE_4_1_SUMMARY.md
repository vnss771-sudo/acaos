# Phase 4.1: Multi-Tenant Performance Hardening

Complete implementation of enterprise-ready multi-tenant infrastructure for ACAOS. Focuses on rate limiting, resource isolation, observability, and abuse detection to ensure stable operation under concurrent load.

## Components Implemented

### 1. Workspace Rate Limiting (`lib/workspaceRateLimit.ts`)

**Purpose**: Prevent single compromised/abusive workspace from monopolizing shared resources (OpenAI API key, SMTP relay).

**Rates**:
- **Mail**: 100 emails/minute per workspace
- **AI**: 500 calls/hour per workspace (monthly quota via PLAN_LIMITS is billing ceiling)

**Implementation**:
- Redis-backed fixed-window counters with per-pod in-process fallback
- Transparent to callers: simply call `await enforceWorkspaceMailRate(workspaceId)` before send
- Tunable via `WORKSPACE_MAIL_RATE_MAX` and `WORKSPACE_AI_RATE_MAX` env vars

**Integration Points**:
- `/api/mailbox/send-test` — mail rate limiting
- `/api/ai/research`, `/api/ai/outreach`, `/api/ai/reply` — AI rate limiting
- `/api/jobs/*` — both AI routes

---

### 2. Database Pool Monitoring (`lib/dbMonitor.ts`)

**Purpose**: Detect connection pool exhaustion, slow queries, and database bottlenecks before they cause cascading failures.

**Features**:
- Boot-time pool verification (ensure DB is reachable)
- Per-request query performance tracking (slow query threshold: 500ms)
- Periodic health checks every 60 seconds
- Metrics: pool utilization, query count, slow query percentage

**Integration**:
- Automatic pool health check at server startup
- Background health check interval (60s, fire-and-forget)
- Exported functions: `verifyDatabasePool()`, `getQueryMetrics()`, `logPoolHealth()`

**Configuration**:
- `DB_POOL_SIZE` — connection pool size (default 10, recommended: `(CONCURRENT_USERS / 2) + 5`)

---

### 3. Load Testing Framework (`scripts/load-test.ts`)

**Purpose**: Simulate realistic multi-user concurrent load to verify rate limits, pool behavior, and response time distribution.

**Metrics**:
- Throughput (requests/second)
- Response time distribution (P50, P95, P99, max)
- Rate limit hit rate (percent of 429 responses)
- Configurable concurrent users and workspaces

**Usage**:
```bash
DB_POOL_SIZE=20 CONCURRENT_USERS=10 node scripts/load-test.ts
```

**Configuration**:
- `API_BASE` — API server URL (default: http://localhost:4000)
- `CONCURRENT_USERS` — simulated concurrent users (default: 10)
- `WORKSPACES` — number of workspaces to distribute load (default: 5)
- `LOAD_TEST_DURATION` — duration in seconds (default: 30)
- `ENDPOINT` — API endpoint to hammer (default: /api/lead-scoring/score)

---

### 4. Workspace Query Caching (`lib/workspaceCache.ts`)

**Purpose**: Reduce database load from frequently accessed read-only data (workspace config, member roster) that changes infrequently.

**Cached Data**:
- Workspace configuration (plan, subscription status, feature flags)
- Member roster (for auth/permission checks)

**TTL**: 5 minutes with Redis backing + in-memory fallback

**Cache Invalidation**:
- `invalidateWorkspaceConfig(workspaceId)` — called on plan/subscription changes
- `invalidateWorkspaceMembers(workspaceId)` — called on member join/leave/role change

**Benefits**:
- Reduces DB queries for workspace lookup by ~80% (estimated)
- Falls back to in-memory on Redis outage
- Per-pod local cache prevents cache stampede

---

### 5. Workspace Isolation Monitoring (`lib/workspaceIsolation.ts`)

**Purpose**: Detect and prevent accidental cross-tenant data leaks.

**Features**:
- Request-scoped isolation context tracking
- Verify tenant-model queries include `workspaceId` filters
- Audit trail of workspace mutations
- Workspace query load distribution monitoring

**Modes**:
- **Observe** (default): Log violations to audit trail
- **Enforce** (`WORKSPACE_GUARD_MODE=enforce`): Throw on isolation violation

**Tenant Models**: Lead, Campaign, Prospect, Mission, Inbox, Task, OutreachSent, Outcome, etc.

---

### 6. Abuse Detection & Emergency Throttling (`lib/abuseDetection.ts`)

**Purpose**: Detect and respond to anomalous workspace behavior before cascade failures.

**Patterns Detected**:
- **Rate limit spike**: >10 rate limit hits (429s) in 60 seconds from workspace
- **High query load**: workspace exceeds 2x expected baseline for plan tier
- **Auth failure burst**: >5 failed logins in 5 minutes from account

**Incident Escalation**:
- 1-2 signals: LOW severity (logged)
- 3+ signals within 5 min: HIGH severity (alert)

**Response**:
- Incident log (100 most recent)
- Fire-and-forget abuse checking (never blocks requests)
- Actionable recommendations for manual ops action

---

### 7. Performance Metrics Endpoints (`routes/ops/performance.ts`)

**Purpose**: Give operators real-time visibility into multi-tenant system health.

**Endpoints**:

| Endpoint | Purpose |
|----------|---------|
| `GET /api/ops/performance` | Aggregate health: pool, queries, cache, workspaces |
| `GET /api/ops/performance/pool` | Database pool utilization and recommendations |
| `GET /api/ops/performance/queries` | Slow query analysis and indexing recommendations |
| `GET /api/ops/performance/cache` | Workspace cache effectiveness |
| `GET /api/ops/performance/workspaces` | Top workspaces by query load (abuse detection) |
| `GET /api/ops/performance/abuse` | Recent abuse incidents and metrics |

All endpoints require metrics token (same as `/metrics` endpoint).

---

### 8. Plan-Tier Aware Rate Limiting (`lib/planAwareRateLimit.ts`)

**Purpose**: Scale rate limits with customer tier, preventing free-tier abuse while giving premium customers headroom.

**Rate Limits**:
```
Free tier:    100 emails/min, 500 AI calls/hour  (1x baseline)
Starter tier: 200 emails/min, 1000 AI calls/hour (2x baseline)
Growth tier:  500 emails/min, 2500 AI calls/hour (5x baseline)
```

**Configuration**:
- Per-plan env var overrides: `WORKSPACE_MAIL_RATE_MAX_FREE`, `WORKSPACE_AI_RATE_MAX_STARTER`, etc.
- No code changes needed to adjust multipliers or add tiers

**User Endpoints**:
- `GET /api/workspaces/:id/rate-limits` — shows current limits and upgrade path
- Helps users understand why they hit limits
- Enables sales demos of tier benefits

---

## Architecture Diagram

```
Request Flow with Phase 4.1:

┌─────────────────────────────────────────────────────┐
│ Incoming Request (authenticated user)               │
└─────────────────────────────────────────────────────┘
                      │
                      ▼
         ┌────────────────────────────┐
         │ Per-IP Rate Limit Check    │ (middleware/rateLimit.ts)
         │ (200 req/min, 10 auth/15m) │
         └────────────────────────────┘
                      │
         (pass) │      │ (fail → 429)
                ▼      ▼
    ┌──────────────────────┐       ┌──────────────────────┐
    │ Workspace Isolation  │       │ Log Abuse Signal +   │
    │ Context Tracking     │       │ Check Rate Spike     │
    │ (verify workspaceId) │       │ (→ HIGH severity)    │
    └──────────────────────┘       └──────────────────────┘
                │
                ▼
    ┌──────────────────────┐
    │ Workspace Rate Limit │ (lib/workspaceRateLimit.ts)
    │ (100 mail/min,       │
    │  500 AI/hour)        │
    │ × plan_multiplier    │
    └──────────────────────┘
                │
         (pass) │      │ (fail → 429)
                ▼      ▼
    ┌──────────────────────┐    ┌──────────────────────┐
    │ Request Handler      │    │ Abuse Detection:     │
    │ - Check cache first  │    │ - Rate Limit Spike   │
    │ - Query DB if miss   │    │ - Log Incident       │
    │ - Track slow queries │    │ - Escalate if HIGH   │
    └──────────────────────┘    └──────────────────────┘
                │
                ▼
    ┌──────────────────────┐
    │ Response             │ + response time metrics
    └──────────────────────┘
```

---

## Configuration Reference

### Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `WORKSPACE_MAIL_RATE_MAX` | 100 | Emails/minute per workspace |
| `WORKSPACE_AI_RATE_MAX` | 500 | AI calls/hour per workspace |
| `WORKSPACE_MAIL_RATE_MAX_FREE` | (see above) | Override for free tier |
| `WORKSPACE_MAIL_RATE_MAX_STARTER` | (see above) | Override for starter tier |
| `WORKSPACE_MAIL_RATE_MAX_GROWTH` | (see above) | Override for growth tier |
| `DB_POOL_SIZE` | 10 | Database connection pool size |
| `WORKSPACE_GUARD_MODE` | observe | enforce/observe isolation violations |
| `RATE_LIMIT_DISABLED` | false | Disable rate limiting for tests |

### Example: High-Load Production Configuration

```bash
# Production deployment with 4 replicas handling 100 concurrent users each
DB_POOL_SIZE=60                          # 400 users / 2 + 5 = 60
WORKSPACE_MAIL_RATE_MAX=100              # Hard limit even if not scaled per-tier
WORKSPACE_AI_RATE_MAX=500
WORKSPACE_GUARD_MODE=enforce             # Fail closed on isolation violations
RATE_LIMIT_DISABLED=false
```

---

## Monitoring & Operations

### Health Check Endpoints

```bash
# Overall system health
curl http://localhost:4000/api/health

# Live check (instance is running)
curl http://localhost:4000/api/live

# Readiness probe (ready to serve traffic)
curl http://localhost:4000/api/ready

# Multi-tenant performance metrics
curl -H "Authorization: Bearer $METRICS_TOKEN" \
     http://localhost:4000/api/ops/performance
```

### Operational Workflows

**Scale to handle more concurrent users:**
1. Increase `DB_POOL_SIZE` proportionally
2. Monitor `/api/ops/performance/pool` — target utilization < 80%
3. Monitor `/api/ops/performance/queries` — investigate if slow query rate increases

**Identify abusive workspaces:**
1. Check `/api/ops/performance/workspaces` — query distribution hotspots
2. Check `/api/ops/performance/abuse` — recent incidents and patterns
3. Manual action: reduce `WORKSPACE_MAIL_RATE_MAX`, tighten quota, or suspend

**Upgrade customer to higher tier:**
1. Customer sees `/api/workspaces/:id/rate-limits` showing current/next tier limits
2. Upgrade in billing → rate limits automatically increase via plan multiplier

---

## Testing & Load Testing

### Load Test Examples

**Test mail rate limiting:**
```bash
DB_POOL_SIZE=30 \
CONCURRENT_USERS=20 \
WORKSPACES=5 \
ENDPOINT=/api/mailbox/send-test \
node scripts/load-test.ts
```

**Test AI rate limiting:**
```bash
DB_POOL_SIZE=20 \
CONCURRENT_USERS=15 \
WORKSPACES=3 \
ENDPOINT=/api/ai/research \
node scripts/load-test.ts
```

**Test lead scoring batch:**
```bash
DB_POOL_SIZE=25 \
CONCURRENT_USERS=10 \
ENDPOINT=/api/lead-scoring/batch \
node scripts/load-test.ts
```

See `docs/LOAD_TESTING.md` for detailed guidance.

---

## Integration Checklist

- [x] Workspace rate limiting in mail/AI routes
- [x] Database pool monitoring at startup and periodic
- [x] Load testing framework
- [x] Workspace query caching with invalidation
- [x] Isolation monitoring and tenant guard
- [x] Abuse detection with incident logging
- [x] Performance metrics endpoints for operators
- [x] Plan-tier aware rate limits with visibility
- [x] Documentation and configuration reference

---

## Next Steps (Phase 4.2+)

- **Query optimization**: Database index analysis and creation
- **Smart caching**: Cache warming for predictable queries
- **Distributed tracing**: End-to-end request latency breakdown
- **Workspace quotas**: Daily/hourly quotas with alerting
- **Auto-scaling**: Horizontal scaling based on queue depth
- **Multi-region**: Cross-region failover and load balancing

---

## Performance Targets

| Metric | Target | Actual (TBD) |
|--------|--------|--------------|
| P50 latency | <50ms | TBD |
| P95 latency | <200ms | TBD |
| P99 latency | <500ms | TBD |
| Throughput | 100+ req/sec | TBD |
| Pool utilization | <80% | TBD |
| Slow query rate | <5% | TBD |
| Cache hit rate | >80% | TBD |
| Rate limit enforcement | 99%+ | TBD |

Run load tests to establish baselines.

---

## Files Changed/Added

**New Files**:
- `apps/api/src/lib/dbMonitor.ts` — database pool monitoring
- `apps/api/src/lib/workspaceCache.ts` — workspace config/member caching
- `apps/api/src/lib/workspaceIsolation.ts` — isolation verification
- `apps/api/src/lib/abuseDetection.ts` — abuse pattern detection
- `apps/api/src/lib/planAwareRateLimit.ts` — plan-tier aware limits
- `apps/api/src/routes/ops/performance.ts` — metrics endpoints
- `apps/api/src/routes/workspaces/rateLimits.ts` — rate limit info endpoints
- `scripts/load-test.ts` — load testing framework
- `docs/LOAD_TESTING.md` — load testing guide
- `docs/PHASE_4_1_SUMMARY.md` — this document

**Modified Files**:
- `apps/api/src/lib/workspaceRateLimit.ts` — updated limits and abuse detection
- `apps/api/src/server.ts` — added pool health monitoring
- `apps/api/src/routes/ops/index.ts` — mounted performance endpoints
- `apps/api/src/routes/workspaces/index.ts` — mounted rate limit endpoints
