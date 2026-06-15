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

### Docker

```bash
docker compose -f docker-compose.local.yml up --build
```

### Useful commands

```bash
npm run build          # compile api + worker + web
npm run test           # full API test suite (740+ tests)
npm test -w @acaos/web # frontend test suite (51 tests)
npm run test:e2e       # Playwright browser smoke tests (see e2e/README.md)
npm run typecheck      # TypeScript check (web + api)
npm run prisma:generate
npm run prisma:migrate
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

## Known issues — remaining work before public launch

These are open items from the engineering release-gate review. Fixed items are not listed here.

### High priority (fix before onboarding paying users)

**1. Mission Builder — now first-class (deepening continues)**
A `Mission` model + `/api/missions` API + Missions view now exist; creating a mission provisions its linked execution campaign. Still to wire directly into the mission control plane: ICP/playbook selection, discovery runs, and recommendations.

**2. Approval workflow — now first-class**
Drafts have a status (`DRAFTED | APPROVED | REJECTED | SENT | SKIPPED`), and a **Review Queue** (`/api/leads/approvals/pending` + the Approvals view) lets the team edit copy and approve/reject before anything sends; `approvalMode` gates campaign sends to `APPROVED` drafts. Approvals/edits are audit-logged.

**3. Example data not excluded from all intelligence endpoints**
Example/seed prospects are hidden from the opportunities list when real prospects exist. But the forecast, stats, and learning/calibration endpoints do not all apply the same `isExample` filter consistently. Example data could skew intelligence reports.

**4. Compliance footer is basic**
Outbound emails include an unsubscribe link, which is good. But the footer should also include the workspace business name, sender email, and a contact address to meet commercial email compliance requirements (CAN-SPAM, GDPR). Needs `senderBusinessName` and `senderPostalAddress` fields on the workspace.

**5. Discovery source errors — partially addressed**
A `DiscoveryRun` model records every run (status, counts, error code/message), provider failures surface as a `502` with a clear message (not a misleading "no results"), `GET /api/prospects/discovery-runs` exposes history, and the Prospects view shows a **discovery-history panel** flagging failed runs and their reasons. Remaining: make the Google Places provider throw on failure rather than returning `[]`.

### Medium priority (important before scaling)

**6. Worker shares backend code via cross-package file imports**
The worker imports runtime utilities directly from `apps/api/src/lib/` (e.g. `prisma`, `scoring`, `signalEngine`, `mail`, `suppressions`). It now compiles and type-checks cleanly, but this couples the worker build to the API's source layout. Fix: extract shared backend logic into a `packages/backend-core` workspace that both `api` and `worker` depend on. (Typed request contracts already live in `packages/shared`.)

**7. Discovery providers use platform-level API keys — quota now enforced**
Apollo, Google Places, and Hunter keys are set once for the whole platform, but discovery is now metered per workspace with a monthly quota (`checkAndIncrementDiscoveryUsage`: free 25 / starter 500 / growth unlimited; `429` when exceeded) and every run is recorded in `DiscoveryRun`. Remaining: surface usage in the UI and per-provider cost weighting.

### Low priority (polish)

**8. Mission workflow is still maturing**
`Mission` is now a first-class model and API (`/api/missions`) with a Missions view; creating a mission also provisions its linked execution `Campaign`. Still to deepen: wiring discovery runs, recommendations, and an approval queue directly into the mission control plane (status lifecycle exists: DRAFT→…→COMPLETE).

**9. Observability is incomplete**
Request IDs and structured request logging exist; an `AuditEvent` log records significant actions (campaign sends, mission status changes, draft approvals, discovery/bounce failures) and is surfaced in the **Admin panel's Recent Activity view** (plus `GET /api/admin/audit`). Remaining: frontend error reporting (Sentry-style) and external uptime checks.

---

## Architecture

```
apps/
  api/        Express API (TypeScript, compiled to dist/)
  web/        React + Vite frontend
  worker/     BullMQ background job worker
packages/
  db/         Prisma schema and migrations (PostgreSQL)
  shared/     Typed API contracts shared by api + web (single source of truth)
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
