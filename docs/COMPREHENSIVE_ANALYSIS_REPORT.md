# ACAOS — Comprehensive Codebase Analysis Report

**Generated:** 2026-06-09  
**Version Analyzed:** v1.3.0  
**Branch:** `claude/comprehensive-analysis-report-9ylawp`

---

## 1. Project Overview

**ACAOS** (Agentic Client Acquisition OS) is a production-oriented SaaS platform for autonomous lead generation and sales engagement. It targets field-service companies (civil, electrical, plumbing, HVAC, landscaping, etc.) and automates the full outreach lifecycle: AI-powered prospect research, personalized cold email generation, reply classification, and a self-improving scoring model — all backed by Stripe billing and workspace-based multi-tenancy.

| Aspect | Value |
|--------|-------|
| **Version** | 1.3.0 |
| **Type** | Full-stack SaaS monorepo |
| **Primary Language** | TypeScript |
| **Frameworks** | Express.js, React 18, Vite, Prisma, BullMQ |
| **Databases** | PostgreSQL (primary), Redis (job queue) |
| **Deployment Targets** | Railway, Render, Vercel, Docker Compose |
| **ICP** | Field-service companies |
| **Test Coverage** | 2,082 lines across 12 test files (152+ assertions) |

---

## 2. Repository Structure

```
/acaos/
├── apps/
│   ├── api/              # Express.js backend (TypeScript)
│   ├── web/              # React + Vite frontend (TypeScript)
│   └── worker/           # BullMQ job processor (TypeScript)
├── packages/
│   └── db/               # Shared Prisma schema + migrations
├── scripts/              # Smoke tests, CLI helpers
├── tests/                # Root test suite (unit & integration)
├── infra/
│   ├── railway/          # Railway deployment config
│   └── render/           # Render deployment config
├── docs/                 # Runbooks, hardening notes, env vars
├── docker-compose.local.yml
├── vercel.json
├── README.md
└── CHANGELOG.md
```

### App Responsibilities

| App | Role |
|-----|------|
| `apps/api` | REST API server — auth, CRUD, AI calls, billing, job queuing |
| `apps/web` | React SPA — dashboard, lead management, campaign builder, billing |
| `apps/worker` | Background job processors — research, outreach, reply analysis, mailbox sync |
| `packages/db` | Shared Prisma client, schema, migrations |

---

## 3. Backend Architecture (`apps/api`)

**Framework:** Express.js 4.x | **Runtime:** Node.js 20 | **Language:** TypeScript

### Route Map

| Route Group | Endpoints | Purpose |
|-------------|-----------|---------|
| `/api/auth` | signup, login, refresh, logout, me | JWT auth + refresh token rotation |
| `/api/campaigns` | CRUD + list | Campaign management |
| `/api/leads` | CRUD, import, bulk-*, drafts | Lead lifecycle management |
| `/api/ai` | research, outreach, reply-analysis | Inline OpenAI calls |
| `/api/jobs` | submit, poll, SSE stream | Async job queue interface |
| `/api/ingest` | POST + key rotation | Autonomous lead ingestion (API key auth) |
| `/api/billing` | checkout, status, webhook | Stripe integration |
| `/api/mailbox` | sync, send-test | IMAP/SMTP operations |
| `/api/stats` | GET | Funnel metrics, scoring model, usage |
| `/api/outcomes` | POST | ScorerV2 feedback loop |
| `/api/workspaces` | GET, membership ops | Multi-tenant workspace management |
| `/api/health` | GET | DB connectivity check |

### Middleware Stack

| Middleware | Details |
|------------|---------|
| `cors` | Whitelist: `WEB_URL`, `*.railway.app`, `*.vercel.app` (strict in production) |
| `express.json` | Body parsing with 1MB limit |
| `auth.ts` | JWT Bearer token verification; DB-backed user lookup |
| `rateLimit.ts` | 5 tiers: auth (10/15m), AI (60/h), general (200/m), mail (5/h), sync (10/h) |
| `errorHandler` | Centralized error normalization; async handler wraps all routes |

### Key Services

| Service | File | Integration |
|---------|------|-------------|
| OpenAI | `services/openai.ts` | gpt-4o-mini, json_object format, temp 0.4 |
| Stripe | `services/stripe.ts` | Checkout sessions, HMAC-verified webhooks |
| Mail | `services/mail.ts` | Nodemailer (SMTP out), ImapFlow (IMAP in) |

---

## 4. Frontend Architecture (`apps/web`)

