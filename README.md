# ACAOS — Agentic Client Acquisition OS

An AI-powered outreach CRM for field-service businesses. Detects buying signals, scores prospects, generates personalised outreach, and learns from replies.

**Current status: controlled paid beta candidate. Not yet ready for broad public launch.**

---

## What it does

```
Choose playbook → Configure ICP → Seed radar → Discover prospects
→ Score signals → Get recommendations → Approve drafts → Send safely
→ Track replies → Learn and improve
```

- Multi-tenant workspaces with billing (Stripe), team invites, and role-based access
- AI research and outreach generation (OpenAI) per prospect
- IMAP reply tracking with AI classification
- Per-workspace SMTP/IMAP configuration (credentials encrypted at rest)
- Campaign send with daily limits, approval mode, and duplicate-send protection
- Suppression/unsubscribe list with public token endpoint
- Admin panel for founder visibility

---

## Local setup

### Requirements
- Node.js 20+
- PostgreSQL
- Redis

### Steps

```bash
cp .env.example .env        # fill in required values
npm install
npm run prisma:generate
npm run prisma:migrate
npm run dev:api             # http://localhost:4000
npm run dev:worker
npm run dev:web             # http://localhost:5173
```

### Docker (one command — full stack)

Builds the real production images (the same Dockerfiles Railway deploys) and runs
Postgres, Redis, the API, the worker, and the web frontend together:

```bash
docker compose up --build       # then open http://localhost:8080
```

(Requires internet access to pull the `postgres`/`redis`/`node` base images.)
The bundled secrets are local-only throwaways. For a hot-reloading dev loop
(source bind-mounted, no rebuild) use `docker compose -f docker-compose.local.yml up`.

### Useful commands

```bash
npm run build          # compile api + worker + web
npm run test           # fast API/unit suite (no services required)
npm run test:coverage  # same, with the 80/65/80 coverage gate
npm run test:db        # DB-backed suite (needs Postgres)
npm run test:redis     # queue/Redis suite (needs Redis)
npm test -w @acaos/web # frontend test suite
npm run test:e2e       # Playwright browser smoke tests (see e2e/README.md)
npm run loadtest       # smoke load test (see docs/OPERATIONS.md)
npm run typecheck      # TypeScript check (shared + api + web + worker)
npm run prisma:generate
npm run prisma:migrate
npm run release:metadata
```

---

## Environment variables

See `.env.example` for the full list with comments. Required in production:

| Variable | Purpose |
|---|---|
| `JWT_SECRET` | Token signing — must be strong random string |
| `EMAIL_ENCRYPTION_KEY` | AES-256 key for workspace SMTP/IMAP credentials |
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection string |
| `STRIPE_SECRET_KEY` | Billing |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signature validation |
| `APP_URL` | Public URL of the web app — used in email links |

---

## Release metadata and smoke

- `npm run release:metadata` → JSON release metadata
- `npm run release:metadata:env` → shell/env export format
- `npm run smoke:deploy -- --api-url ... --worker-url ...` → readiness + release drift gate
- `npm run release:smoke -- --manifest dist-pack/release-manifest.json` → local/CI rollout gate from the packaged manifest

API and worker responses include `X-Acaos-Release-Id`; health/readiness payloads expose the canonical `releaseId`.
GitHub staged rollout checks read `SMOKE_API_URL` / `SMOKE_WORKER_URL` from the selected environment and can enforce `expected_version`, `expected_commit`, or `expected_release_id` during promotion.

## CI/CD

- CI and release workflow guidance: `docs/CI_CD.md`
- Local release preflight: `npm run release:preflight -- v1.2.3`


## Known issues — remaining work before public launch

These are open items from the engineering release-gate review. Fixed items are not listed here.

### High priority (fix before onboarding paying users)

**1. Mission Builder — now an actionable control plane (deepening continues)**
A `Mission` model + `/api/missions` API + Missions view exist; creating a mission provisions its linked execution campaign. The mission detail is now a working **operator-loop hub** spanning the whole loop: a discovered → recommended → drafted → approved → sent funnel strip, a **Score & recommend** action (`POST /api/missions/:id/score`), inline **Generate draft / Approve / Reject** on each outreach intent (with the recommendation reasoning shown as evidence), a live **send-readiness** check, and the loop tail — an **Engagement** panel (sent / replied / bounced + reply rate and recent replies) and a **Learning** summary (scoring-model updates from recorded outcomes) — all without leaving the mission. A **guided stepper** at the top orients the operator through the loop (Discover → Score → Review → Ready → Engaged), deriving each step's state from the live funnel/readiness/engagement data and pointing at the next action. A mission's **target customer and offer now shape the outreach copy it generates** — merged over the workspace ICP in both the campaign-send and per-intent draft paths — so different missions speak to different segments. Remaining (optional): a full modal walkthrough on top of these primitives.

**2. Approval workflow — now first-class**
Drafts have a status (`DRAFTED | APPROVED | REJECTED | SENT | SKIPPED`), and a **Review Queue** (`/api/leads/approvals/pending` + the Approvals view) lets the team edit copy and approve/reject before anything sends; `approvalMode` gates campaign sends to `APPROVED` drafts. Approvals/edits are audit-logged.

**3. Example data excluded from intelligence endpoints — Resolved ✓**
Once any real prospect exists, example/seed prospects are filtered out everywhere it matters: `/api/intelligence/opportunities`, `/forecast` (including won-revenue, via the prospect relation), and `/stats` (prospect counts, tier buckets, stage distribution, and signal breakdown through the prospect relation) all apply the same `isExample: false` gate. The learning loop aggregates `ScoringOutcome` rows, which are only ever recorded against real in-workspace prospects, so calibration is unaffected by demo data. ✓ Resolved.

