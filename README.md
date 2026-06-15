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

**1. Mission Builder is a thin campaign creator**
The UI says "Mission Builder" but the backend just creates a campaign with a text description. A real mission should link ICP criteria, a playbook, a discovery run, generated recommendations, and a draft approval queue into one connected workflow. Needs a `Mission` database model and end-to-end wiring.

**2. Approval workflow is not first-class**
Campaign sends can be gated by an approval flag, but there is no approval queue. The correct flow is: recommendation → draft → approval queue → send attempt → outcome. Each draft should have a status (`DRAFTED | APPROVED | SENT | SKIPPED | REJECTED`) so the team can review before anything goes out.

**3. Example data not excluded from all intelligence endpoints**
Example/seed prospects are hidden from the opportunities list when real prospects exist. But the forecast, stats, and learning/calibration endpoints do not all apply the same `isExample` filter consistently. Example data could skew intelligence reports.

**4. Compliance footer is basic**
Outbound emails include an unsubscribe link, which is good. But the footer should also include the workspace business name, sender email, and a contact address to meet commercial email compliance requirements (CAN-SPAM, GDPR). Needs `senderBusinessName` and `senderPostalAddress` fields on the workspace.

**5. Discovery source errors are silent**
When Apollo or Google Places fails (network error, quota exceeded), the provider returns an empty result with no visible error. Users have no way to know a discovery run failed. Needs a `DiscoveryRun` database model to track status, error, and results per run.

### Medium priority (important before scaling)

**6. Worker cannot compile with `tsc` cleanly**
The worker imports shared utilities directly from `apps/api/src/lib/` (cross-package filesystem imports). This works with `tsx` at runtime but the TypeScript compiler enforces `rootDir` boundaries, so `npm run build -w @acaos/worker` fails with 3 type errors. Fix: move shared code (`suppressions`, `scoring`, `signalEngine`, `mail`, etc.) into a `packages/shared` workspace that both `api` and `worker` depend on as a proper package.

**7. Discovery providers use platform-level API keys**
Apollo, Google Places, and Hunter keys are set once in environment variables for the whole platform. There are no per-workspace quotas, usage tracking, or cost controls. As self-serve grows this becomes a cost and abuse risk. Needs per-workspace discovery quotas and a `DiscoveryRun` audit log.

**8. Prospect deduplication is code-only**
The code deduplicates by domain/company name in memory during import. The database has no unique constraint on `(workspaceId, domain)`, so concurrent imports or bugs can create duplicate prospect rows. Needs a partial unique index on the normalised domain field.

**9. Seed data uses random scores**
Example prospect scores are generated with `Math.random()` at seed time. This means demos look different every time and tests that depend on seed data are non-deterministic. Fix: use fixed, hardcoded scores per example company.

### Low priority (polish)

**10. Language is inconsistent across the product**
The UI calls things "Missions" but the database models, API routes, and backend code all say "Campaign". Acceptable short-term, but the product language should converge as the Mission workflow matures.

**11. Observability is incomplete**
Request IDs exist. Structured logging is partial. Missing: frontend error reporting (Sentry-style), SMTP failure dashboard, provider failure dashboard, discovery run dashboard, uptime checks.

**12. Tokens stored in localStorage**
Auth tokens are stored in `localStorage`. This is acceptable for early beta but `httpOnly` cookies would be safer against XSS for a hardened production deployment.

---

## Architecture

```
apps/
  api/        Express API (TypeScript, compiled to dist/)
  web/        React + Vite frontend
  worker/     BullMQ background job worker
packages/
  db/         Prisma schema and migrations (PostgreSQL)
tests/        API integration test suite (tsx + node:test)
```

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