**Framework:** React 18 + Vite | **Language:** TypeScript | **Styling:** CSS-in-JS

### Views

| View | Purpose |
|------|---------|
| `Dashboard` | Funnel metrics, scoring model, usage meter |
| `Campaigns` | Campaign CRUD with lead assignment |
| `Leads` | Lead table, stage management, bulk operations, AI tools |
| `AiTools` | Inline AI research, outreach draft, reply analysis |
| `Billing` | Stripe checkout, subscription status |
| `Settings` | Workspace config, mailbox setup, API key management |

### Key Patterns

- JWT auth with token refresh & localStorage persistence
- Multi-workspace switcher in sidebar
- Real-time job progress via `EventSource` (SSE)
- Lead scoring tier visualization (HOT/WARM/COLD)
- Plan enforcement in UI (usage meter, locked features)
- `useApi` hook wraps all HTTP calls with auth headers

---

## 5. Worker Architecture (`apps/worker`)

**Framework:** BullMQ | **Backend:** Redis

| Queue | Job | OpenAI Call | DB Effect |
|-------|-----|-------------|-----------|
| `research-lead` | researchWorker | `generateLeadResearch()` | Sets `aiSummary`, `outreachAngle`, `score`; stage → `RESEARCHED` |
| `generate-outreach` | outreachWorker | `generateOutreach()` | Creates `OutreachDraft`; stage → `OUTREACH_SENT` |
| `analyze-reply` | replyWorker | `analyzeReply()` | Creates `ScoringOutcome`; feeds ScorerV2 |
| `sync-mailbox` | mailboxWorker | — | IMAP sync with deduplication via `ProcessedEmail` |

Workers share code via direct imports from `apps/api/src/` (services, lib, Prisma client).

---

## 6. Database Schema (Prisma + PostgreSQL)

**ORM:** Prisma 5.18.0 | **Migrations:** 4 (2026-05-05 → 2026-06-06)

### Data Model

```
User ──< Membership >── Workspace
                          │
                    ┌─────┼─────────┐
                    │     │         │
                Campaign  Lead   ScoringModel
                    │     │         │
                    │   OutreachDraft  ScoringOutcome
                    │
               UsageRecord
               RefreshToken
               ProcessedEmail
```

### Core Models

| Model | Key Fields | Notes |
|-------|-----------|-------|
| `User` | id, email, passwordHash | bcrypt, rounds=10 |
| `Workspace` | slug (unique), plan, stripeCustomerId, ingestApiKey | Multi-tenant root |
| `Membership` | userId, workspaceId, role | owner/admin/member; unique pair index |
| `Campaign` | workspaceId, name, goalType | Scoped to workspace |
| `Lead` | workspaceId, campaignId, stage, score | Stage enum: NEW→RESEARCHED→OUTREACH_SENT→REPLIED→BOOKED→CLOSED→DEAD |
| `OutreachDraft` | leadId, subject, emailBody, followup | AI-generated copy |
| `ScoringModel` | workspaceId (unique), weights (JSON), performanceMetrics | Per-workspace ML weights |
| `ScoringOutcome` | leadId, score, replied, replyIntent | Feedback signal for ScorerV2 |
| `UsageRecord` | workspaceId, month, action, count | Plan enforcement (unique per workspace+month+action) |
| `ProcessedEmail` | uid (unique), messageId (unique) | IMAP deduplication |

### Indexes (Performance)

- `Lead(workspaceId)`, `Lead(workspaceId, stage)`, `Lead(workspaceId, email)`, `Lead(campaignId)`
- `ScoringOutcome(workspaceId)`, `ScoringOutcome(leadId)`

---

## 7. Test Suite

**Runner:** Node.js built-in `test` | **Executor:** `tsx --test tests/**/*.test.ts`

| File | Tests | Coverage Area |
|------|-------|---------------|
| `chaos.test.ts` | ~60 | JWT corruption, null bytes, password edge cases |
| `outcomes-scoring.test.ts` | ~30 | ScorerV2 weights, correlation, reply intent mapping |
| `api-validation.test.ts` | ~25 | Email normalization, slug sanitization, JWT secret enforcement |
| `stats-funnel.test.ts` | ~20 | Funnel metrics, reply/booking rates, stage distribution |
| `middleware-ratelimit.test.ts` | ~18 | Rate limit windows, key extraction, header propagation |
| `lib-http.test.ts` | ~15 | Error handler, asyncHandler, 404 |
| `lib-scoring.test.ts` | ~12 | Lead scoring algorithm, industry/hiring/growth signals |
| `middleware-auth.test.ts` | ~10 | JWT verification, user lookup, 401 handling |
| `services-mail.test.ts` | ~10 | SMTP/IMAP config, plain-text extraction, reply parsing |
| `lib-limits.test.ts` | ~8 | Plan-based AI call & lead limits |
| `services-openai.test.ts` | ~8 | Client init, model fallback |
| `lib-env.test.ts` | ~8 | Env var validation |

