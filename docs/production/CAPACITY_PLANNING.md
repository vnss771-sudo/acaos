# ACAOS Capacity Planning Guide

**Objective:** Forecast infrastructure needs, identify bottlenecks, and plan scaling strategies for growth.

**Audience:** SRE team, platform engineers, product management

**Last Updated:** 2026-09-20

---

## Table of Contents

1. [Baseline Capacity Metrics](#baseline-capacity-metrics)
2. [Growth Forecast Models](#growth-forecast-models)
3. [Bottleneck Detection](#bottleneck-detection)
4. [Scaling Strategies](#scaling-strategies)
5. [Cost Optimization](#cost-optimization)
6. [Capacity Planning Timeline](#capacity-planning-timeline)

---

## Baseline Capacity Metrics

### Current System Capacity (Snapshot: 2026-09-20)

**Peak Performance (single-region, all services):**

| Metric | Current | Peak | Utilization |
|--------|---------|------|--------------|
| API throughput | 500 req/s | 1,000 req/s | 50% |
| Worker throughput (send-campaign) | 100 emails/s | 200 emails/s | 50% |
| Database connections | 20/50 | 45/50 | 90% peak |
| Redis memory | 500 MB / 2 GB | 1 GB / 2 GB | 50% |
| API latency p99 | 400 ms | 800 ms | Good |
| API error rate | <0.1% | <1% (SLO 0.1%) | Good |

### Per-Service Capacity

**API Service** (stateless, 2 replicas):

```
Memory per replica: 1 GB
CPU per replica: 1 vCPU

Request breakdown (peak):
- Web UI traffic: 200 req/s (low CPU: mostly DB reads)
- API integrations: 300 req/s (medium CPU: auth, validation)
- Internal jobs: 100 req/s (high CPU: AI, aggregation)

Bottleneck: Database connection pool (25 connections total; 90% utilized at peak)
  → Pool shared across 2 replicas (12-13 conn per replica)
  → Slow queries (e.g., /api/stats) hold connections for 500ms
  → Under sustained load: new requests queue, latency rises
```

**Worker Service** (stateless, 1 replica):

```
Memory per replica: 1 GB
CPU per replica: 1 vCPU
Concurrency: 5 (jobs processed in parallel)

Job throughput by type (peak):
- send-campaign: 100 emails/s → 20 sec to empty queue
- sync-mailbox: 10 accounts/s → reply sync takes 5s per account
- score-prospects: 50 prospects/s → scoring takes 100ms per prospect
- other queues: negligible

Bottleneck: External APIs (SMTP, Apollo, OpenAI)
  → Sending 100 emails/s via single SMTP account hits rate limit (500/min)
  → Must distribute across multiple SMTP accounts
  → Or stagger sends over time (longer campaign window)
```

**Database** (PostgreSQL, 1 primary):

```
Memory: 4 GB
Storage: 50 GB
Connections: 50 max (tuned for 2 API + 1 worker)

Growth metrics:
- Prospects: 1 million rows (10 GB with indexes)
- Campaigns: 50k rows (small)
- Sends: 500M rows (200 GB, partitioned by date)
- Audit events: 100M rows (50 GB, partitioned by date)

Slow queries (by frequency):
- /api/stats: 2 sec (scans 1M prospects, aggregates by tier/status)
- /api/prospects/search: 500ms (full-text index helps)
- /api/campaigns/:id/analytics: 1 sec (joins 3 tables)

Index maintenance: ANALYZE runs nightly
```

**Redis** (in-memory cache):

```
Memory: 2 GB
Persistence: AOF (append-only file)

Data:
- Session cache: 100 MB (user sessions; TTL 30 days)
- Query result cache: 200 MB (stats aggregation; TTL 5s)
- Rate limiter: 50 MB (per-IP request counts; TTL 1 min)
- Job queue: 100 MB (BullMQ state; expires with job)
- Available: 1,500 MB

No memory pressure; good headroom for growth.
```

---

## Growth Forecast Models

### Model 1: Linear Growth

**Assumption:** Customers and usage grow at constant rate.

**Input Parameters:**

```
Base metrics (today):
- Active customers: 100
- Monthly emails sent: 5M
- API requests/month: 500M
- Storage used: 300 GB

Growth rate (target):
- Customers: +10/month (10% monthly growth)
- Emails/customer: constant (single feature focus)
- Storage: +50 GB/month (natural growth + audit trail)

Forecast (3 years out):
Month 1: 110 customers, 5.5M emails/month, 350 GB storage
Month 6: 160 customers, 8M emails/month, 600 GB storage
Month 12: 220 customers, 11M emails/month, 900 GB storage
Month 24: 420 customers, 21M emails/month, 1.5 TB storage
Month 36: 630 customers, 31M emails/month, 2.1 TB storage
```

**Required Scaling (at Month 12):**

```
API throughput: 11M / 30 / 86400 = 4.3 req/s (baseline 500 req/s)
  → No scaling needed; still <5% utilization

Worker throughput: 11M / 30 / 86400 = 4.3 emails/s (baseline 100 emails/s)
  → No scaling needed; still <5% utilization

Database storage: 900 GB (baseline 50 GB)
  → Upgrade disk: 50 GB → 500 GB
  → May need to partition/archive old audit logs

Database connections: 20 connections (baseline)
  → No scaling needed at this rate
```

### Model 2: Viral Growth

**Assumption:** Product goes viral; growth spikes exponentially for 3 months, then stabilizes.

**Input Parameters:**

```
Base metrics (today):
- Active customers: 100
- Monthly emails: 5M

Growth pattern:
Month 1-3: 100% monthly growth (exponential spike)
Month 4-12: 10% monthly growth (cooling off)
Month 12+: 5% monthly growth (stable)

Forecast:
Month 1: 200 customers, 10M emails/month
Month 2: 400 customers, 20M emails/month
Month 3: 800 customers, 40M emails/month
Month 6: 1,260 customers, 63M emails/month
Month 12: 2,200 customers, 110M emails/month
```

**Scaling Required (Month 2-3 — URGENT):**

```
Throughput at Month 2 (20M emails):
  20M / 30 / 86400 = 7.7 emails/s (baseline 100 emails/s)
  → OK, but close to limits; begin scaling

Throughput at Month 3 (40M emails):
  40M / 30 / 86400 = 15.4 emails/s (baseline 100 emails/s)
  → Still OK, but need to prepare for Month 6

Throughput at Month 6 (63M emails):
  63M / 30 / 86400 = 24.3 emails/s (baseline 100 emails/s)
  → Getting tight; scale worker to 2 replicas + increase concurrency
  → Risk: hitting SMTP rate limits; distribute across 3+ SMTP accounts

Throughput at Month 12 (110M emails):
  110M / 30 / 86400 = 42.5 emails/s (baseline 100 emails/s)
  → Worker at ~43% utilization; still headroom, but monitor carefully
  → Database: storage growing fast (1.5 TB+); archive old data

Bottleneck shifts from "do we have capacity?" to "can we partition the data effectively?"
```

### Model 3: Feature Expansion

**Assumption:** New revenue features (e.g., Discover & Outreach, Operations) drive usage per customer.

**Input Parameters:**

```
Today: All customers on "Inbox Assistant" only
Month 6: 20% of customers upgrade to include Discover & Outreach
Month 12: 50% of customers include Discover & Outreach
Month 18: Discover & Outreach becomes standard (100% of customers)

New feature adds:
- 2x AI processing (research + scoring)
- 3x database queries (discovery, recommendations)
- 1.5x emails sent (outreach campaigns)
```

**Scaling Required:**

```
At Month 12 (50% on expanded features):

Email throughput: baseline 5M + (5M * 50% * 1.5) = 8.75M/month
  = 3.4 emails/s (baseline 100 emails/s) → OK

API throughput: baseline 500M + (500M * 50% * 3x) = 1.25B req/month
  = 484 req/s (baseline 500 req/s) → AT LIMIT

Database CPU: Aggregations (discovery ranking, scoring) require more CPU
  → Current DB CPU: 20% peak
  → Projected: 40-50% peak
  → Recommendation: Upgrade DB CPU from 2 to 4 vCPU

AI inference cost: Becomes major cost driver
  → Expected: $50k/month at Month 12
  → Recommendation: Implement caching + batch processing
```

---

## Bottleneck Detection

### Methodology: Red-Blue-Green Dashboard

Create a capacity dashboard with three zones:

```
🟢 GREEN: System has headroom (< 60% utilization)
🔵 BLUE:  System approaching limits (60-80% utilization)
🔴 RED:   System at risk (> 80% utilization)

Goal: Keep all metrics in GREEN. Trigger scaling when approaching BLUE.
```

### Key Metrics to Monitor

**1. API Throughput Bottleneck**

```
Metric: HTTP requests in-flight (per-second rate)
Target: < 60% of max sustained throughput

Current:
- Measured peak: 500 req/s
- Current actual: 250 req/s (average), 400 req/s (spike)
- Status: 🟢 GREEN (80% headroom)

Scaling trigger: > 400 req/s sustained for 10 minutes
  → Add 1 API replica (2 → 3)

Scaling trigger: > 450 req/s sustained
  → Increase DB pool size: 25 → 40 connections
```

**2. Database Connection Pool Bottleneck**

```
Metric: DB pool utilization (active connections / pool size)
Target: < 70% average, < 90% peak

Current:
- Pool size: 25 (shared across 2 API replicas)
- Average utilization: 12/25 = 48%
- Peak utilization: 23/25 = 92%
- Status: 🟡 BLUE approaching RED (peak is too high)

Scaling trigger: Average > 70% OR peak > 85%
  → Option A: Increase pool size (25 → 40)
  → Option B: Add API replica (increases pool instances)
  → Preference: Option A first (cheaper); Option B if Option A doesn't help

Watch for: Slow queries holding connections
  - /api/stats: sometimes takes 2+ seconds
  - Query: SELECT * FROM prospects WHERE workspaceId=X;
    (scans 1M rows; should use index on workspaceId + status)
```

**3. Worker Queue Bottleneck**

```
Metric: Send-campaign queue depth (jobs waiting to be processed)
Target: < 100 waiting

Current:
- Queue depth: average 0 (no backlog)
- Peak: 50 (during spike)
- Status: 🟢 GREEN (excellent)

Scaling trigger: > 100 waiting for 5 minutes
  → Add 1 worker replica (1 → 2)

Scaling trigger: > 500 waiting
  → Add 2nd worker + increase per-worker concurrency (5 → 10)
```

**4. Database Storage Bottleneck**

```
Metric: Storage used / Storage allocated
Target: < 70% (headroom for growth spikes)

Current:
- Allocated: 50 GB
- Used: 35 GB (70% utilization)
- Status: 🔵 BLUE (approaching limit)

Growth rate: +3 GB/month (mainly audit log growth)

Scaling trigger: > 75% utilization
  → Expand disk: 50 GB → 100 GB

Long-term plan:
- At 100 GB used (Month 12): Archive old audit logs to S3
- Implement data retention purge: Keep audit logs 90 days only
- Partition large tables by date (enables range purge)
```

**5. Database Query Performance Bottleneck**

```
Metric: Slow queries (> 500ms)
Target: < 5% of queries

Current:
- /api/stats: 2000 ms (60% of slow queries) → BOTTLENECK
- /api/prospects/search: 400 ms (20% of slow queries)
- /api/campaigns/:id/analytics: 800 ms (20% of slow queries)
- Status: 🔴 RED (too many slow queries)

Root cause analysis:
- /api/stats: No index on (workspaceId, status, tier)
  → Add index; expected time drops to 300 ms
- /api/prospects/search: Full-text index helps, but slow at large result sets
  → Add pagination (already done)
- /api/campaigns/:id/analytics: N+1 queries (loads campaign, then iterates leads)
  → Refactor to join; expected time drops to 200 ms

Optimization roadmap (priority order):
1. Add index on prospects (workspaceId, status, tier) — quick win
2. Refactor /api/campaigns/:id/analytics — join instead of N+1
3. Implement query result caching for /api/stats (already exists; TTL 5s)
```

**6. Redis Memory Bottleneck**

```
Metric: Redis memory used / Redis memory allocated
Target: < 60% (headroom for burst cache growth)

Current:
- Allocated: 2 GB
- Used: 500 MB (25% utilization)
- Status: 🟢 GREEN (excellent headroom)

Scaling trigger: > 80% utilization
  → Upgrade Redis instance: 2 GB → 4 GB

No concerns at foreseeable growth rates.
```

### Bottleneck Scorecard (Monthly Review)

```
Create a spreadsheet and update monthly:

Date         | API Req/s | DB Pool % | Worker Queue | DB Storage | Slow Queries | Status
──────────────────────────────────────────────────────────────────────────────────────
2026-09-20   | 250/500   | 48%      | 0            | 70%        | 🔴 5%        | Needs work
2026-10-20   | 280/500   | 52%      | 5            | 72%        | 🔴 4%        | Improving
2026-11-20   | 320/500   | 58%      | 10           | 73%        | 🟢 2%        | On track
2026-12-20   | 370/500   | 65%      | 15           | 75%        | 🟢 1%        | Healthy

Insights:
- API throughput growing 10% month-over-month (good)
- DB pool utilization rising (monitor; may need scaling at Month 14)
- Query performance improved (index added in Nov improved /api/stats)
- Storage growth slowing (better data retention policy in Dec)
```

---

## Scaling Strategies

### 1. Horizontal Scaling (API/Worker Replicas)

**When to scale horizontally:**

- Throughput approaching limits (> 70% of max per-replica throughput)
- Latency increasing despite spare CPU/memory (load-balancer congestion)
- Customers complaining about slowness

**Example (API):**

```
Current: 2 replicas × 500 req/s = 1,000 req/s capacity

Growth to Month 12: Peak traffic reaches 450 req/s
  → API at 450/1000 = 45% utilization
  → No scaling needed YET

Growth to Month 18: Peak traffic reaches 650 req/s
  → If 2 replicas: 650/1000 = 65% utilization
  → Add 1 replica: 3 replicas × 500 req/s = 1,500 req/s capacity
  → New utilization: 650/1500 = 43% (healthy)
```

**Scaling procedure:**

```bash
# 1. Increase replicas in Railway
Railway dashboard → acaos-api → Replicas: 2 → 3

# 2. Wait for new replica to start (~30 seconds)

# 3. Verify load is balanced
curl https://api.acaos.example.com/api/metrics \
  | grep http_requests_in_flight
# Should drop (load spread across 3 replicas)

# 4. Monitor for 10 minutes
# Check: latency p99, error rate, in-flight requests
# All should improve or stay flat
```

### 2. Vertical Scaling (CPU/Memory)

**When to scale vertically:**

- Single replica is CPU-bound (>80% CPU) with healthy latency
- Memory growth trending upward (possible memory leak)
- Adding replicas doesn't help (bottleneck is per-replica, not aggregate)

**Example (Database):**

```
Current: PostgreSQL 2 CPU, 4 GB RAM
Query performance OK (p99 < 1.5s)

Growth to Month 18: New feature (Discover & Outreach) adds 3x queries
  → Observed: CPU spikes to 70%, latency p99 rises to 2.5s
  → Scaling replicas doesn't help (query bottleneck per-replica)
  → Solution: Upgrade DB CPU 2 → 4 vCPU + RAM 4 GB → 8 GB

  Cost increase: ~3x
  But eliminates query bottleneck; enables next 18 months of growth
```

**Scaling procedure (database):**

```
⚠️ DOWNTIME EVENT: Database will be briefly unavailable (1-5 minutes)

1. Schedule maintenance window (off-peak)

2. Notify customers via status page

3. Via Railway:
   Dashboard → acaos-db → Settings → Compute
   CPU: 2 → 4
   Memory: 4 GB → 8 GB
   Click Save

4. Wait for upgrade to complete
   Status → Running indicates success

5. Test connectivity:
   npx prisma db execute --stdin <<< "SELECT 1"

6. If successful: announce resolution
   If failed: rollback to previous size (from Railway snapshot)
```

### 3. Database Partitioning

**When to partition:**

- Single table >100 GB (scan time unacceptable)
- Retention policy requires periodic table drop (easier with partitions)
- Query performance degrading despite optimization

**Example (Sends table):**

```
Sends table: 500M rows = 200 GB

Performance issue: Finding sends from 3 months ago requires table scan

Solution: Partition sends by month
  sends_2026_09    (current month; hot)
  sends_2026_08    (recent; accessed often)
  sends_2026_07    (old; rarely accessed)
  sends_2026_06    (archive; exported to S3; can delete)

Queries become:
  WHERE createdAt > NOW() - INTERVAL '30 days'
  → Only queries sends_2026_09 + sends_2026_08
  → Time: 5 sec → 500 ms (10x faster)

Retention:
  - Keep current + previous 2 months in DB (hot)
  - Archive to S3 for audit (cold)
  - Delete after retention window (90 days)
```

### 4. Caching Strategy

**Add caching layers for expensive queries:**

```
Current bottleneck: /api/stats (2 sec per query)
Cached? Yes, but only 5 second TTL

Problem: Each customer's /api/stats causes 2 sec computation
With 100 customers, peak traffic = 100 × 2 sec = 200 seconds of DB time per second
Solution: Double cache TTL from 5s → 10s
  → Reduces computation by 50%

Better solution: Implement incremental stats
  → Background job (runs every 5 min) pre-computes stats
  → /api/stats returns pre-computed values (instant)
  → Accuracy: 5 min stale (acceptable for most use cases)
  → DB load: 1 job / 5 min instead of 100 queries / 5 sec
```

### 5. Regional Expansion

**When to expand to multiple regions:**

- Latency from single region exceeds acceptable (e.g., >500 ms for EU customers)
- Legal requirement (GDPR: data must stay in EU)
- Scaling single region becomes prohibitively expensive
- Revenue supports multi-region costs (~3x infrastructure cost)

**Multi-region architecture:**

```
Region 1 (US-East):
  - API (3 replicas)
  - Worker (2 replicas)
  - PostgreSQL primary (primary-only, or read replicas)
  - Redis cluster

Region 2 (EU-West):
  - API (2 replicas)
  - Worker (1 replica)
  - PostgreSQL read replica (async, ~1 sec replication lag)
  - Redis cache (local reads; writes replicate to US)

Routing:
  - API traffic → geo-routed to nearest region
  - Database writes → always go to US primary
  - Database reads → local read replica (EU) for fast queries
```

---

## Cost Optimization

### Cost Breakdown (Current, Monthly)

```
Service              | Cost    | % of Total
───────────────────────────────────────────
PostgreSQL (4 GB)    | $200    | 33%
Redis (2 GB)         | $100    | 17%
API (2 replicas)     | $150    | 25%
Worker (1 replica)   | $75     | 12%
Web (2 replicas)     | $75     | 12%
────────────────────────────────────────
Total                | $600    | 100%

+ egress bandwidth: $50/month
+ backups: included in DB cost
= $650/month infrastructure cost
```

### Optimization Opportunities

**1. Right-size instances**

```
Current: All services use "medium" instance type (1 CPU, 1 GB RAM)

API analysis:
  - Peak CPU: 60%
  - Peak RAM: 400 MB
  - Suggested: Could run on 0.5 CPU / 512 MB RAM
  - Savings: 50%
  
  But: Reduce headroom; less resilience to spikes
  Better: Keep current size; cost is justified by SLA

Worker analysis:
  - Peak CPU: 40%
  - Peak RAM: 300 MB
  - Suggested: Could run on 0.5 CPU / 512 MB RAM
  - Savings: 50% ($37.50/month)
  
  Trade-off: Slower job processing; queue could back up during spikes
  Recommendation: Scale down; monitor; scale up if backlog increases
```

**2. Implement reserved instances**

```
Railway pricing: Pay-as-you-go (standard)

Alternative: 1-year commitment discount (typically 20-30% savings)

Example:
  Current: $600/month × 12 = $7,200/year
  With 25% discount: $5,400/year = $450/month
  Savings: $150/month (25%)

Trade-off: Less flexibility; can't downsize mid-year

Recommendation: Adopt after 3+ months of stable growth (committed demand known)
```

**3. Implement auto-scaling**

```
Current: Manual scaling (decide, click button, wait)

Dynamic scaling:
  - Track in-flight requests
  - When > threshold: auto-add replica
  - When < threshold: auto-remove replica
  
  Implementation via Railway or Kubernetes
  
Benefits:
  - Handles traffic spikes without manual intervention
  - Scales down during off-peak (saves cost)
  
Example:
  - Day time: 3 API replicas (handle traffic)
  - Night time: 1 API replica (low traffic)
  - Weekend: 2 API replicas (reduced usage)
  
  Potential savings: 30-40% (reduced replicas during low-traffic periods)
```

**4. Optimize database queries**

```
Current: /api/stats query takes 2 seconds; impacts DB CPU

Root cause: Full table scan on 1M prospects

Fix: Add indexes + implement materialized view

  CREATE INDEX idx_prospects_workspace_status ON prospects(workspaceId, status);
  
  CREATE MATERIALIZED VIEW prospect_stats_daily AS
    SELECT workspaceId, status, COUNT(*) as count
    FROM prospects
    GROUP BY workspaceId, status;
  
  REFRESH MATERIALIZED VIEW prospect_stats_daily; -- runs nightly

  /api/stats now queries view (instant) instead of aggregating (2 sec)

Cost impact:
  - View refresh: +1 min CPU per night (negligible)
  - Query time: 2 sec → 10 ms (20x faster)
  - Database CPU: 70% → 50% peak (10% reserved for growth)
  - Outcome: Can delay DB upgrade from 4 months → 12 months
  - Savings: $200 × 8 months = $1,600
```

**5. Implement tiered storage**

```
Current: All data on hot storage (fast, expensive)

Optimization:
  - Sends > 90 days old → archive to S3 (cold storage, $0.01/GB/month)
  - Audit logs > 90 days old → archive to S3
  
Example:
  Current: 500M sends × 200 bytes = 100 GB on DB (cost: ~$50/month)
  After archival: 50M sends × 200 bytes = 10 GB on DB + 90 GB on S3 ($0.90/month)
  
  Savings: $49/month
  Trade-off: Archived data takes 1-2 hours to access (vs. instant from DB)
  Recommendation: Implement after 6+ months of operation (plenty of archive data)
```

---

## Capacity Planning Timeline

### Quarterly Capacity Review

**Every 3 months, review:**

```
Q1 Review (Jan):
  1. Actual growth vs. forecast
  2. Bottleneck evolution (update scorecard)
  3. Next quarter scaling plan
  4. Cost trends

Q2 Review (Apr):
  1. Did Q1 scaling (if any) improve capacity?
  2. Are new features (Discover & Outreach) driving usage?
  3. Update 12-month forecast
  4. Identify cost optimization opportunities
```

### 12-Month Capacity Roadmap

**Recommended timeline (based on linear growth forecast):**

```
Month 1-3: GROWTH PHASE
  - Monitor: 🟢 All green (no action needed)
  - Focus: Implement optimizations (indexes, caching)
  - Cost: $650/month (stable)

Month 4-6: OPTIMIZATION PHASE
  - Scale: Database indexes + query optimization
  - Monitor: Improve slow query performance
  - Expected: 50% latency improvement, no infrastructure scaling needed
  - Cost: $650/month (stable)

Month 7-9: FIRST SCALING PHASE
  - Scale: Add 3rd API replica (3x redundancy; prepare for viral growth)
  - Scale: Double worker replicas to 2 (prepare for email volume spike)
  - Database: Archive old audit logs (free up ~20 GB)
  - Cost: $750/month (+15%)

Month 10-12: MONITORING PHASE
  - Monitor: Is growth tracking forecast?
  - Plan: 2027 roadmap based on actual growth trends
  - Decision: Expand to multiple regions? Add Discover & Outreach infrastructure?
  - Cost: $750/month (stable)

Year 2: Reassess based on actual vs. forecast
  - If growth exceeded forecast: more aggressive scaling
  - If growth lagged forecast: consider cost reductions
  - If new features launched: plan feature-specific capacity
```

### Capacity Planning Checklist (Monthly)

```
[ ] 1. Review capacity scorecard (all metrics in target range?)
[ ] 2. Check growth trends (customers, emails, API requests)
[ ] 3. Review slowest queries (Grafana slow query log)
[ ] 4. Check storage growth (on track for forecast?)
[ ] 5. Review error budget burn (on track for SLO?)
[ ] 6. Verify all alerts are firing correctly
[ ] 7. Document any scaling actions taken
[ ] 8. Update 12-month forecast
[ ] 9. Identify next optimization opportunity
[ ] 10. Communicate plan to product + finance teams
```

---

## Related Documentation

- [`docs/OPERATIONS.md`](../OPERATIONS.md) — Operational procedures
- [`docs/SLO.md`](../SLO.md) — Service level objectives (performance targets)
- [`docs/LOAD_TESTING.md`](../LOAD_TESTING.md) — Load testing procedures

