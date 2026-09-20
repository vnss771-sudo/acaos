# ACAOS Maintenance Schedule

**Objective:** Plan and execute planned maintenance with minimal customer impact.

**Audience:** SRE, platform engineers, infrastructure team

**Last Updated:** 2026-09-20

---

## Table of Contents

1. [Maintenance Windows](#maintenance-windows)
2. [Routine Maintenance Tasks](#routine-maintenance-tasks)
3. [Scheduled Maintenance Calendar](#scheduled-maintenance-calendar)
4. [Maintenance Procedures](#maintenance-procedures)
5. [Customer Communication](#customer-communication)

---

## Maintenance Windows

### Designated Maintenance Windows

ACAOS observes the following maintenance windows:

**Primary Window (Preferred):**
- **Tuesday - Thursday, 2:00 - 4:00 AM UTC**
- Low traffic period
- Outside business hours (most US customers)
- Outside EMEA business hours

**Secondary Window (if needed):**
- **Sunday, 3:00 - 5:00 AM UTC**
- Alternative for non-critical maintenance

**No-Maintenance Windows:**
- Monday: Many customers prep for week
- Friday: End-of-week campaigns + weekday activity
- Holidays: Black Friday, Cyber Monday, Dec 15-Jan 2
- Year-end: Dec 20 - Jan 5 (high activity + compliance audits)

### SLA During Maintenance

During approved maintenance windows:

```
SLA is suspended.
Customers are notified 3 days in advance (status page).
Service may be unavailable for up to 2 hours.
Critical fixes may extend window beyond 2 hours.
```

---

## Routine Maintenance Tasks

### Daily Tasks (Automated)

These run automatically; no manual intervention:

| Task | Frequency | Duration | Impact |
|------|-----------|----------|--------|
| Database backup | Daily, 2 AM UTC | <5 min | None (non-blocking) |
| Log rotation | Daily, 3 AM UTC | <2 min | None |
| Metrics aggregation | Hourly | <1 min | None |
| Cache cleanup | Every 5 min | <1 sec | None |
| Failed job retry | Continuous | async | None |

### Weekly Tasks (Automated)

| Task | Day/Time | Duration | Impact |
|------|----------|----------|--------|
| Database ANALYZE | Sunday, 2 AM UTC | 30 min | Query performance may improve slightly |
| Data retention purge | Sunday, 3 AM UTC | varies | None (deletes old audit logs) |
| Prometheus DB cleanup | Monday, 2 AM UTC | 10 min | Metrics may gap briefly |
| Report generation | Friday, 5 PM UTC | 2 hours | Admin dashboard may be slow |

### Monthly Tasks (Manual - Scheduled)

| Task | Schedule | Duration | Downtime? |
|------|----------|----------|-----------|
| Dependency security audit | 1st Tuesday | 2 hours | No |
| Database vacuum | 2nd Sunday | 30 min | No |
| SSL certificate rotation | 3rd Thursday | 10 min | No |
| Capacity review | 4th Tuesday | 1 hour | No |
| Security patches | 2nd Tuesday | 30 min - 2 hours | Maybe (depends on patch) |

### Quarterly Tasks (Manual)

| Task | Schedule | Duration | Downtime? |
|------|----------|----------|-----------|
| Major dependency upgrade | Jan 15, Apr 15, Jul 15, Oct 15 | 2-4 hours | Yes (planned window) |
| Database maintenance (REINDEX, etc) | Every 3 months | 1-2 hours | Yes (planned window) |
| Infrastructure audit | Every 3 months | 3-4 hours | No |
| Disaster recovery drill | Every 3 months | 4 hours | No (staging) |

---

## Scheduled Maintenance Calendar

### 2026 Q4 Schedule

```
SEPTEMBER 2026
───────────────────────────────────────────────────────────────
23 (Tue) 2:00-4:00 AM UTC: Dependency security patches (Node.js, npm)
                           Estimated downtime: 0 min (rolling restart)
                           Status: Scheduled

30 (Tue) 2:00-4:00 AM UTC: Monthly capacity review + database ANALYZE
                           Estimated downtime: 0 min
                           Status: Scheduled

OCTOBER 2026
───────────────────────────────────────────────────────────────
 6 (Mon) 2:00-4:00 AM UTC: Q4 security patches (OpenSSL, etc)
                           Estimated downtime: 30 min
                           Status: Scheduled

13 (Mon) 2:00-4:00 AM UTC: Major database maintenance
                           Database: REINDEX, VACUUM FULL
                           Estimated downtime: 60 min
                           Status: Scheduled

20 (Mon) 2:00-4:00 AM UTC: Prometheus upgrade (v2.50 → v2.51)
                           Estimated downtime: 0 min
                           Status: Scheduled

27 (Mon) 2:00-4:00 AM UTC: Container image rebuild (dependency CVE patches)
                           Estimated downtime: 15 min (rolling restart)
                           Status: Scheduled

NOVEMBER 2026
───────────────────────────────────────────────────────────────
 3 (Mon)  2:00-4:00 AM UTC: Q4 infrastructure audit (no downtime expected)
                            Status: Scheduled

10 (Mon)  2:00-4:00 AM UTC: Disaster recovery drill (staging only)
                            Status: Scheduled

17 (Mon)  2:00-4:00 AM UTC: Grafana upgrade
                            Estimated downtime: 5 min
                            Status: Scheduled

24 (Mon)  2:00-4:00 AM UTC: SKIPPED (Thanksgiving in US; holiday period)
                            Status: Cancelled

DECEMBER 2026
───────────────────────────────────────────────────────────────
 1 (Mon)  2:00-4:00 AM UTC: Database SSL cert renewal
                            Estimated downtime: 0 min
                            Status: Scheduled

20-Jan 5: NO MAINTENANCE WINDOW
          Holiday period; all maintenance frozen for compliance
```

---

## Maintenance Procedures

### Standard Maintenance Procedure

**Timeline: Before, during, and after**

#### 1. Pre-Maintenance (3 Days Before)

```bash
# 1. Announce on status page
status.acaos.example.com → click "Scheduled Maintenance"
  Title: "Planned Maintenance: [description]"
  Time: "Tuesday, Sep 23, 2:00-4:00 AM UTC"
  Impact: "Services may be unavailable"
  Status: "Scheduled"

# 2. Notify major customers
Email to key accounts (>$5k/month):
  Subject: "Planned Maintenance - Sep 23, 2026 (2-4 AM UTC)"
  
  Hi [Name],
  
  We'll be performing scheduled maintenance on ACAOS on Tuesday,
  September 23 from 2:00-4:00 AM UTC.
  
  During this time:
  - Web platform may be unavailable
  - Email sending will be paused
  - Existing replies will sync after maintenance
  
  We apologize for the disruption. This maintenance improves
  our infrastructure security and reliability.
  
  Questions? Contact support@acaos.example.com
  
  Best,
  ACAOS Operations

# 3. Brief the on-call team
Slack → #ops-team: @channel Scheduled maintenance Sep 23, 2-4 AM UTC
  ✓ I'll be running it
  ✓ Estimated downtime: 0 min (rolling restart)
  ✓ Backup plan: [contingency if something goes wrong]
```

#### 2. Pre-Maintenance (1 Day Before)

```bash
# 1. Verify maintenance plan
  - Run through procedure one more time
  - Confirm all necessary access (SSH keys, credentials)
  - Test rollback procedure in staging

# 2. Alert Slack channel
Slack → #ops-team: "Maintenance tomorrow, 2-4 AM UTC. Final checks:"
  [ ] Database backups verified
  [ ] Runbook reviewed
  [ ] Rollback tested
  [ ] Status page updated
  [ ] Customer notifications sent
```

#### 3. Maintenance Window (Start)

```bash
# 30 minutes before:
# 1. Update status page: "Maintenance in progress"
status.acaos.example.com → "Scheduled Maintenance" → "In Progress"

# 2. Notify Slack
Slack → #ops-team: "🔧 Maintenance starting in 30 min. Everyone standby."

# 5 minutes before:
# 1. Start maintenance
# 2. Post to Slack: "🔧 MAINTENANCE STARTED at 2:00 AM UTC"
```

#### 4. During Maintenance

**Procedure (example: security patch):**

```bash
# 1. Stop accepting traffic
Railway dashboard → acaos-api → Scale to 0 replicas
(Existing requests drain within 30s)

# 2. Apply patches
git pull origin main
npm install
npm run build

# 3. Verify patches
npm test
npm run typecheck

# 4. Restart services
Railway dashboard → acaos-api → Scale to 2 replicas
(Wait 30s for healthchecks to pass)

# 5. Smoke test
npm run smoke:deploy -- --api-url https://api.acaos.example.com

# 6. If smoke passes: Update status page "All clear"
If smoke fails: ROLLBACK (see below)
```

#### 5. Maintenance Window (End)

```bash
# 1. Verify all services are healthy
curl https://api.acaos.example.com/api/ready
curl https://api.acaos.example.com/api/live
curl https://acaos.example.com/api/health

# 2. Check for any errors in logs
Railway → acaos-api → Logs (last 100 lines should show "Listening on port 4000")

# 3. Update status page: "Maintenance completed"
status.acaos.example.com → "Scheduled Maintenance" → "Resolved"

# 4. Post to Slack: "✅ Maintenance completed successfully at 2:45 AM UTC"
```

#### 6. Post-Maintenance (Hours 2-24 After)

```bash
# 1. Monitor error rate and latency
Grafana → Service Overview
  - HTTP 5xx rate should be <0.5%
  - Latency p99 should be normal (~400ms)
  - No sustained alerts

# 2. Check customer reports
Support email, Slack → any complaints?
  - If yes, investigate + document root cause
  - If no, maintenance was successful

# 3. Update changelog
git commit -m "docs: record successful maintenance on Sep 23

Database ANALYZE completed; query performance baseline updated.
All patches applied successfully.

Maintenance window: 2:00-2:45 AM UTC (45 min, customer-visible)
Services: API, Worker, Web
Downtime: 0 min (rolling restart; no user-facing impact)
Issues: None reported
"
```

### Rollback Procedure (If Maintenance Fails)

**Trigger: Smoke test fails OR 5xx rate spikes during maintenance**

```bash
# 1. IMMEDIATELY stop the maintenance
# 2. IMMEDIATELY rollback to previous state
git revert HEAD  # undo the problematic change

npm run build
npm run test  # verify rollback doesn't break anything

# 3. IMMEDIATELY restart services
Railway dashboard → acaos-api → Restart

# 4. IMMEDIATELY re-run smoke test
npm run smoke:deploy -- --api-url https://api.acaos.example.com

# 5. IMMEDIATELY update status page
status.acaos.example.com → "Maintenance" → "Partial Outage"
"Maintenance encountered an issue. Rolling back to previous version."

# 6. Post to Slack (incident channel)
Slack → #ops-team, #incidents
"⚠️  Maintenance rollback initiated at [time]
Reason: [brief explanation]
Status: [current status]
ETA to recovery: [time]"

# 7. Once recovered:
status.acaos.example.com → "All Systems Operational"
Slack → "✅ Maintenance rolled back. Service restored."

# 8. Post-mortem (24 hours later)
- Why did maintenance fail?
- How do we prevent this next time?
- Document lessons learned
```

---

## Customer Communication

### Status Page Updates

**Pre-Maintenance (3 days before):**

```
Status: "Scheduled Maintenance"
Severity: Yellow (planned)
Title: "Scheduled Maintenance - Database Upgrade"
Description: "We'll be performing scheduled database maintenance
             on Tuesday, September 23, 2026 from 2:00-4:00 AM UTC.
             Services may be unavailable during this window."
Impact: "All services (web, API, email) may be unavailable"
Estimated Duration: "2 hours"
```

**During Maintenance:**

```
Status: "Maintenance In Progress"
Severity: Red (active)
Description: "Maintenance is currently in progress.
              Services are unavailable. ETA: 3:30 AM UTC.
              Thank you for your patience."
Updated: "2:15 AM UTC - Database migration 60% complete"
```

**After Maintenance:**

```
Status: "All Systems Operational"
Severity: Green
Description: "Maintenance completed successfully at 2:45 AM UTC.
              All services are operational.
              Thank you for your patience."
```

### Customer Email Template

**Subject:** "Planned Maintenance - [Service] - [Date/Time]"

```
Hi [Name],

We're performing scheduled maintenance on ACAOS on [DATE] at [TIME] UTC.

Impact:
- The ACAOS web platform may be unavailable
- Email sending will pause (resumes automatically after maintenance)
- Incoming replies will be synced after maintenance completes
- No data will be lost

Why this maintenance?
- [Security patches / Database optimization / Infrastructure upgrade]
- This improves our reliability and security

Estimated duration: 1-2 hours

If you have any questions, please contact support@acaos.example.com.

Thank you for your patience,
ACAOS Operations Team

---
Status: https://status.acaos.example.com
Support: support@acaos.example.com
```

---

## Maintenance Checklist

### Before Each Maintenance

```
[ ] Maintenance window approved by leadership
[ ] Runbook reviewed and tested in staging
[ ] Rollback procedure verified (can execute in <5 min)
[ ] Status page prepared (draft message)
[ ] Customer email drafted and ready
[ ] Slack channel ready (#ops-team + #incidents)
[ ] All access credentials verified (SSH, kubectl, Railway, etc)
[ ] On-call engineer briefed
[ ] Backup of current state taken (database snapshot, git tag)
[ ] Smoke test command verified (runs in <2 min)
[ ] Monitoring dashboards open (ready to watch during)
```

### During Each Maintenance

```
[ ] Status page updated: "In Progress"
[ ] Slack announcement posted
[ ] Maintenance started at scheduled time
[ ] Changes applied per runbook
[ ] Smoke test executed
[ ] No new 5xx errors in logs
[ ] Health endpoints respond 200
[ ] Database connectivity verified
[ ] Cache warmed up (if applicable)
[ ] Status page updated: "Completed"
[ ] Slack announcement posted: "✅ Complete"
```

### After Each Maintenance

```
[ ] Changelog entry created
[ ] All alerts cleared
[ ] Error budget checked (did maintenance burn budget?)
[ ] Lessons learned documented
[ ] Any follow-up actions logged as tickets
[ ] Customer communication sent (if significant)
[ ] Post-mortem scheduled (if issues encountered)
```

---

## Emergency Maintenance (Out-of-Window)

### Criteria

Emergency maintenance (outside scheduled windows) may be required for:

1. **Critical security vulnerability** (CVE, 0-day)
2. **Data corruption** or data loss risk
3. **Complete service outage** that can't be fixed by rollback

### Approval Process

```
Engineer → On-call Lead → VP Engineering → Notify Customers

1. Engineer: "Emergency maintenance needed due to [reason]"
2. On-call Lead: Verifies urgency; approves or escalates
3. If approved: Proceed with maintenance immediately
4. Customer notification: Send incident notification
5. Post-maintenance: Post-mortem + root cause analysis
```

### Customer Impact Notification

```
🚨 EMERGENCY MAINTENANCE

An emergency security issue has been identified and requires
immediate maintenance. We're implementing fixes now to protect
your data.

Expected duration: [time]
Status: [real-time updates every 5 minutes]

Thank you for your patience.
```

---

## Related Documentation

- [`docs/OPERATIONS.md`](../OPERATIONS.md) — Day-to-day operations
- [`docs/production/DEPLOYMENT_RUNBOOK.md`](./DEPLOYMENT_RUNBOOK.md) — Deployment procedures
- [`docs/production/INCIDENT_RESPONSE.md`](./INCIDENT_RESPONSE.md) — Emergency response