**Testing Strategy:** Pure function unit tests; no database calls; mocks where needed. Chaos tests cover adversarial input.

---

## 8. Security Analysis

### Strengths

| Control | Implementation |
|---------|---------------|
| Password hashing | bcryptjs, rounds=10 |
| JWT enforcement | Fails hard in production if `JWT_SECRET` == "change-me" |
| Refresh token rotation | DB-backed; revoked on logout |
| Workspace isolation | All queries scoped by `workspaceId`; membership check on every route |
| Rate limiting | 5-tier per-endpoint limits |
| Stripe webhook auth | HMAC-SHA256 signature verification |
| Ingest API key auth | x-api-key header; owner-only rotation |
| Input validation | Email regex (null byte resistant), password min length, slug sanitization |
| CORS | Production whitelist; dev open |

### Vulnerabilities / Risks

| Risk | Severity | Detail |
|------|----------|--------|
| In-memory rate limits | Medium | Restarting API resets all rate limit windows; stateless = bypassable via rolling restarts |
| No API versioning | Low | Breaking changes will affect all clients simultaneously |
| Worker imports from API | Low | Tight coupling; API code changes can silently break worker |
| No structured logging | Medium | Hard to audit security events, trace auth failures, or detect abuse patterns |
| No request ID tracking | Low | Makes distributed tracing and incident investigation difficult |
| IMAP credentials in env | Low | Plaintext in `.env`; ensure secret manager in production |

---

## 9. Dependencies

### Runtime Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| express | 4.19.2 | HTTP server |
| @prisma/client | 5.18.0 | ORM |
| bullmq | 5.12.12 | Job queue |
| ioredis | 5.4.1 | Redis client |
| jsonwebtoken | 9.0.2 | JWT |
| bcryptjs | 2.4.3 | Password hashing |
| openai | 6.0.0 | OpenAI SDK |
| stripe | 16.8.0 | Stripe SDK |
| nodemailer | 8.0.5 | SMTP |
| imapflow | 1.0.181 | IMAP |
| react | 18.3.1 | Frontend |
| vite | 8.0.7 | Bundler |
| typescript | 5.5.4 | Type checker |
| tsx | 4.20.6 | TypeScript runner |

### External Service Integrations

