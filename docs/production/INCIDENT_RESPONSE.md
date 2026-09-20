# ACAOS Incident Response Guide

**Objective:** Structured procedures for responding to production incidents with minimal customer impact.

**Audience:** On-call engineers, incident commanders, SRE team

**Last Updated:** 2026-09-20

---

## Table of Contents

1. [Incident Classification](#incident-classification)
2. [General Response Framework](#general-response-framework)
3. [Specific Incident Procedures](#specific-incident-procedures)
4. [Investigation Techniques](#investigation-techniques)
5. [Communication Templates](#communication-templates)
6. [Post-Incident Activities](#post-incident-activities)

---

## Incident Classification

### Severity Levels

| Level | Description | SLA | Action |
|-------|-------------|-----|--------|
| **P1** | Service entirely down or major data loss | <15 min response<br><1 hour resolve | Page all on-call; declare incident |
| **P2** | Core feature unavailable to 50%+ customers | <30 min response<br><4 hours resolve | Page SRE team; declare incident |
| **P3** | Feature degraded or 1-10% customers affected | <2 hours response<br><24 hours resolve | Assign to engineer; don't interrupt on-call |
| **P4** | Minor issue; cosmetic or very limited scope | <24 hours response | Backlog; no incident process |

### Impact Assessment (first 5 minutes)

**Ask these questions to determine severity:**

```
1. Are customers unable to access the service?
   YES → P1/P2 (depends on customer count)

2. Can customers still send outreach (core feature)?
   YES → P3 (feature X is down but core works)

3. Have we received customer complaints?
   Multiple reports → affects P rating upward
   
4. Is error budget being burned?
   >5% per hour → P1/P2 (escalate)
   
5. Do we know the root cause?
   Not yet → declare incident, open investigation
```

---

## General Response Framework

### The First 5 Minutes: STOP-ASSESS-ACT

#### STOP (0-1 min)

```
On-call engineer pages in.

1. Confirm: Is AlertManager firing?
   - Read the alert (what, when, which service)
   - Is it a false alarm? (e.g., network hiccup)

2. Declare severity: P1, P2, P3, or P4?
   - Check customer impact (active users, error rate, etc)

3. Page escalation path (if P1/P2):
   - DECLARE INCIDENT (triggers Slack channel #incidents)
   - Page incident commander
   - Page SRE on-call + 1 more engineer
```

#### ASSESS (1-3 min)

```
1. Verify the problem is real:
   curl -f https://api.acaos.example.com/api/live
   curl -f https://api.acaos.example.com/api/ready
   # If both fail: service is down

2. Check error rate / latency:
   Grafana → Service Overview
   # Spike visible? When did it start?

3. Correlate with recent events:
   - Latest deploy time (GitHub Actions)
   - Database schema migration
   - Third-party API changes (Stripe, OpenAI)
```

#### ACT (3-5 min)

```
1. Immediate mitigation (if available):
   - Rollback to previous version?
   - Restart failed service?
   - Scale up replicas?

2. If mitigation works:
   - Continue to investigation
   - Resolve alert

3. If mitigation doesn't work:
   - Proceed to full incident response (below)
```

### Incident Management

**Incident channel:** `#incidents` in Slack (auto-created by AlertManager)

**Incident commander:** Leads the response (declared in Slack)

```
Incident commander's role:
1. Assign investigation to 1+ engineers
2. Keep status updates flowing every 5 minutes (if P1) or 15 min (if P2)
3. Call executive escalation (if customer-facing SLA breach imminent)
4. Declare incident resolved when:
   - Root cause identified and fixed
   - All systems back to green
   - Customers confirm no issues
```

**Incident declaration template:**

```
[Slack message to #incidents]

🚨 INCIDENT DECLARED: P1 - API Down

**Severity:** P1 (service unavailable)
**Start time:** 2026-09-20 10:30:15 UTC
**Customer impact:** All customers; unable to send outreach

**Incident Commander:** @engineering-oncall
**Investigating:** API service (check logs)
**Estimated MTTR:** TBD

**Status:** INVESTIGATING (first update in 5 min)
```

---

## Specific Incident Procedures

### Incident 1: API Service Down

**Symptom:**
- `/api/live` and `/api/ready` both return error (not 200)
- Customers report "connection refused" or "service unavailable"
- AlertManager: `EndpointDown` + `ApiTargetDown`

**Root Cause:** (most to least common)

1. Container crashed (OOM, exception, invalid config)
2. Database unreachable (connection timeout, authentication)
3. Deployment failed (bad image, missing environment variable)
4. Infrastructure failure (Railway service down, network misconfiguration)

**Response (5-minute timeline):**

```
00:00 — Alert fires; declare P1 incident

00:01 — Check if service is running
        Railway dashboard → acaos-api → Status
        ✗ "Exited" or "Crashed" → restart
        ✓ "Running" → continue investigation

00:02 — Check logs (identify crash reason)
        Railway dashboard → acaos-api → Logs (tail last 100 lines)
        Look for: "uncaughtException", "out of memory", "ECONNREFUSED"

        If OOM:
          → Likely memory leak in new version
          → ROLLBACK (see step 00:05)

        If "ECONNREFUSED" (database):
          → Check database service
          → If database is down: wait for recovery + restart API
          → If database is up: check connection string (wrong password, etc)

        If config error (missing JWT_SECRET, etc):
          → Check Railway Variables
          → Add missing variable
          → Restart API

00:03 — If no clear cause in logs:
        Check recent events:
        - Did we deploy in the last 5 min? (ROLLBACK)
        - Did database restart? (wait for recovery + restart API)
        - Check Sentry for exceptions: https://sentry.io/acaos?query=release:v1.3.0

00:05 — If still down, ROLLBACK to previous version
        gh workflow run release.yml --ref main --inputs version=v1.2.0

        Monitor health gate:
        curl https://api.acaos.example.com/api/ready

00:10 — If rollback succeeds → incident resolved; investigate what went wrong in v1.3.0
        If rollback fails → infrastructure issue; escalate to infrastructure team
```

**Communication to customers (at 00:03):**

```
[Status page update]

🔴 INVESTIGATING: API service temporarily unavailable

We're aware that the API is intermittently unavailable (started 2026-09-20 10:30 UTC).
We're investigating the root cause and will have an update within 10 minutes.

Current status: Rolling back to previous stable version.

Affected: All services (web, API, email sending)
Estimated resolution: 5-10 minutes
```

### Incident 2: Database Connection Pool Exhausted

**Symptom:**
- `/api/ready` intermittently returns 503 (database check times out)
- Latency p99 spikes to >3s
- "too many connections" errors in Sentry
- API services start rejecting new requests

**Root Cause:** (most to least common)

1. Legitimate traffic spike; connection pool is undersized
2. Memory leak or connection leak in code; connections never released
3. Slow query; connections held for 30+ seconds
4. Database is slow due to disk/CPU saturation

**Response (15-minute timeline):**

```
00:00 — Alert: ApiHighLatencyP99 + ApiSaturation fires

00:01 — Confirm: Check Grafana dashboard
        - HTTP latency p99: >1.5s? ✓
        - In-flight requests: >100? ✓
        - DB connections used: >80%? ✓
        - Correlate: is traffic really spiking or is it hanging requests?

00:02 — Check connection pool configuration
        API service logs: grep "connection" (look for "pool full", etc)
        
        Via API:
        curl https://api.acaos.example.com/api/health | jq '.pool'
        
        Expected: { used: <20, available: >5 }
        Actual: { used: 28, available: 0 } → POOL EXHAUSTED

00:03 — Option A: Scale API replicas (add more pool instances)
        Railway dashboard → acaos-api → Replicas: 2 → 3
        (Each replica gets its own pool; total pool capacity +33%)
        
        Wait 30s for new replica to start; latency should drop

00:04 — If scaling didn't help → increase pool size per replica
        Railway Variables → DB_POOL_SIZE: 5 → 10
        Restart API replicas
        (Each pool now holds 10 instead of 5 connections)

00:05 — While mitigation running: investigate root cause
        Check slow queries:
        Grafana → Slow Queries (if query log is enabled)
        Top offender: /api/stats (expensive aggregation)
        → Likely connection leak if it returns normally but pool never recovers
        
        Check for connection leak:
        App code: look for prisma.$disconnect() missing
        Or redis connections not closed after error

00:10 — If pool stabilizes:
        - Incident resolved
        - Keep increased pool/replicas for rest of day
        - Schedule tuning review (post-incident)

00:15 — If pool never stabilizes → ROLLBACK to previous version
        New version introduced a connection leak
```

**Communication to customers (at 00:02):**

```
[Status page update]

🟡 DEGRADED: Experiencing higher latency (2026-09-20 10:30 UTC)

Some API requests are taking longer than usual.
We're scaling up database connection pool and expect resolution in 5 minutes.

Estimated impact: <10% of requests; retry should succeed
Estimated resolution: <10 minutes
```

### Incident 3: Worker Queue Backlog (Outreach Delayed)

**Symptom:**
- SendCampaignBacklog alert: >100 jobs waiting in send-campaign queue
- Customer reports: "I sent 50 emails 30 min ago, they're still pending"
- AlertManager: `SendCampaignBacklog`

**Root Cause:** (most to least common)

1. Worker service is down or unhealthy
2. SMTP provider is rejecting emails (rate limit, authentication)
3. External dependency timeout (Apollo lookup, AI inference); blocks queue processing
4. Worker concurrency is too low; can't keep pace with incoming jobs

**Response (10-minute timeline):**

```
00:00 — Alert fires; declare P2 incident (outreach delayed but service is up)

00:01 — Check worker service status
        Railway dashboard → acaos-worker → Status: "Running"? 
        If not → restart it
        
        Metrics:
        curl -H "Authorization: Bearer $METRICS_TOKEN" \
          https://worker.acaos.example.com:9090/metrics | grep bullmq
        
        Look for: bullmq_queue_jobs{queue="send-campaign",state="waiting"} > 100

00:02 — Check if worker is processing jobs or stuck
        Metrics: worker_jobs_total{queue="send-campaign",result="success"}
        If counter is increasing (over 30s) → worker is processing, just slow
        If counter is static → worker is hung

00:03 — Check worker logs for errors
        Railway dashboard → acaos-worker → Logs
        Look for: "ECONNREFUSED", "timeout", "rate limit"
        
        Common issues:
        - "Invalid SMTP credentials" → check EMAIL_PASSWORD
        - "Apollo quota exceeded" → wait for quota reset or reduce discovery
        - "OpenAI timeout" → external dependency issue; circuit breaker should kick in

00:04 — If SMTP is the problem:
        - Check SMTP provider status page (SendGrid, etc)
        - If provider is down: wait for recovery
        - If credentials are wrong: update environment; restart worker
        
00:05 — If worker is OK but queue is full:
        Scale worker replicas: 1 → 2
        OR increase worker concurrency: WORKER_CONCURRENCY: 5 → 20
        
        Multiple workers = parallel job processing = faster drain

00:07 — Monitor queue drain
        Watch metrics: bullmq_queue_jobs{state="waiting"} → should decrease
        
        If draining: incident resolved; monitor for 10 min
        If still stuck: investigate further (stuck job? deadlock?)

00:10 — If not improving:
        - Identify stuck job (check app logs for job ID)
        - Retry or dead-letter it
        - Clear space in queue
        - Scale worker more aggressively
```

**Communication to customers (at 00:01):**

```
[Status page update]

🟡 DEGRADED: Email sending delayed

Outreach emails are queued and sending slower than normal (started 2026-09-20 10:30 UTC).
We're increasing processing capacity and expect resolution within 10 minutes.

Affected: Campaign sends (replies from customers are not affected)
Estimated resolution: 10 minutes
```

### Incident 4: High Error Rate (5xx Spike)

**Symptom:**
- http_requests_total{status=~"5.."} rate spikes to >5%
- AlertManager: `ApiHigh5xxRate`
- Customers report "something went wrong" errors randomly

**Root Cause:** (most to least common)

1. New deploy introduced a bug
2. Third-party API down (OpenAI, Stripe, Apollo)
3. Database schema incompatible with running code (migration issue)
4. External dependency timeout cascading through system

**Response (5-minute timeline):**

```
00:00 — Alert fires; declare P2 incident

00:01 — Confirm 5xx rate in real time
        Grafana → HTTP Status by Code
        Current 5xx rate: X% (should be <0.5%)

00:02 — Identify which endpoints are failing
        Grafana → HTTP Requests by Route (filter status=500)
        Most common: /api/prospects/search, /api/leads, /api/stats
        
        Click on a 500 route → see logs

00:03 — Check Sentry for the exception
        Sentry → Issues (filter environment=production, release=v1.3.0)
        Top exception: [what is it?]
        
        If "ORM exception" → likely migration issue
        If "ECONNREFUSED" → likely dependency down
        If "Timeout" → likely slow query or external API

00:04 — Check recent deploy
        GitHub Actions → Workflows → latest release
        If deployed <5 min ago → ROLLBACK
        
        gh workflow run release.yml --ref main --inputs version=v1.2.0
        
        If deployed >30 min ago → issue is not deploy-related; proceed to investigation

00:05 — Check external dependencies
        If error is "STRIPE_ERROR" → Stripe is down
        If error is "OPENAI_TIMEOUT" → OpenAI API is slow
        
        → Check dependency status pages
        → If down: wait for recovery; circuit breaker should handle gracefully
        → If up: investigate why we're timing out (network issue?)

00:10 — If error rate is decreasing (either by rollback or time):
        Monitor for 10 more minutes to ensure stability
        
        If error rate stays elevated:
        - Rollback if not done already
        - Escalate to infrastructure team
        - Check database health (migration issue?)
```

**Communication to customers (at 00:01):**

```
[Status page update]

🔴 INVESTIGATING: Some API requests failing

We're experiencing elevated error rates (started 2026-09-20 10:30 UTC).
We're investigating the cause and rolling back the latest deploy as a precaution.

Current error rate: 8% (SLO is 99.9%)
Estimated resolution: 5-10 minutes
```

---

## Investigation Techniques

### Gathering Evidence

**1. Metrics (Grafana)**

```bash
Key questions:
- When did the incident start? (correlate with deploy, config change, traffic spike)
- Which service(s) are affected? (API only, or Worker+API?)
- What's the user impact? (error rate, latency, availability)

Check:
Grafana → Service Overview → all panels
- HTTP by status (5xx rate, 4xx rate)
- Latency p50/p95/p99
- In-flight requests
- Database pool utilization
- Worker queue depth
- Error budget burn
```

**2. Logs**

```bash
# API logs
Railway dashboard → acaos-api → Logs (search for "ERROR", "WARN")

# Worker logs
Railway dashboard → acaos-worker → Logs

# Filter for request-ID correlation
grep "request-id: abc123" logs.json
# All events for that request, across services

# Sentry (structured exceptions)
Sentry.io → Issues → sorted by frequency
# See which exceptions are most common in the affected time window
```

**3. Audit Trail**

```bash
# What changed recently?
git log --oneline -20      # recent commits
gh api repos/company/acaos/deployments -l 5
                          # recent deployments (who, when, what version)

# Kubernetes/Railway events
kubectl get events --sort-by='.lastTimestamp' | tail -20
# or Railway dashboard: see service restart history

# Database schema changes
git log --follow packages/db/prisma/schema.prisma | head -20
```

**4. Root Cause Analysis (RCA) Framework**

```
For each incident:

1. Timeline: Exactly when did the problem start? (to the minute)
   Example: 2026-09-20 10:30:15 UTC (confirmed by alert timestamp)

2. Trigger: What changed right before the problem?
   - Deploy? (yes → compare old and new code)
   - Infrastructure change? (resource scale, config update)
   - Traffic spike? (check request rate graph)
   - No obvious change? → external dependency issue

3. System state: What was broken?
   - Service crashed? (logs show exception)
   - Service slow? (latency spike, connection pool exhaustion)
   - Service erroring? (5xx rate spike, specific endpoint failing)

4. Immediate cause: Why did the trigger cause the break?
   Example: "New code in v1.3.0 has a memory leak in /api/stats.
            OOM after 2 hours of traffic → SIGKILL → service restarted"

5. Root cause: Why was this code deployed?
   Example: "Feature flag for /api/stats caching was missing.
            Without it, code loaded entire prospect DB into memory."

6. Prevention: How do we prevent this next time?
   Example: "Add /api/stats to test suite; test with 10k+ prospects.
            Add memory limits to Node.js container.
            Monitor memory trend; alert if growing >100MB/hour."
```

### Examples of RCA

**Example 1: Memory Leak**

```
Timeline: 2026-09-20 10:30 UTC (T+0, service down)

Deploy history:
- 09:00 UTC: v1.3.0 deployed (API + Worker)
- 10:00 UTC: Memory usage normal (~400 MB)
- 10:20 UTC: Memory usage growing (~600 MB)
- 10:30 UTC: Memory usage OOM (~1 GB limit) → container killed

Trigger: v1.3.0 deployed; code has memory leak

System state: API/Worker OOM'd; service restarted; new processes start low memory but leak again

Immediate cause: New code in v1.3.0 creates unbounded cache.
  Code snippet (in feature #xyz):
    const cache = new Map()    // No max size! grows unbounded
    cache.set(prospect.id, prospect)

Root cause: Code review missed the unbounded cache.

Prevention:
  - Update linting rule to flag unbounded data structures
  - Add memory-profiler to pre-deploy tests
  - Add Node.js memory limit --max-old-space-size (hard limit for OOM)
  - Monitor memory trend in production; alert on spike
```

**Example 2: Database Schema Mismatch**

```
Timeline: 2026-09-20 10:30 UTC (T+0, API returns 500)

Deploy history:
- 09:00 UTC: v1.3.0 deployed
  - Migration: ALTER TABLE prospects ADD COLUMN "tier" VARCHAR
  - Code: expects prospects.tier to exist

Problem: Migration didn't apply (API crashed before running migrations)

Trigger: API startup tried to apply migration; migration had syntax error; exit(1); didn't start

System state: API exited; LB pulled it from rotation; customers see 503

Immediate cause: Migration syntax error:
  ```sql
  ALTER TABLE prospects ADD COLUMN "tier" VARCHAR255  -- wrong! VARCHAR(255)
  ```

Root cause: Migration was not tested before deploy.
  Or: Migration was tested locally but schema differs from production.

Prevention:
  - Test migrations against production DB schema (in staging)
  - Add migration syntax validation to CI
  - Run migrations in staging before production promotion
```

---

## Communication Templates

### 1. Incident Declaration (Slack)

```
🚨 P1 INCIDENT: API Service Down

**When:** 2026-09-20 10:30:15 UTC
**Impact:** All customers; unable to access service

**Severity:** P1 (service completely unavailable)
**Incident Commander:** @john-smith

**Status:** INVESTIGATING (next update 2026-09-20 10:35:00)

**What we know:**
- Alert fire triggered by /api/ready returning 503
- API containers restarting (OOM suspected)
- Worker service unaffected

**What we're doing:**
- @alice-eng: Analyzing logs + memory profile
- @bob-ops: Monitoring container restart cycle
- Rolling back to v1.2.0 as precaution

**Next update:** 5 minutes (or sooner if resolved)
```

### 2. Customer Status Page Update (At T+2min)

```
🔴 SERVICE DOWN — API Temporarily Unavailable

We're experiencing an outage affecting all services (started 2026-09-20 10:30 UTC).

**Impact:**
- Web platform is unreachable
- Email sending is blocked
- API is down

**What we're doing:**
We've identified a potential issue in the latest deploy and are rolling back.

**Estimated time to resolution:** 10 minutes

**Updates:** Check back in 5 minutes | Subscribe to status updates
```

### 3. Customer Status Page Update (Resolution)

```
✅ RESOLVED — API Service Restored

The API outage has been resolved as of 2026-09-20 10:40 UTC (10 minute outage).

**Cause:** A memory leak in v1.3.0 caused the API service to crash.

**Resolution:** We rolled back to v1.2.0 and confirmed all systems are healthy.

**Data:** No customer data was lost.

**Post-mortem:** We'll post an incident analysis in 24 hours with details and prevention measures.

We apologize for the disruption. Thank you for your patience.
```

### 4. Post-Incident Email to Affected Customers

```
Subject: [RESOLVED] API Outage on 2026-09-20 (10 minute duration)

Dear [Customer Name],

On 2026-09-20 at 10:30 UTC, ACAOS experienced a service outage lasting 10 minutes
that prevented you from accessing the platform and sending outreach emails.

Incident Details:
- Cause: Memory leak in application code (v1.3.0)
- Duration: 10 minutes (10:30–10:40 UTC)
- Impact: Web platform unreachable; email sending blocked
- Root Cause: [brief summary from RCA]
- Resolution: Rolled back to previous stable version (v1.2.0)

What We've Learned:
We've identified and fixed the memory leak. To prevent this in the future, we're:
1. Adding memory tests to our CI pipeline
2. Implementing memory-usage monitoring alerts
3. Reviewing our code review process for memory-related issues

Data Integrity:
- No customer data was lost
- Emails that were queued before the outage resumed sending normally after recovery
- No data corruption occurred

If you have any questions or experienced data loss, please contact support@acaos.com.

Thank you for your patience and for using ACAOS.

Best regards,
ACAOS Engineering Team
```

---

## Post-Incident Activities

### Incident Report

Create an incident report within 24 hours:

**Template:**

```markdown
# Incident Report: P1 - API Memory Leak (2026-09-20)

## Executive Summary

On 2026-09-20 at 10:30 UTC, ACAOS experienced a 10-minute outage affecting all customers.
Root cause was a memory leak in the application code (v1.3.0). Resolution: rollback to v1.2.0.

## Timeline

| Time | Event |
|------|-------|
| 10:28 | v1.3.0 deployed to production (API + Worker) |
| 10:30 | AlertManager fires: EndpointDown (API unresponsive) |
| 10:30 | On-call engineer pages in; declares P1 incident |
| 10:31 | Root cause identified: memory leak in new code |
| 10:32 | Rollback initiated: deploy v1.2.0 |
| 10:40 | API fully recovered; smoke tests pass; incident resolved |

## Root Cause Analysis

**Immediate Cause:** Memory leak in `/packages/backend-core/src/lib/cache.ts`
  - Code created unbounded Map without size limit
  - Prospect objects added on every request but never evicted
  - After ~2 hours: 1 GB memory usage → OOM → container killed

**Contributing Factors:**
  - Code review didn't catch the unbounded data structure
  - No memory profiler in CI/pre-deploy checks
  - Test suite didn't load-test with realistic data sizes

**Why it wasn't caught in staging:**
  - Staging load is 1/100th of production
  - Memory leak takes 2 hours to manifest
  - Pre-deploy smoke tests only run 5 minutes

## Impact Analysis

**Customers Affected:** 100% of customers
**Duration:** 10 minutes
**Data Lost:** None (all in-flight emails resumed after recovery)
**Revenue Impact:** Estimated 0.1% of monthly ARR (10 min ÷ 43,200 min/month)
**Error Budget Burned:** 0.5% (SLO = 99.9%; incident burned 4.8 "nines")

## Resolution & Verification

**Immediate Resolution:**
- Reverted to v1.2.0 at 10:32 UTC
- Smoke tests confirmed all endpoints returning 200 at 10:40 UTC
- Customers reported normal service at 10:45 UTC

**Verification Steps Taken:**
- Health gate passed: /api/live, /api/ready, /api/health all green
- Release metadata: API and Worker both reported v1.2.0
- Error rate: 0% 5xx for 30 min after recovery
- Queue drains: send-campaign queue went from 500 → 0 in 5 min

## Lessons Learned

### What We Did Well
1. **Fast detection:** AlertManager caught the failure in <1 minute
2. **Clear runbook:** Deployment rollback procedure was documented and executed in 1 minute
3. **Good logs:** Memory metrics visible in Grafana; made RCA obvious

### What We Can Improve
1. **Pre-deploy testing:** Should have run memory profiler on v1.3.0
2. **Code review:** Unbounded Map should have been caught in review (add linting rule)
3. **Staging load test:** Should replicate production data sizes (10k+ prospects)

## Action Items

| Action | Owner | Due | Priority |
|--------|-------|-----|----------|
| Add memory profiler to CI/pre-deploy | @alice-eng | 2026-09-27 | P1 |
| Add ESLint rule: flag unbounded collections | @alice-eng | 2026-09-27 | P1 |
| Implement production memory monitoring (alert at 800MB) | @bob-ops | 2026-09-30 | P2 |
| Update code review checklist: memory safety | @lead-eng | 2026-09-25 | P2 |
| Load test staging with 100k prospects | @qa-team | 2026-10-05 | P3 |

## Sign-off

- **Incident Commander:** John Smith
- **Approver:** Alice Johnson (VP Engineering)
- **Reviewed by:** Bob Ops (SRE)
```

### Follow-Up Meetings

**Blameless post-mortem (24 hours after incident):**

```
Attendees: Incident Commander, investigating engineers, SRE, product manager

Agenda:
1. Timeline walkthrough (20 min)
   - What happened, minute by minute?
   - Who did what, and when?

2. Root cause analysis (30 min)
   - Why did the code have a memory leak?
   - Why wasn't it caught in review?
   - Why wasn't it caught in staging?

3. Action items (20 min)
   - What are we changing?
   - Who owns each action?
   - What's the deadline?

4. Communication (10 min)
   - Customer-facing message (already sent?)
   - Internal communication to team
   - Any follow-up required?

Culture note: "Blameless" means we focus on systems and processes, not individuals.
E.g., "Code review process didn't catch it" not "Engineer wrote bad code."
```

### Monitoring & Alerting Improvements

After incident, review monitoring:

```
Before v1.3.0, did we have alerts for:

Memory usage:
  ✗ Missing: Alert if process memory > 800 MB
  → Add: Prometheus alert

  node_process_resident_memory_bytes > 800_000_000 for 2m

Queue depth / job backlog:
  ✓ Already have SendCampaignBacklog alert (>100 waiting)

Latency degradation:
  ✓ Already have ApiHighLatencyP99 (>1.5s)

Error rate spike:
  ✓ Already have ApiHigh5xxRate (>5%)

Availability burn:
  ✓ Already have ApiAvailabilityBudgetBurn (multi-window)
```

---

## Escalation Contacts

**On-Call Rotation:**

```
🔔 Primary on-call:   @alice-eng  (M-F 9-5, UTC)
🔔 Secondary on-call: @bob-ops   (weekends + nights)
🔔 Incident Commander (on standby for P1): @lead-eng

Paging:
- P1: Page primary + secondary + IC immediately
- P2: Page primary; escalate to secondary if unresponded in 5 min
- P3: Email to team; no page
```

**External Escalation:**

```
Stripe Payment Processing Issues:
→ Contact: Stripe support (dashboard → Help)
→ Priority: P1 (payments down = immediate revenue impact)

OpenAI API Issues:
→ Status: https://status.openai.com/
→ Contact: OpenAI support (api.openai.com/help)
→ Workaround: Disable AI features; circuit breaker auto-engages

Apollo.io Discovery Issues:
→ Status: https://apolloio.statuspage.io/
→ Contact: Apollo support (dashboard → Help)
→ Workaround: Disable discovery; alert customers
```

---

## Related Documentation

- [`docs/OPERATIONS.md`](../OPERATIONS.md) — Day-to-day operations
- [`docs/RUNBOOKS.md`](../RUNBOOKS.md) — Alert-specific runbooks
- [`docs/SLO.md`](../SLO.md) — Service level objectives
- [`docs/DEPLOYMENT_RUNBOOK.md`](./DEPLOYMENT_RUNBOOK.md) — Rollback procedure
- [`docs/TROUBLESHOOTING_GUIDE.md`](./TROUBLESHOOTING_GUIDE.md) — Common issues

