# ACAOS — find profitable work, win it, run it

**For trade contractors.** ACAOS finds the work (tenders and development
applications for your trade and area, plus businesses showing buying signals),
helps you win it, runs it (crew, shifts, sites), and tells you which work
actually made money — so next month you chase better work, not just more.

**Status:** pre-launch. The product is built and tested end to end; launch needs
hosting accounts and keys only (see [`docs/GO_LIVE_CHECKLIST.md`](docs/GO_LIVE_CHECKLIST.md)).

---

## The contractor loop

```
Find work → Pursue → Contact & quote → Win → Start the job → Crew & shifts → Close out → Margin
     ↑                                                                                      │
     └──────────────────── learn which work actually pays ─────────────────────────────────┘
```

| Step | Where in the app | What happens |
|---|---|---|
| Find work | **Work → Find work** | Every morning: government contracts just awarded and council development applications that match your trade and area, each with the evidence and who to call |
| Pursue | Find work card → **Pursue** | Marks it as work you're going after |
| Contact & quote | Same card: phone/email links, **Record quote** | Price and estimated labour hours, captured while you're doing it |
| Win | **Client accepted** | The work is marked won; the card follows you to the Won tab |
| Start the job | **Start the job** | Creates the job and its site in one click |
| Crew & shifts | **Crew → Crew / Shifts / Roster** | Crew with hourly rates; hours logged against the job's site |
| Close out | **Work → Jobs & margins → Job done — close out** | Invoice amount, materials and subcontractors, labour on-costs |
| Margin | **Jobs & margins**, **Today** | Quoted vs delivered, labour and gross margin, and what each kind of work earns |

**Today** is the landing screen: what needs a decision now (with the evidence
behind it), work won but not started, new this week, and the numbers — open
pipeline, won revenue, quote-to-win rate and delivered margin.

### Honest numbers

- An unknown is shown as unknown with the reason ("2 crew have no base rate"),
  never as $0.
- A finished job's figures are frozen; changing a rate later never rewrites them.
- Patterns (e.g. "development applications earn 29% gross") are shown only with
  the number of jobs behind them, and withheld below 3.

### Also included

- **Clients:** businesses showing buying signals (expansion, hiring, contract
  wins), scored, with cited evidence and the next move.
- **Outreach:** email campaigns with nothing sent before you approve it, and an
  inbox that sorts replies by intent.
- **Crew safety:** fatigue monitoring and alerts.

Positioning, pricing and terminology: [`POSITIONING.md`](POSITIONING.md).
Demo script: [`docs/DEMO_SCRIPT.md`](docs/DEMO_SCRIPT.md).

**Platform:** multi-tenant workspaces, role-based access (crew see their own
work; quotes, rates and margins are admin-only), Stripe billing, full audit
trail, background jobs (Redis + BullMQ), encrypted mailbox credentials.

---

## Local setup

> 📦 **Building from the source archive?** See **[`BUILD.md`](BUILD.md)** for the
> complete build & run guide — prerequisites, local dev, production build, Docker,
> environment variables, the CI verify gates, and how the shared `@acaos/backend-core`
> package resolves under tsc/tsx/node. The quick start below is the short version.

### Requirements
- Node.js 22+ (CI and local dev use Node 22 — see `.nvmrc` / `engines`; the production Docker images run Node 26, which is within the supported range)
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
npm run test:coverage  # same, with the 84/78/87 coverage gate (lines/branches/functions)
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


## Open work

Open engineering work, pending decisions and the launch path are kept in one place:
[`docs/HANDOVER.md`](docs/HANDOVER.md). Items resolved from the earlier release-gate
review (approval workflow, compliance footer, discovery errors, backend-core split,
observability and others) are in the git history.

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