| Service | Purpose | Auth |
|---------|---------|------|
| OpenAI | AI research, outreach, reply classification | `OPENAI_API_KEY` |
| Stripe | Subscription billing | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` |
| PostgreSQL | Primary datastore | `DATABASE_URL` |
| Redis | Job queue & caching | `REDIS_URL` |
| SMTP provider | Outbound email | `SMTP_USER`, `SMTP_PASS` |
| IMAP provider | Inbound mailbox sync | `IMAP_USER`, `IMAP_PASS` |

---

## 10. Deployment Configuration

### Railway (Primary)

Deployment order: **Postgres → Redis → API → (prisma migrate) → Worker → Web**

| Service | Build Command | Start Command |
|---------|--------------|---------------|
| API | `npm install && npm run prisma:generate` | `npm run dev:api` |
| Worker | `npm install` | `npm run dev:worker` |
| Web | `npm install && npm run build` | `npx serve -s apps/web/dist -l 4173` |

### Render

3-service config in `infra/render/render.yaml` (API, Worker, Web as Node.js web/worker services).

### Vercel

SPA-only: builds `apps/web`, outputs `apps/web/dist`, all paths rewrite to `/index.html`.

### Docker Compose (Local)

Full stack with health checks:
- Postgres 16 + Redis 7 (infrastructure)
- API waits for Postgres + Redis healthy
- Worker waits for Postgres + Redis healthy
- Web waits for API healthy

### CI/CD

**No automated CI/CD pipeline exists.** All quality gates (tests, typecheck, build, audit, smoke) are manual:

```bash
npm run test          # Run test suite
npm run typecheck     # TypeScript check
npm run build         # Web build
npm audit             # Dependency audit
npm run smoke:api     # API health check
```

---

## 11. Technical Debt & Known Limitations

### Immediate (Should Address)

| Item | Impact | Recommendation |
|------|--------|----------------|
| No CI/CD pipeline | High — regressions ship silently | Add GitHub Actions: test + typecheck on PR |
| In-memory rate limiting | Medium — resets on restart | Migrate to Redis-backed rate limiting (e.g., `rate-limit-redis`) |
| No structured logging | Medium — blind in production | Add `pino` or similar; log auth events, job failures, AI errors |
| Worker-API coupling | Medium — fragile dependency | Extract shared code to `packages/shared` |

### Short-Term

| Item | Impact | Recommendation |
|------|--------|----------------|
| No request ID tracing | Low-Medium | Add `x-request-id` header generation + propagation |
| No DB connection pooling | Low-Medium | Add PgBouncer or configure Prisma connection pool |
| No API versioning | Low | Add `/api/v1` prefix now before public adoption |
| No caching layer | Low | Cache workspace settings, scoring models in Redis |
| IMAP integration scope | Low | Define clear acceptance criteria for full lifecycle testing |

### Long-Term

| Item | Note |
|------|------|
| ScorerV2 feedback loop | Needs more data before weights become meaningful; add min-sample guard |
| Email deliverability | No SPF/DKIM/DMARC validation in SMTP config checks |
| Multi-region | Single Postgres instance; no read replicas |
| Observability | No APM, distributed tracing, or error aggregation (e.g., Sentry) |

---

## 12. Git History Summary

| Commit | Date | Change |
|--------|------|--------|
| a7d679e | 2026-06-07 | Merge: comprehensive-analysis-report (PR #4) |
| 09c7bcf | 2026-06-06 | feat: scoring engine, plan limits, IMAP sync, SSE, bulk ops |
| 09233e7 | 2026-06-06 | feat: ScorerV2 persistence + outcomes feedback loop |
| 32b36e6 | 2026-06-06 | test: 152 tests across all layers |
| f1e417a | 2026-06-06 | test: chaos suite + null byte bypass fix |
| 23273f9 | 2026-06-06 | feat: autonomous lead gen ingest endpoint + API key auth |
| 31d6d02 | 2026-06-06 | docs: full codebase analysis report |
| 76ef40f | 2026-05-31 | Merge: SaaS code analysis (PR #2) |
| 64e1b93 | 2026-05-08 | fix: 8 SaaS-quality hardening fixes |

**Contributors:** vnss771-sudo (owner), Claude (automated development)

---

## 13. Recommendations Prioritized

### P0 — Before Production Go-Live

1. **Add GitHub Actions CI** — `npm run test && npm run typecheck` on every PR
2. **Redis-backed rate limiting** — Replace in-memory store with `ioredis` adapter
3. **Structured logging** — Add `pino`; log auth events, AI calls, billing events, job failures
4. **End-to-end smoke test** — Validate Stripe webhook → workspace plan update full cycle in staging

### P1 — First Month Post-Launch

5. **Request ID middleware** — `uuid` per request, propagate to logs and responses
6. **PgBouncer / connection pooling** — Required once concurrent users exceed ~20
7. **Sentry or equivalent** — Error aggregation for production incident response
8. **API versioning prefix** — Adopt `/api/v1/` before external integrations are built

### P2 — Growth Phase

9. **Extract `packages/shared`** — Move scoring, validation, types out of `apps/api` to break worker coupling
10. **Redis caching** — Cache workspace config, scoring model weights, plan limits
11. **Email deliverability tooling** — Validate SPF/DKIM/DMARC before bulk outreach goes live
12. **Read replica for analytics** — Offload `GET /api/stats` queries to replica

---

## Summary

ACAOS v1.3.0 is a well-structured, security-conscious SaaS scaffold with solid foundations: workspace-scoped multi-tenancy, JWT authentication with refresh token rotation, a 5-tier rate limiting system, async job processing with BullMQ, a self-improving scoring model, and a comprehensive 152-test suite covering chaos/edge cases.

The platform is **deployment-ready** on Railway, Render, or Docker Compose. Primary gaps before serious production traffic are: automated CI/CD, Redis-backed rate limiting, and structured observability. These are well-scoped additions that don't require architectural changes.

The codebase quality is high for a v1 product — type-safe throughout, consistent error handling, no audit vulnerabilities, and clear separation of concerns across API/Worker/Web/DB layers.