**4. Compliance footer — Resolved ✓**
Outbound emails carry a full compliance footer: an unsubscribe link plus the
workspace `senderBusinessName` and `senderPostalAddress` (CAN-SPAM / GDPR sender
identity + physical address) when configured. Those fields are editable in
Settings (`PATCH /api/workspaces/:id`, validated), persisted on the `Workspace`
model, and the send-readiness check + getting-started checklist flag them as
required before launch. ✓ Resolved.

**5. Discovery source errors — partially addressed**
A `DiscoveryRun` model records every run (status, counts, error code/message); both Apollo and Google Places now throw on provider failure (no swallowed `[]`), failures surface as a `502` with a clear message (not a misleading "no results"), `GET /api/prospects/discovery-runs` exposes history, and the Prospects view shows a **discovery-history panel** flagging failed runs and their reasons. ✓ Resolved.

### Medium priority (important before scaling)

**6. Worker shares backend code via cross-package file imports — Resolved ✓**
Shared backend runtime logic (`prisma`, `scoring`, `signalEngine`, `mail`, `suppressions`, etc.) now lives in the `packages/backend-core` workspace, which both `api` and `worker` depend on. The worker no longer reaches into `apps/api/src/`; `npm run check:boundaries` enforces this in CI. (Typed request contracts live in `packages/shared`.) ✓ Resolved.

**7. Discovery providers use platform-level API keys — quota enforced + surfaced**
Apollo, Google Places, and Hunter keys are set once for the whole platform, but discovery is metered per workspace with a monthly quota (`checkAndIncrementDiscoveryUsage`: free 25 / starter 500 / growth unlimited; `429` when exceeded) and every run is recorded in `DiscoveryRun`. Usage vs. plan limits (AI, discovery, leads) is shown on the Billing page, and **per-provider cost weighting** now estimates weighted discovery spend (Apollo > Places > Hunter) and surfaces it on Billing. ✓ Resolved.

### Low priority (polish)

**8. Mission workflow — operator loop now drivable from the mission**
`Mission` is a first-class model and API (`/api/missions`) with a Missions view; creating a mission provisions its linked execution `Campaign`, the list surfaces per-mission deliverability + pending-review + discovery stats, and discovery runs can be scoped to a mission. Recommendations and the approval queue are now wired **directly into the mission control plane**: the detail panel drives discover → score/recommend → review evidence → approve/reject draft → send-readiness, and now closes the loop with per-mission **engagement** (deliverability + replies) and **learning** (scoring-model adaptation), fronted by a **guided stepper** that shows where the mission is in the loop and what to do next (see #1). Still to deepen: per-mission ICP/playbook overrides.

**9. Observability — Resolved ✓**
Request IDs + structured JSON logging, an `AuditEvent` log (surfaced in the Admin Recent Activity view + `GET /api/admin/audit`), DB+Redis-aware health/readiness probes, a Prometheus `GET /metrics` endpoint, and a pluggable error-capture seam with an optional Sentry transport (`SENTRY_DSN`) all exist. The monitoring stack is shipped end-to-end in [`ops/monitoring/`](ops/monitoring/): a Grafana dashboard, Prometheus alert rules, **external uptime/synthetic probes** (blackbox exporter), and **Alertmanager routing** (PagerDuty for critical, Slack for all) — backed by documented [SLOs + error budget](docs/SLO.md) and per-alert [runbooks](docs/RUNBOOKS.md). ✓ Resolved. See [`docs/OPERATIONS.md`](docs/OPERATIONS.md).

---

## Architecture

```
apps/
  api/        Express API (TypeScript, compiled to dist/)
  web/        React + Vite frontend
  worker/     BullMQ background job worker
packages/
  backend-core/  Shared backend runtime (prisma, scoring, mail, queues…) used by api + worker
  db/            Prisma schema and migrations (PostgreSQL)
  shared/        Typed API contracts shared by api + web (single source of truth)
tests/        API integration test suite (tsx + node:test)
e2e/          Playwright browser smoke tests (real UI against real servers)
```

**Typed API contract (`packages/shared`):** request bodies for mutation
endpoints are defined once and imported (type-only) by both the API and the web
client. Omitting a field the backend requires (e.g. `workspaceId`, `approved`)
is a **compile error at the call site**, not a 400/403 discovered in production.
Backend zod schemas are pinned to the same contracts with compile-time
conformance assertions, so validation and contract can't silently drift.

**Queues (BullMQ + Redis):**
- `research-prospect` — AI company research
- `score-prospects` — opportunity scoring
- `generate-recommendations` — action recommendations
- `send-campaign` — batch outreach send
- `sync-mailbox` — IMAP reply pull (repeatable, every 10 min)
- `classify-reply` — AI reply intent classification
- `calibrate-scoring` — learning loop update
- `generate-outreach` — draft generation

**Key services:**
- OpenAI (research + outreach generation + reply classification)
- Stripe (billing + webhooks)
- SMTP/IMAP (per-workspace or global fallback)
- Apollo.io, Google Places, Hunter.io (prospect discovery — optional)

**Observability & operations:** DB+Redis-aware health/readiness probes
(`/api/live`, `/api/ready`, `/api/health`), a Prometheus `/metrics` endpoint, a
pluggable error-capture seam with an optional Sentry transport, structured JSON
logs with request-id correlation, and a dependency-free load-test harness
(`npm run loadtest`). Full operator guide: [`docs/OPERATIONS.md`](docs/OPERATIONS.md).

## GitHub automation

GitHub automation is now split into four layers: `CI`, `CodeQL`, `Dependabot`, and `Release`. The repo-side contract lives in [`docs/CI_CD.md`](docs/CI_CD.md), and the last non-git repository settings are documented in [`docs/GITHUB_ADMIN.md`](docs/GITHUB_ADMIN.md).
