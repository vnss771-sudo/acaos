# ACAOS Railway Deployment Runbook

**Objective:** Deploy ACAOS to Railway production with zero-downtime migrations, health gating, and automated rollback capability.

**Audience:** Platform engineers, DevOps, release managers

**Last Updated:** 2026-09-20

---

## Table of Contents

1. [Pre-Deployment Checklist](#pre-deployment-checklist)
2. [Infrastructure Setup](#infrastructure-setup)
3. [Deployment Steps](#deployment-steps)
4. [Database Migration](#database-migration)
5. [Health Gate Verification](#health-gate-verification)
6. [Rollback Procedure](#rollback-procedure)
7. [Release Metadata Verification](#release-metadata-verification)

---

## Pre-Deployment Checklist

### Code Quality Gates

Before deploying, verify all quality gates pass:

```bash
# From the repository root
npm run verify
# This runs: boundaries, mutations, pinning, monitoring, lint, typecheck, tests, build

# Additional verification
npm run check:offline-stub      # Ensure Prisma stub is valid
npm run check:critical-test-coverage
```

Expected outcome: All checks pass with exit code `0`. Any failure blocks deployment.

### Release Metadata

```bash
npm run release:preflight -- v1.3.0
npm run release:metadata
npm run pack
```

This produces:
- `dist-pack/release-manifest.json` — the immutable deployment contract
- `dist-pack/acaos-source.zip` — archived source (for audit trail)

### Environmental Readiness

- [ ] Staging environment is green (see [Health Gate Verification](#health-gate-verification))
- [ ] No pending security patches
- [ ] Stripe configuration tested (webhooks firing correctly)
- [ ] External provider keys (OpenAI, Apollo, Hunter) configured
- [ ] Database backup completed
- [ ] Redis cluster healthy
- [ ] On-call engineer acknowledges readiness

---

## Infrastructure Setup

### Service Topology

ACAOS on Railway requires five services (can scale independently):

| Service | Replicas | CPU | Memory | Storage |
|---------|----------|-----|--------|---------|
| PostgreSQL | 1 | 2 | 4 GB | 50 GB+ |
| Redis | 1 | 1 | 2 GB | 10 GB |
| API | 2-3 | 1 | 1 GB | ephemeral |
| Worker | 1-2 | 1 | 1 GB | ephemeral |
| Web | 2 | 0.5 | 512 MB | ephemeral |

### Initial Provisioning (New Environment)

1. **Create Project** in Railway dashboard
   - Name: `acaos-production` (or appropriate environment name)
   - Pricing: Pay-as-you-go

2. **Provision PostgreSQL**
   - Railway → Add → PostgreSQL
   - Version: 14+
   - Username: `postgres`
   - Name: `acaos-db`
   - Wait for "Running" status
   - Note the connection string from **Variables**

3. **Provision Redis**
   - Railway → Add → Redis
   - Version: 6+
   - Username: `default`
   - Name: `acaos-redis`
   - Wait for "Running" status
   - Note the connection string from **Variables**

4. **Create API Service**
   - Railway → Add → GitHub Repo
   - Connect ACAOS repository
   - Name: `acaos-api`
   - Build command: (leave default or `npm ci && npm run build -w @acaos/api`)
   - Start command: `node scripts/start-with-migrations.mjs`
   - Port: `4000`
   - Replicas: `2`

5. **Create Worker Service**
   - Railway → Add → GitHub Repo (same repo)
   - Name: `acaos-worker`
   - Build command: (leave default or `npm ci && npm run build -w @acaos/worker`)
   - Start command: `npm --workspace @acaos/worker run start`
   - Port: (not exposed publicly, health port 9090 internal)
   - Replicas: `1`

6. **Create Web Service**
   - Railway → Add → GitHub Repo (same repo)
   - Name: `acaos-web`
   - Build command: `npm ci && npm run build -w @acaos/web`
   - Start command: `npm --workspace @acaos/web run start`
   - Port: `8080`
   - Replicas: `2`

### Environment Variables Configuration

**PostgreSQL connection:**

```bash
# On the API and Worker services
# PostgreSQL service auto-injects DATABASE_URL; you only need DIRECT_URL if using PgBouncer:
DIRECT_URL=postgresql://postgres:<password>@db.internal:5432/acaos?schema=public
```

**Redis connection:**

```bash
# On API and Worker services
# Redis service auto-injects REDIS_URL
```

**Secrets** (use Railway Secrets, not Variables):

```bash
JWT_SECRET=<strong_random_string_min_16_chars>
EMAIL_ENCRYPTION_KEY=<64_hex_chars>
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
OPENAI_API_KEY=sk-...
APOLLO_API_KEY=...
SENTRY_DSN=https://...@sentry.io/...
METRICS_TOKEN=<random_bearer_token>
```

**Configuration Variables:**

```bash
NODE_ENV=production
PORT=4000
APP_URL=https://acaos.example.com
API_URL=https://api.acaos.example.com
WEB_URL=https://acaos.example.com

# Monitoring
SENTRY_DSN=<configured_above>
METRICS_TOKEN=<configured_above>

# Optional: Cost tracking
OPENAI_COST_PER_1K_INPUT_TOKENS=0.003
OPENAI_COST_PER_1K_OUTPUT_TOKENS=0.006

# Rate limiting (production-safe defaults)
GENERAL_RATE_LIMIT_REQUESTS=100
GENERAL_RATE_LIMIT_WINDOW_MS=60000

# Feature flags
COMPLIANCE_GATE_ENABLED=false
TENANT_GUARD_MODE=enforce
```

---

## Deployment Steps

### Step 1: Deploy to Staging (or Canary)

```bash
# From GitHub Actions or CLI
gh workflow run release.yml --ref main --inputs version=v1.3.0
```

Expected timeline: 5-10 minutes for build, 2-3 minutes for rollout.

**Verify staging is healthy:**

```bash
# Run smoke tests
npm run smoke:deploy -- \
  --manifest dist-pack/release-manifest.json \
  --api-url https://api-staging.acaos.example.com \
  --worker-url https://worker-staging.acaos.example.com

# Or use GitHub Actions: Actions → Post-deploy smoke → staging environment
```

### Step 2: Wait for Canary Bake (if enabled)

If `CANARY_URL` is set in GitHub environment variables:

```
Canary bake window: 2 minutes (configurable via CANARY_BAKE_SECONDS)

Watch for:
✓ 200 responses on /api/ready and /api/live
✓ No 5xx errors in metrics
✓ Release ID matches manifest
```

If bake passes → automatic promotion webhook fires (configurable).
If bake fails → automatic rollback webhook fires (configurable).

### Step 3: Promote to Production

1. **Require approval** before production deploy (configured in GitHub environment settings)
2. **Verify release manifest** matches the one from staging:

   ```bash
   # Check both are identical
   diff <(git show staging:dist-pack/release-manifest.json) dist-pack/release-manifest.json
   ```

3. **Trigger production deployment** via GitHub Actions:
   - Workflow: `release.yml`
   - Environment: `production`
   - Reviewer approval required

4. **Do NOT modify** `DATABASE_URL`, `REDIS_URL`, or secrets between staging and production.

### Step 4: Production Health Gate

Once Railway reports all services as "Running":

```bash
npm run smoke:deploy -- \
  --manifest dist-pack/release-manifest.json \
  --api-url https://api.acaos.example.com \
  --worker-url https://worker.acaos.example.com
```

**Health gate checks:**

```
Endpoint                      Expected Status   SLA
─────────────────────────────────────────────────────────────
GET /api/live                 200               <100ms
GET /api/ready                200               <3s
GET /api/ready/strict         200               <3s
GET /api/health               200               <1s
GET /api/metrics              200               <500ms (with METRICS_TOKEN)
GET /ready (web)              200               <1s
```

**Release metadata verification:**

```bash
# API should report matching releaseId
curl -H "Authorization: Bearer $METRICS_TOKEN" https://api.acaos.example.com/metrics | grep acaos_build_info

# Expected output:
# acaos_build_info{version="1.3.0",commit="abc123...",releaseId="1.3.0+abc123..."} 1
```

---

## Database Migration

### Automatic Migration at API Startup

The API container runs migrations automatically via `scripts/start-with-migrations.mjs`:

```javascript
1. Load DATABASE_URL and connect
2. Run `prisma migrate deploy` (applies pending migrations only)
3. If migrations fail → exit non-zero (container does NOT start)
4. If migrations succeed → start Express server
```

**This is the only safe migration path in production.** Never run `prisma migrate` manually or use `prisma db push`.

### Verifying Migrations Applied

```bash
# SSH into the API container (via Railway)
$ npx prisma migrate status

# Expected output:
# Database is up to date.
# 4 migrations executed

# If there are pending migrations:
# Following migrations have not yet been applied:
#   20260920120000_add_column_x
#
# The API would refuse to start. Check the logs:
# docker logs <api-container>
```

### Rollback Safety

**Migrations are forward-only.** You cannot automatically roll back a migration by redeploying an old image.

- **Backward-compatible migrations** (e.g., add column with default): deploy old image without issue.
- **Breaking migrations** (e.g., drop column): must have a corrective migration prepared in advance.

Example safe workflow:

```
Release 1.2.0: Migrations = [add column with default value]
  ↓ (works with 1.1.x code)

Release 1.3.0: Migrations = [add NOT NULL constraint to column]
  ↓ (requires 1.3.0 code; 1.2.x code still works)

If 1.3.0 fails, redeploy 1.2.0:
  ↓ 1.2.0 code + (1.2.0 + 1.3.0) migrations = OK
```

---

## Health Gate Verification

### Pre-Production Checklist

Run this health verification **before** marking the deployment as complete:

```bash
#!/bin/bash
set -e

API_URL="https://api.acaos.example.com"
METRICS_TOKEN="<value>"

echo "=== ACAOS Deployment Health Gate ==="

# 1. Liveness
echo "✓ Testing /api/live..."
curl -f "$API_URL/api/live" | jq .

# 2. Readiness
echo "✓ Testing /api/ready..."
curl -f "$API_URL/api/ready" | jq .

# 3. Strict readiness (Redis required)
echo "✓ Testing /api/ready/strict..."
curl -f "$API_URL/api/ready/strict" | jq .

# 4. Health
echo "✓ Testing /api/health..."
curl -f "$API_URL/api/health" | jq .

# 5. Metrics (with auth)
echo "✓ Testing /metrics..."
curl -f -H "Authorization: Bearer $METRICS_TOKEN" "$API_URL/metrics" | grep acaos_build_info

# 6. Web endpoint
echo "✓ Testing web /ready..."
curl -f "https://acaos.example.com/api/health" | jq .

echo "✅ All health gates passed!"
```

### Grafana Dashboard Walkthrough

1. Log into Grafana (via Railway or external monitoring)
2. Open **"Service Overview"** dashboard
3. Verify metrics for the new release:
   - **HTTP requests by status**: <5% 5xx
   - **HTTP latency p99**: <1.5s
   - **In-flight requests**: <100
   - **DB connections**: <90% utilization
   - **Redis memory**: <80% utilization
   - **Worker queue depth**: 0 (send-campaign)

### Expected Deployment Duration

| Phase | Duration | Notes |
|-------|----------|-------|
| Build (all 5 services) | 5-10 min | Parallel in Railway |
| Pull image + start | 2-3 min | Per service; migrations run during API start |
| Health gate | 2-3 min | Smoke tests; no user traffic yet |
| **Total** | **10-15 min** | Assuming no failures |

---

## Rollback Procedure

### Immediate Rollback (< 5 minutes from deploy)

If any of these occur, **rollback immediately:**

- Smoke health gate fails (any endpoint returns non-200)
- Release ID mismatch (API/worker report different versions)
- Burn-rate alert fires (5xx rate spike, availability drop)
- Database migration fails (API won't start)

**Rollback steps:**

```bash
# 1. Identify the last known good version
git log --oneline -10
# e.g., v1.2.0 was stable (before v1.3.0)

# 2. Redeploy the previous image tag
# Option A: Via GitHub Actions
gh workflow run release.yml --ref main --inputs version=v1.2.0 promote_to_production=true

# Option B: Via Railway dashboard
# Services → acaos-api → Deployments → Select v1.2.0 → Redeploy

# 3. Re-run health gate
npm run smoke:deploy -- \
  --manifest dist-pack/release-manifest-v1.2.0.json \
  --api-url https://api.acaos.example.com
```

### Post-Rollback Analysis

```bash
# 1. Collect logs from the failed deployment
docker logs <api-container-id> > /tmp/api-logs.txt
docker logs <worker-container-id> > /tmp/worker-logs.txt

# 2. Check Sentry for stack traces
# Sentry → Issues → Filter by release=v1.3.0

# 3. Document the incident
cat > /tmp/incident-v1.3.0.md <<EOF
## Incident Summary: v1.3.0 Rollback

**Timeline:**
- 2026-09-20 14:30 UTC: Deployed v1.3.0
- 2026-09-20 14:32 UTC: Health gate failed (5xx on /api/ready)
- 2026-09-20 14:33 UTC: Rolled back to v1.2.0

**Root Cause:**
[From logs/Sentry] ...

**Fixed In:**
PR #xyz: [description]
EOF
```

### Preventing Future Rollbacks

1. **Expand staging bake window**: `CANARY_BAKE_SECONDS=600` (10 min instead of 2)
2. **Add smoke test for the affected flow**: If a migration failed, add a test that validates the schema
3. **Enable stricter health gates**: Use `/api/ready/strict` for load-balancer readiness (forces Redis check in all envs)

---

## Release Metadata Verification

### Confirming Deployment Success

After production health gate passes, verify every component reports the same version:

```bash
# Check API release metadata
curl https://api.acaos.example.com/api/ready | jq .releaseId
# Expected: "1.3.0+abc123def456789..."

# Check Worker release metadata
curl -H "Authorization: Bearer $METRICS_TOKEN" \
  https://worker.acaos.example.com:9090/metrics | grep acaos_build_info
# Expected: acaos_build_info{version="1.3.0",...,releaseId="1.3.0+abc123..."} 1

# Check Web release metadata
curl https://acaos.example.com/api/health | jq .releaseId
# Expected: "1.3.0+abc123def456789..."

# Verify all three match
# If any differ → services rolled back at different times, potential inconsistency
```

### Monitoring After Deploy

Run this monitoring window for at least **2 evaluation windows** (default 5 min each = 10 min):

```
Watch for:
✓ No burn-rate alerts (ApiSuccessBudgetBurn, ApiAvailabilityBudgetBurn)
✓ No new high-cardinality errors in Sentry
✓ Normal latency p99 (<1.5s)
✓ Queue draining normally (no stuck send-campaign jobs)
✓ Worker not accumulating failures
```

If any alert fires → **[Rollback](#immediate-rollback)** immediately and investigate.

---

## Common Deployment Issues

### Issue: API Container Won't Start (Migration Failure)

**Symptom:** API service shows "Failed" or "Exited" after 30s.

**Diagnosis:**

```bash
# Check logs
docker logs <api-container>
# Look for: "Prisma migration failed" or "P3005"

# SSH into container and check schema
npx prisma migrate status
```

**Resolution:**

1. Check if the migration is valid: `git diff HEAD~1 packages/db/prisma/schema.prisma`
2. If the migration is broken, fix it and redeploy
3. If the database is in a bad state, restore from backup and redeploy
4. **Never** try to manually fix the database in production

### Issue: High Latency After Deploy

**Symptom:** p99 latency spikes to >2s after deployment.

**Diagnosis:**

```bash
# Check if it's a specific route
# Grafana → HTTP Latency p99 by Route panel
# Common culprits: /api/stats (expensive aggregation), /api/prospects/search

# Check DB connection pool saturation
curl https://api.acaos.example.com/api/health | jq .
# If "connections: { available: <5, used: >20 }" → pool exhausted
```

**Resolution:**

1. Scale up API replicas: Railway → acaos-api → Replicas = 3-4
2. Increase database connection limit: `DATABASE_URL` append `?connection_limit=10`
3. Lower STATS_CACHE_TTL_MS if /api/stats is the bottleneck: `STATS_CACHE_TTL_MS=10000`

### Issue: Queue Backlog Growing (send-campaign jobs stuck)

**Symptom:** SendCampaignBacklog alert fires; `/api/metrics` shows `bullmq_queue_jobs{queue="send-campaign",state="waiting"} > 100`

**Diagnosis:**

```bash
# Check if worker is running
curl -H "Authorization: Bearer $METRICS_TOKEN" \
  https://worker.acaos.example.com:9090/metrics | grep bullmq_queue_jobs

# Check worker logs for failures
docker logs <worker-container> | grep -i error
```

**Resolution:**

1. Verify worker service is up: Railway → acaos-worker → Status should be "Running"
2. Check SMTP credentials and provider keys (Apollo, Hunter) in environment
3. Increase worker concurrency: `WORKER_CONCURRENCY=20` (default ~5)
4. Scale worker replicas: Railway → acaos-worker → Replicas = 2

---

## Post-Deployment Handoff

### Update Team

Send to on-call team:

```
✅ ACAOS v1.3.0 deployed to production

Release ID: 1.3.0+abc123def456789
Deployed at: 2026-09-20 14:35 UTC
By: engineering-team
Duration: 12 minutes

Services: API, Worker, Web (PostgreSQL, Redis unchanged)
Smoke tests: ✅ PASSED
Health gates: ✅ PASSED
Error budget impact: 0% (no errors detected)

Monitoring window: 5 minutes remaining
- Burn-rate alerts: ✅ GREEN
- Latency p99: 450ms (baseline 400ms) — normal ramp-up
- Queue depth: 0

Next steps:
1. Continue monitoring for 5 more minutes
2. Run diagnostics on any customer-reported issues
3. Archive release logs in incident tracker
```

### Close Out in Change Log

```bash
# Update CHANGELOG.md
echo "## v1.3.0 (2026-09-20)

### Deployed to Production

- **Feature:** Mission scoring recommendations (PHASE_4_4)
- **Fix:** Query performance on /api/prospects with 10k+ prospects
- **Security:** Updated OpenAI dependency to latest patch

Deployment: 2026-09-20 14:35 UTC (12 min, zero downtime)
Rollback: (none, healthy deployment)
Error budget: 0%
" >> CHANGELOG.md

git add CHANGELOG.md
git commit -m "docs: record v1.3.0 production deployment

Deployed at 2026-09-20 14:35 UTC"
```

---

## Appendix: Automated Deployment via GitHub Actions

ACAOS ships with a `release.yml` workflow that automates the path above:

```yaml
# .github/workflows/release.yml
name: Release & Deploy

on:
  workflow_dispatch:
    inputs:
      version:
        description: Version (vX.Y.Z)
        required: true
      promote_to_production:
        description: Promote to production?
        default: false
        type: boolean

jobs:
  verify:
    # npm run verify
  build_and_push:
    # Docker build + push to container registry
  canary_bake:
    # Deploy to staging, wait CANARY_BAKE_SECONDS, smoke test
  post_deploy_smoke:
    # Reusable job for production smoke testing
  rollback:
    # If any step fails, optionally call ROLLBACK_WEBHOOK_URL
```

**Typical workflow dispatch:**

1. Open GitHub Actions
2. Click "Release & Deploy"
3. Enter version: `v1.3.0`
4. Check "Promote to production"
5. Click "Run workflow"
6. Monitor the workflow run in the UI
7. At the "Approve Production Deploy" step, reviewers approve/reject

---

## Related Documentation

- [`docs/DEPLOYMENT.md`](../DEPLOYMENT.md) — Platform-agnostic deployment concepts
- [`docs/PRODUCTION_ENV_VARS.md`](../PRODUCTION_ENV_VARS.md) — Full environment variable reference
- [`docs/OPERATIONS.md`](../OPERATIONS.md) — Day-2 operations, monitoring, incident response
- [`docs/KEY_ROTATION.md`](../KEY_ROTATION.md) — Secret rotation procedures
- [`infra/railway/README.md`](../../infra/railway/README.md) — Railway-specific notes

