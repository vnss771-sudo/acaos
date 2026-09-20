# ACAOS Operational Procedures

**Objective:** Day-to-day operational practices for running ACAOS in production.

**Audience:** Site reliability engineers, platform engineers, operations team

**Last Updated:** 2026-09-20

---

## Table of Contents

1. [Daily Operations Checklist](#daily-operations-checklist)
2. [Monitoring and Observability](#monitoring-and-observability)
3. [Scaling Procedures](#scaling-procedures)
4. [Performance Tuning](#performance-tuning)
5. [Data Management](#data-management)
6. [Backup and Recovery](#backup-and-recovery)
7. [Access Control and Auditing](#access-control-and-auditing)
8. [Customer Support Workflows](#customer-support-workflows)

---

## Daily Operations Checklist

### Morning (9 AM)

**Time: ~15 minutes**

```bash
#!/bin/bash

# 1. Service Status
echo "=== Service Health Check ==="
curl -s https://api.acaos.example.com/api/live | jq '.ok'
curl -s https://api.acaos.example.com/api/ready | jq '.ok'
curl -s https://acaos.example.com/api/health | jq '.ok'

# 2. Error Budget Status
echo "=== Error Budget (24h window) ==="
# Check Grafana: Dashboard → Service Overview → Error Budget Gauge
# Expected: >95% (SLO is 99.9%, budget burn <0.1%)

# 3. Recent Deployments
echo "=== Last 3 Deployments ==="
gh api repos/company/acaos/deployments -l 3 --jq '.[] | "\(.created_at) \(.environment) \(.ref)"'

# 4. Alert Status
echo "=== Active Alerts ==="
# Check Alertmanager: https://alertmanager.example.com/
# Expected: none firing (or only acknowledged maintenance alerts)

# 5. Database Health
echo "=== Database Connection Pool ==="
curl -s https://api.acaos.example.com/api/health | jq '.db'
# Expected: { ok: true, pool: { used: <10, available: >20 } }

# 6. Queue Depth
echo "=== Background Queue Status ==="
# Check Grafana: Metrics → bullmq_queue_jobs
# Expected: all queues have depth ~0 (send-campaign, sync-mailbox, etc)

echo "✅ Morning checklist complete"
```

### Throughout the Day

- **Every 30 minutes:** Monitor Slack alerts channel for any firing alerts
- **On each deploy:** Verify smoke tests pass (see [DEPLOYMENT_RUNBOOK](./DEPLOYMENT_RUNBOOK.md))
- **On customer support request:** Check audit logs (see [Customer Support Workflows](#customer-support-workflows))

### Evening (6 PM)

**Time: ~10 minutes**

```bash
#!/bin/bash

# 1. Error rate (24h)
echo "=== 24h Error Rate ==="
# Grafana: Service Overview → HTTP 5xx rate (last 24h)
# Expected: <0.5%

# 2. SLA compliance
echo "=== SLA Metrics ==="
# Grafana: SLO dashboard
# Expected: Availability >99.9%, Success Rate >99.9%

# 3. Peak latency
echo "=== Peak Latency (24h) ==="
# Grafana: Latency p99 (last 24h)
# Expected: <2s sustained

# 4. Resource utilization
echo "=== Resource Utilization ==="
# Grafana: Infrastructure → DB connections, Redis memory, CPU
# Expected: All <80% peak

# 5. Any scheduled maintenance tonight?
echo "=== Maintenance Schedule ==="
grep -i "$(date +%Y-%m-%d)" /tmp/maintenance-schedule.txt || echo "None scheduled"

echo "✅ Evening checklist complete; hand off to night on-call"
```

---

## Monitoring and Observability

### Health Endpoints

**4 endpoints for different purposes:**

| Endpoint | Purpose | Use For | SLA |
|----------|---------|---------|-----|
| `GET /api/live` | Process alive? (no I/O) | Liveness probe; frequent polling | 100ms |
| `GET /api/ready` | Ready to serve traffic? (DB + config, Redis optional in non-prod) | Load-balancer readiness gate | 3s |
| `GET /api/ready/strict` | Ready incl. Redis (always required)? | For queued-flow-dependent deployments | 3s |
| `GET /api/health` | Full dependency status (DB, Redis, config) | Dashboard, troubleshooting | 1s |

**Testing all four:**

```bash
#!/bin/bash
set -e

API="https://api.acaos.example.com"

echo "1. Liveness (must always respond):"
curl -m 1 "$API/api/live" | jq .

echo "2. Readiness (gates traffic):"
curl -m 3 "$API/api/ready" | jq .

echo "3. Readiness strict (Redis required):"
curl -m 3 "$API/api/ready/strict" | jq .

echo "4. Health (all dependencies):"
curl -m 1 "$API/api/health" | jq .

echo "✅ All health endpoints responding"
```

### Metrics (Prometheus)

**Exposed on `GET /metrics` (requires `METRICS_TOKEN` in production):**

```bash
# Example scrape
curl -H "Authorization: Bearer $METRICS_TOKEN" https://api.acaos.example.com/metrics

# Key metrics to alert on:
# - http_requests_total{status=~"5.."} / rate — 5xx rate
# - http_request_duration_seconds (p99 histogram) — latency
# - http_requests_in_flight — saturation
# - process_resident_memory_bytes — memory growth
# - bullmq_queue_jobs{queue="send-campaign",state="waiting"} — outreach backlog
```

### Grafana Dashboards

**Pre-built dashboards in `ops/monitoring/`:**

1. **Service Overview** — Key metrics at a glance
   - HTTP requests by status
   - Latency (p50, p95, p99)
   - In-flight requests
   - Error budget burn

2. **Infrastructure** — Resource utilization
   - DB connection pool
   - Redis memory
   - API CPU/memory
   - Worker CPU/memory

3. **Queues** — Background job health
   - Queue depth by type (send-campaign, sync-mailbox, etc)
   - Job completion time
   - Job failure rate

4. **SLO** — Availability targets
   - Success rate (SLO 99.9%)
   - Availability (SLO 99.9%)
   - Error budget remaining

### Structured Logging

Every request logs a JSON event with:

```json
{
  "level": "info",
  "timestamp": "2026-09-20T10:30:45.123Z",
  "requestId": "clx9z3k9p0000...",
  "method": "POST",
  "route": "/api/leads/:id",
  "status": 200,
  "durationMs": 45,
  "userId": "user_123",
  "workspaceId": "ws_456",
  "ip": "203.0.113.42"
}
```

**Accessing logs:**

```bash
# Via Railway dashboard:
# Services → acaos-api → Logs (tail real-time)

# Via Sentry (if SENTRY_DSN configured):
# Sentry → Issues → filter by release, environment, etc

# Custom queries (if centralized logging configured):
# Example: CloudWatch Logs
aws logs tail /acaos/production --follow

# Filter for errors only
aws logs tail /acaos/production --filter-pattern "ERROR"
```

### Error Capture (Sentry)

If `SENTRY_DSN` is configured, all exceptions auto-report to Sentry:

```bash
# 1. Check recent issues
# Sentry → Issues (filter by release, environment)

# 2. Investigate a specific issue
# Click issue → View recent events → Stack trace analysis

# 3. Resolve an issue (after fix deployed)
# Issue → Resolve → Select resolution:
#   - "Fixed in release v1.3.0"
#   - "Ignored" (known false positive)
#   - "Regression" (was fixed, came back)

# 4. Alert on new issue group
# Sentry → Alerts → Create new:
#   Condition: "A new issue is created"
#   Action: "Send to Slack #acaos-alerts"
```

---

## Scaling Procedures

### Horizontal Scaling (Adding Replicas)

**API Service** (stateless, scale freely):

```bash
# Via Railway dashboard
# Services → acaos-api → Replicas: change from 2 to 3

# Verify
curl https://api.acaos.example.com/api/ready | jq .
# Should respond within 3s (one of 3 replicas answers)

# Monitor during ramp-up
# Grafana: HTTP latency p99 should stay flat
# Latency spikes indicate downstream bottleneck (DB, external APIs)
```

**Worker Service** (stateless, scales independently):

```bash
# Via Railway dashboard
# Services → acaos-worker → Replicas: change from 1 to 2

# Workers share queues via Redis/BullMQ
# Multiple workers process jobs in parallel

# Monitor queue drain time
# Grafana: bullmq_queue_jobs{queue="send-campaign"} should decrease
# If it stays constant → external bottleneck (SMTP, API rates)
```

**Scaling Triggers:**

| Metric | Threshold | Action |
|--------|-----------|--------|
| API in-flight requests | >100 avg | Scale API +1 replica |
| API p99 latency | >1.5s sustained | Investigate slowness; then scale if it's load |
| send-campaign queue | >200 waiting | Scale worker +1 replica |
| DB connections used | >80% pool | Increase `connection_limit` or scale API |
| Redis memory | >80% allocated | Increase instance size; check for memory leaks |

### Vertical Scaling (Increasing Resources)

**API/Worker CPU/Memory:**

```bash
# Via Railway dashboard
# Services → acaos-api → Settings → Compute
# Change CPU: 1 → 2, Memory: 1 GB → 2 GB

# Old replicas are drained (graceful shutdown ~30s)
# New replicas start with larger allocation
# Downtime: ~2-3 min per replica (staggered)
```

**Database CPU/Memory:**

```bash
# ⚠️  Downtime event (PostgreSQL doesn't live-migrate)
# Maintenance window required

# Via Railway dashboard
# Services → acaos-db → Settings → Compute
# Increase CPU/memory as needed

# Recommended values (scale from here):
# Small (dev): 1 CPU, 1 GB
# Medium (100-500k emails/month): 2 CPU, 4 GB
# Large (1M+): 4+ CPU, 8+ GB
```

**Redis CPU/Memory:**

```bash
# Via Railway dashboard
# Services → acaos-redis → Settings → Compute
# Increase as needed; brief connection interruption during restart

# Monitor before scaling
# If memory >80%: check for unbounded cache growth
#   → Restart Redis (clears in-memory cache)
#   → Check STATS_CACHE_TTL_MS (default 5s)
```

### Example Scaling Scenario

**Scenario:** Morning spike; 500 outreach emails queued, send-campaign backlog growing.

**Timeline:**

```
06:00 — 100 emails sent/min (normal)
08:00 — Spike begins; 500 waiting jobs
08:05 — AlertManager: SendCampaignBacklog alert fires
        Latency OK, API saturation OK
        Worker is up but can't keep pace

Action:
08:06 — Scale worker: 1 → 2 replicas
        Worker 2 joins Redis cluster
        Jobs now process 2x faster (assuming external limits allow)

08:15 — Queue drains to 0
        Alert auto-resolves
        Revert to 1 replica after 30 min if stable
```

---

## Performance Tuning

### Connection Pooling

**PostgreSQL:**

```bash
# Current pool size (default or from DATABASE_URL)
echo "Database connection pool:"

# If experiencing "ECONNREFUSED" or "ready fails with DB timeout":
# 1. Check in-flight requests (Grafana)
# 2. Scale API replicas (adds more pool instances)
# 3. OR increase DB_POOL_SIZE (per-process limit)

# In .env or Railway Variables:
DB_POOL_SIZE=25     # default ~5; increase for high traffic
```

**Redis:**

```bash
# Redis is single-threaded; scale via replicas (multiple workers)
# Cluster mode: requires more complex setup; not needed at < 1M events/month

# If Redis latency spikes:
# 1. Check memory usage (Grafana)
# 2. Restart Redis (clears cache)
# 3. Identify queries creating unbounded caches
```

### Query Performance

**Slow `/api/stats` endpoint:**

```bash
# /api/stats aggregates workspace stats (expensive Prisma query)
# Cached via single-flight + TTL (default 5s)

# If stats are slow (>1s to first response):
# 1. Check DB load (Grafana: connections used, CPU)
# 2. Run ANALYZE on prospect/campaign/lead tables (db admin only)
# 3. Reduce STATS_CACHE_TTL_MS if re-computing is faster than memory bloat

STATS_CACHE_TTL_MS=1000   # 1s (aggressive); default 5s
```

**Slow `/api/prospects/search` endpoint:**

```bash
# Prospects search with 10k+ rows is expensive without filters

# If search is slow:
# 1. Index prospect columns (check db migrations)
# 2. Add filter (status, plan, tier) to narrow result set
# 3. Add pagination (limit 50, offset/cursor)
```

### Rate Limiting

**Global rate limit:**

```bash
# Default: 100 requests per 60 seconds per IP
GENERAL_RATE_LIMIT_REQUESTS=100
GENERAL_RATE_LIMIT_WINDOW_MS=60000

# If legitimate traffic is rate-limited:
# 1. Whitelist IP (TRUSTED_PROXIES; see CONFIGURATION.md)
# 2. Increase limit per IP
# 3. Use API key instead of session auth (higher limits)
```

### Memory Leaks

**Signs:**

- `process_resident_memory_bytes` grows continuously (no plateau)
- API replica crashes with OOM after 24-48h
- Restart fixes it, but it recurs

**Diagnosis:**

```bash
# 1. Check for unbounded caches
grep -r "Map\|Set" apps/api/src/lib/*.ts
# If found, add max-size limit or TTL

# 2. Check for connection leaks
# (prisma pools, redis connections held open)

# 3. Dump heap profiler (if Node.js tools available)
# node --inspect api.js
# Connect Chrome DevTools, record heap snapshot
```

---

## Data Management

### Data Retention

**ACAOS retains data per the policy in [`docs/DATA_RETENTION.md`](../DATA_RETENTION.md):**

| Entity | Retention | Notes |
|--------|-----------|-------|
| Prospect | 2 years | Unless user exports/archives |
| Sent email | 1 year | Audit trail |
| Audit event | 90 days | Compliance; can be extended |
| Analytics event | 30 days | Internal funnel tracking |

**Automated purge job:**

```bash
# Runs daily (configurable via RETENTION_PURGE_INTERVAL_MS)
# Deletes records older than retention window
# Non-blocking (runs in worker queue)

# Monitor purge success
curl -H "Authorization: Bearer $METRICS_TOKEN" https://worker.acaos.example.com:9090/metrics \
  | grep retention_purge_records
```

### Exporting Customer Data

**On request (GDPR data subject request):**

```bash
# 1. Identify the workspace
workspaceId=$(curl -s -H "Authorization: Bearer $JWT_TOKEN" \
  https://api.acaos.example.com/api/workspaces | jq -r '.[0].id')

# 2. Export all data for that workspace
curl -H "Authorization: Bearer $JWT_TOKEN" \
  https://api.acaos.example.com/api/admin/export \
  -d "{ \"workspaceId\": \"$workspaceId\" }" > export.json

# 3. Package and send securely to customer
```

### Deleting Customer Data

**On account cancellation (via API or manual):**

```bash
# 1. Trigger workspace deletion (hard delete)
curl -X DELETE \
  -H "Authorization: Bearer $ADMIN_JWT" \
  https://api.acaos.example.com/api/workspaces/$workspaceId

# This cascades to:
# - All users in workspace
# - All prospects, campaigns, emails
# - All audit events (except cross-tenant ones)
# - Stripe subscription cancellation (automatic via webhook)

# 2. Verify deletion
curl -H "Authorization: Bearer $JWT" \
  https://api.acaos.example.com/api/workspaces/$workspaceId
# Expected: 404 Not Found
```

---

## Backup and Recovery

### Database Backups

**Automated (Railway handles):**

- Daily backups retained for 7 days
- Access via Railway dashboard: postgres → Backups

**Manual backup (before risky operations):**

```bash
# Via Railway SSH
railway ssh

# Inside container
pg_dump -U postgres acaos > /tmp/backup-$(date +%s).sql

# Copy out
exit
scp postgres@pg.internal:/tmp/backup-*.sql ./backups/
```

**Restore from backup:**

```bash
# 1. Stop API (stop migrations from running)
# 2. Connect to PostgreSQL
railway ssh

# 3. Restore
psql -U postgres < /tmp/backup-1695136800.sql

# 4. Verify schema
\d+

# 5. Restart API
# API will run migrations as needed (should all already be applied)
```

### Redis Backups

**For production Redis:** Use Redis persistence (`AOF` or `RDB`)

```bash
# Railway Redis: automatically persists to disk
# Snapshots taken periodically; check Railway dashboard for restore options

# Manual backup (if needed)
redis-cli BGSAVE    # Background RDB snapshot
# File: /var/lib/redis/dump.rdb (inside container)
```

### Point-in-Time Recovery

**Scenario:** Accidentally deleted customer data (prospects, emails, etc).

**Recovery steps:**

```
1. Alert the customer (SLA: notify within 1h)
2. Stop the API (no new data during recovery)
3. Restore PostgreSQL from backup (choose moment before deletion)
4. Verify data is recovered (check prospect count, etc)
5. Restart API
6. If deleted data is unrecoverable, escalate to customer success

MTTR target: <30 min
```

---

## Access Control and Auditing

### User Access Levels

| Role | Capabilities | Workspace-scoped? |
|------|--------------|-------------------|
| Owner | Full workspace control; billing, team management | Yes |
| Admin | Team management, settings, but not billing | Yes |
| Operator | Send outreach, approve replies, view analytics | Yes |
| Viewer | Read-only access to dashboards | Yes |
| Platform Admin | Cross-tenant /api/admin panel, user management | No (org-wide) |

**Granting access:**

```bash
# 1. User logs in (creates account if needed)
# 2. Owner invites user to workspace (email)
# 3. User accepts invite → joins with Operator role by default
# 4. Owner can promote to Admin via Settings → Team

# Example: Invite via API
curl -X POST https://api.acaos.example.com/api/workspaces/$workspaceId/invite \
  -H "Authorization: Bearer $JWT" \
  -d "{ \"email\": \"teammate@company.com\", \"role\": \"operator\" }"
```

### Audit Logging

**All significant actions are logged in `AuditEvent` table:**

```bash
# Access audit log via API
curl -H "Authorization: Bearer $JWT" \
  https://api.acaos.example.com/api/admin/audit \
  -d "{ \"workspaceId\": \"$workspaceId\", \"limit\": 100 }"

# Response:
[
  {
    "id": "event_123",
    "type": "SEND_CAMPAIGN",
    "actorUserId": "user_456",
    "entityType": "Campaign",
    "entityId": "campaign_789",
    "metadata": { "contactCount": 50, "templateId": "template_x" },
    "createdAt": "2026-09-20T10:30:00Z"
  },
  ...
]

# Types: SEND_CAMPAIGN, APPROVE_REPLY, ROTATE_API_KEY, CHANGE_BILLING, etc
```

**Exporting audit log (compliance):**

```bash
# Full workspace audit trail (SOC2, HIPAA audit)
curl -H "Authorization: Bearer $ADMIN_JWT" \
  https://api.acaos.example.com/api/admin/audit-export \
  -d "{ \"workspaceId\": \"$workspaceId\", \"startDate\": \"2026-01-01\" }" \
  > audit-trail.json
```

### API Key Rotation

**For platform integrations:**

```bash
# 1. Create new API key
curl -X POST https://api.acaos.example.com/api/workspaces/$workspaceId/api-keys \
  -H "Authorization: Bearer $JWT"
# Response: { "id": "key_new", "secret": "acaos_..." }

# 2. Update customer's integration to use new secret

# 3. Revoke old key
curl -X DELETE https://api.acaos.example.com/api/api-keys/$oldKeyId \
  -H "Authorization: Bearer $JWT"

# 4. Audit event auto-logs: ROTATE_API_KEY
```

---

## Customer Support Workflows

### Debugging Customer Issue: "Emails not sending"

```bash
#!/bin/bash

WORKSPACE_ID="ws_123"
JWT_TOKEN="eyJ..."

echo "=== Debugging: Emails not sending ==="

# 1. Check workspace is active and billing current
echo "Workspace status:"
curl -s -H "Authorization: Bearer $JWT_TOKEN" \
  https://api.acaos.example.com/api/workspaces/$WORKSPACE_ID | jq '{ status: .plan, billingStatus: .subscriptionStatus }'

# 2. Check email configuration (SMTP credentials)
echo "Email config:"
curl -s -H "Authorization: Bearer $JWT_TOKEN" \
  https://api.acaos.example.com/api/workspaces/$WORKSPACE_ID/email-config | jq '.{ host, port, configured: (.smtpPassword != null) }'

# 3. Check if campaign was sent
CAMPAIGN_ID="camp_456"
echo "Campaign send status:"
curl -s -H "Authorization: Bearer $JWT_TOKEN" \
  https://api.acaos.example.com/api/campaigns/$CAMPAIGN_ID | jq '{ status, sentCount, errorCount }'

# 4. Check if emails are stuck in queue
echo "Queue depth:"
curl -s -H "Authorization: Bearer $METRICS_TOKEN" \
  https://worker.acaos.example.com:9090/metrics | grep 'bullmq_queue_jobs.*send-campaign'

# 5. Check worker is running
echo "Worker health:"
curl -s -H "Authorization: Bearer $METRICS_TOKEN" \
  https://worker.acaos.example.com:9090/live | jq '.ok'

# 6. Common causes:
# - Invalid SMTP credentials → Test with telnet host:port
# - Workspace billing past due → Check Stripe subscription
# - Campaign not approved → Check approval status
# - Queue backlog → Scale worker (see Scaling Procedures)
# - SMTP rate limit → Spread sends over longer window
```

### Debugging: "High email bounce rate"

```bash
#!/bin/bash

echo "=== High bounce rate investigation ==="

# 1. Get bounce statistics
curl -s -H "Authorization: Bearer $JWT" \
  https://api.acaos.example.com/api/campaigns/$CAMPAIGN_ID/stats \
  | jq '{ bounced, bounceRate: (.bounced / .sent) }'

# 2. Sample bounced emails
curl -s -H "Authorization: Bearer $JWT" \
  https://api.acaos.example.com/api/campaigns/$CAMPAIGN_ID/bounces?limit=10 \
  | jq '.[] | { email, reason, timestamp }'

# 3. Check SMTP provider logs
# (if using external SMTP: AWS SES, SendGrid, etc)

# 4. Common causes:
# - Prospect list contains invalid emails → Validate list before send
# - IP reputation problem → Check with ISP; may need warmup
# - Content triggering spam filters → Review copy and sender domain
# - Rate exceeded → Space sends over longer window
```

### Debugging: "API returning 500 errors"

```bash
#!/bin/bash

echo "=== Debugging API 5xx ==="

# 1. Check if issue is still occurring
curl -i https://api.acaos.example.com/api/ready

# 2. Check recent errors in Sentry
# Sentry → Issues → filter by:
#   Environment: production
#   Release: v1.3.0 (current running version)
#   Timeline: Last hour

# 3. Narrow to affected endpoint
echo "500 rate by route (Grafana):"
# Grafana → Metrics → http_requests_total{status="500"} by route

# 4. If restarting API helps → likely memory leak or pool exhaustion
# If consistent → likely config/dependency problem

# 5. Check logs
curl -s https://api.acaos.example.com/api/health | jq '.db'
# If db.ok = false → database is down or unreachable

# 6. Mitigation options:
# - Restart API replica (if transient)
# - Scale up replicas (if capacity)
# - Rollback to previous release (if deploy-correlated)
# - Page on-call engineer (if sustained)
```

### Escalation Path

```
Customer reports issue
        ↓
    [Check standard debugging checklist above]
        ↓
  ┌─────────────────┐
  │ Can be resolved │ → Customer Success → Fix → Document
  │ in < 30 min?    │
  └─────────────────┘
        ↓ No
  ┌─────────────────┐
  │ Is it a service │ → Page SRE → Incident response
  │ outage?         │
  └─────────────────┘
        ↓ No
  Platform engineering → Root cause analysis → Post-mortem

SLA:
- P1 (service down): Respond <15 min, resolve <1 hour
- P2 (feature broken): Respond <1 hour, resolve <4 hours
- P3 (degraded): Respond <4 hours, resolve <24 hours
```

---

## Emergency Procedures

### Service Outage (API Down)

**Detection:** AlertManager fires `EndpointDown` alert.

**1-minute response (every minute counts):**

```bash
# 1. Page on-call engineer (auto-triggered)
# 2. Check if issue is real
curl https://api.acaos.example.com/api/live

# 3. If unresponsive:
#    - Check Railway dashboard: is service running? (Status = "Running")
#    - Check recent deploy: did issue coincide with deploy?
#    - Check logs: any errors?

# 4. Initial mitigation:
if [[ recent_deploy == true ]]; then
  # Rollback (see DEPLOYMENT_RUNBOOK.md)
  gh workflow run release.yml --ref main --inputs version=v1.2.0
else
  # Restart the service
  # Railway dashboard → acaos-api → Restart all replicas
fi

# 5. Verify recovery
curl https://api.acaos.example.com/api/ready | jq '.ok'
```

### Database Down

**Detection:** `/api/ready` fails (db.ok = false); AlertManager: `DependencyDown`.

**Response:**

```bash
# 1. Check database is running
#    Railway dashboard → acaos-db → Status should be "Running"

# 2. If restarting helps:
#    - Click Restart (brief downtime ~2 min)
#    - Verify connection pool recovers

# 3. If database is corrupted:
#    - See [Backup and Recovery](#backup-and-recovery)
#    - Restore from last known good backup
#    - Notify customer of data loss window
```

### Redis Down

**Detection:** Worker jobs queue and don't drain; API in non-production can still serve (readiness lenient).

**Response:**

```bash
# 1. Restart Redis
#    Railway dashboard → acaos-redis → Restart

# 2. Wait for worker to reconnect (~10s)

# 3. Verify queue drains
#    Check metrics: bullmq_queue_jobs{state="waiting"} → 0

# 4. If persistent issues:
#    - Scale worker replicas (more workers = faster drain)
#    - Increase worker concurrency: WORKER_CONCURRENCY=20
```

### Cascading Failures

**Scenario:** Dependency (Stripe, OpenAI, Apollo) is down; customer outreach/AI features blocked.

**Response:**

```bash
# 1. Confirm dependency is the problem
#    - Not our issue? (Our service is healthy)
#    - Notify customer via status page
#    - Document SLA violation (if applicable)

# 2. Circuit breaker engagement (if enabled):
#    - Provider calls automatically fail-fast after 5 consecutive errors
#    - User gets "Provider unavailable" message instead of 500 timeout
#    - Prevents cascading latency into other parts of the system

# 3. Workarounds:
#    - Disable features that require the dependency (feature flags)
#    - Route traffic to fallback (if available)
#    - Wait for dependency recovery
```

---

## Related Documentation

- [`docs/OPERATIONS.md`](../OPERATIONS.md) — Full operational guide
- [`docs/RUNBOOKS.md`](../RUNBOOKS.md) — Alert runbooks
- [`docs/SLO.md`](../SLO.md) — SLA/SLO targets
- [`docs/INCIDENT_RESPONSE.md`](./INCIDENT_RESPONSE.md) — Incident response procedures
- [`docs/CAPACITY_PLANNING.md`](./CAPACITY_PLANNING.md) — Scaling and growth planning

