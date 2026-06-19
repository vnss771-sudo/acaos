# ACAOS — Comprehensive Engineering Analysis

**Date:** 2026-06-19
**Scope:** Full-system review — static analysis, unit/integration/DB/Redis tests, chaos, security, performance, build & supply chain.
**Verdict:** 🟢 **Healthy.** Every quality gate passes. No failing tests, no lint/type errors, zero known dependency vulnerabilities, zero error-rate under load. Residual risk is confined to a small set of *already-documented, accepted* roadmap items (no surprises).

---

## 1. Executive summary

ACAOS is a multi-tenant, AI-powered outreach CRM (Express API + React/Vite web + BullMQ worker, sharing a `backend-core` package, on Prisma/PostgreSQL + Redis). It is unusually well-engineered for its stage:

- **Contract-first architecture** — request shapes live once in `packages/shared`, imported type-only by both API and web, with backend Zod schemas pinned to the same contracts (drift is a compile error, not a prod 400).
- **Enforced boundaries** — the worker may not reach into `apps/api`; checked in CI.
- **Deep test pyramid** — 1,357 automated tests across five tiers, all green.
- **Security posture mapped to OWASP ASVS** (L1 + L2 session/access controls) with control→code→test evidence.

| Dimension | Result |
|---|---|
| Static gates (boundaries, mutations, lint, typecheck) | ✅ all pass, 0 errors |
| Unit / integration (fast) | ✅ 1,082 / 1,082 |
| Chaos | ✅ 104 / 104 |
| DB-backed | ✅ 79 / 79 |
| Redis/queue-backed | ✅ 11 / 11 |
| Web (frontend) | ✅ 81 / 81 |
| Coverage gate (80 / 65 / 80) | ✅ 86.5% lines · 82.3% branches · 89.5% funcs |
| Production build (api + worker + web) | ✅ |
| Dependency audit (`npm audit`) | ✅ 0 vulnerabilities (incl. prod-only) |
| Secret scan / `.env` hygiene | ✅ clean, no secrets tracked |
| Performance (load test) | ✅ 0% error rate at all concurrencies |

**Total: 1,357 tests, 100% pass.**

---

## 2. Codebase at a glance

- ~160 source files, ~22k lines of TypeScript/TSX across `apps/{api,web,worker}` + `packages/{backend-core,shared,db}`.
- 40 Prisma migrations; schema-driven, no raw-SQL injection surface (all access via Prisma; the few raw statements use parameterized tagged templates).
- 98 test files across `tests/` (fast), `tests-db/` (Postgres), `tests-redis/` (queues).
- CI (`/.github/workflows/ci.yml`) runs the same gates this analysis ran: `verify`, `build`, `docker`, `verify-db`, `verify-redis`.

---

## 3. Static analysis

| Check | Command | Result |
|---|---|---|
| Architecture boundaries | `check:boundaries` | ✅ worker does not import `apps/api` |
| Frontend mutation discipline | `check:frontend-mutations` | ✅ all mutations via typed route client (0 pending, 1 documented exemption) |
| Lint | `eslint .` | ✅ 0 problems |
| Typecheck (shared, backend-core, api, web, worker) | `tsc --noEmit` ×5 | ✅ 0 errors |

The frontend-mutation guard and boundary guard are bespoke scripts — a sign the team encodes its architectural invariants as executable checks rather than convention.

---

## 4. Test results by tier

### Fast suite — 1,082 / 1,082 (69 suites)
Covers routes (auth, billing, campaigns, leads, missions, prospects, stats, ingest, RBAC gates, unsubscribe, workspaces), library invariants (scoring, signal engine, money/financial precision, encryption, JWT, SSRF, circuit breaker, rate limiting), services (OpenAI, mail), and observability/metrics. **Coverage gate (lines ≥80 / branches ≥65 / functions ≥80) passed at 86.5 / 82.3 / 89.5.**

### Chaos — 104 / 104 (7 suites)
`chaos.test.ts`, `signal-chaos-advanced.test.ts`, `operational-chaos-safety-gates.test.ts` — fault injection around the signal pipeline and operational safety gates (the send/limit guardrails). All hold under adverse inputs.

### DB-backed — 79 / 79 (ephemeral Postgres)
Approvals, audit, auth, campaign retry/stats, discovery quota & runs, the "golden spine" end-to-end path, ingest, intelligence, lead capacity, limits, mailbox, missions, outbox idempotency, prospects-money, signals, worker processors. (Includes negative-path assertions, e.g. invalid `BillingPlan` enum is rejected at the DB layer.)

### Redis/queue-backed — 11 / 11 (ephemeral Redis + Postgres)
BullMQ job lifecycle and SSE streaming.

### Web — 81 / 81 (20 files, Vitest)
Frontend components/hooks.

---

## 5. Security review

**Test-backed controls (all passing):** multi-tenancy isolation stress, cross-tenant access isolation, RBAC/admin gates, JWT handling, auth-log redaction (no secrets in logs), SSRF guard, and adversarial input (XSS/encoding) suites.

**Posture (per `docs/SECURITY_ASVS_MATRIX.md`, verified against code):**
- AuthN: bcrypt, generic login errors (no user enumeration), single-use expiring verification/reset tokens.
- Sessions: refresh token in `HttpOnly`/`Secure`/`SameSite` cookie, rotation + server-side revocation, CSRF header on cookie-auth mutations.
- AuthZ: tenant isolation on every workspace-scoped route; RBAC (owner/admin/member); platform-admin is a non-user-settable DB flag, not an env var.
- Validation: Zod on every body/query; AI model output and queue payloads schema-validated before any DB write.
- Data protection: mailbox creds AES-256-GCM at rest; security headers + HSTS; Stripe webhook signature verification; idempotency on webhooks and outbound sends.
- Supply chain: `npm audit` clean (0 across all severities); no secrets committed; no `.env` tracked.

**Accepted residual risk (documented roadmap, not regressions):**
- 🟡 **SSRF DNS-rebinding (TOCTOU):** the SSRF guard validates host/IP but does not yet pin DNS resolution — a rebind between check and connect remains theoretically possible for user-configured SMTP/IMAP hosts. *Mitigation today:* host allowlisting logic + the feature being owner-gated config, not anonymous input.
- 🟡 **CSP `style-src 'unsafe-inline'`:** required by inline style objects; CSS-token migration is tracked.
- 🟡 **Data-retention automation:** policy defined; automated enforcement partial.
- ⛔ **MFA/passkeys** and **step-up auth for admin/billing mutations:** roadmap.

None of these block the stated "controlled paid beta" posture; all are visible and tracked.

---

## 6. Performance (load test)

Smoke load test against the real API + live Postgres/Redis, ramping concurrency 10→50→100 over 4s windows. **0% error rate everywhere**; latency scales linearly with concurrency with no error cliff or lock-contention knee.

| Endpoint | conc | RPS | p50 | p95 | p99 | err% |
|---|---|---|---|---|---|---|
| GET /api/stats | 100 | 330 | 290 | 368 | 714 ms | 0 |
| GET /api/leads (page 50) | 100 | 623 | 150 | 180 | 558 ms | 0 |
| GET /api/prospects | 100 | 408 | 231 | 299 | 665 ms | 0 |
| POST /api/ingest (write) | 100 | 236 | 414 | 447 | 457 ms | 0 |

> Numbers are **relative** (single sandbox container ≠ production hardware) — they exist to find slow endpoints / error cliffs, not to set SLOs. Read path scales best (leads/prospects); `/api/stats` shows the steepest p99 growth under load (aggregation cost) and is the first candidate for caching if it becomes hot; ingest write throughput is steady and bounded as expected.

---

## 7. Recommendations (prioritized, all non-blocking)

1. **Cache or pre-aggregate `/api/stats`** — its p99 grows fastest under concurrency; a short-TTL cache or materialized counters would flatten it.
2. **Close the SSRF TOCTOU window** — pin the resolved IP through to connect for user-configured mail hosts (already on the roadmap; small, high-leverage hardening).
3. **Lift coverage on the lowest modules** — `backend-core/services/mail.ts` (58% lines) and `lib/queues.ts` (function coverage 20%) are the thinnest; both are infra-glue, but mail is security-adjacent.
4. **Advance the CSP** — migrate inline styles to CSS tokens to drop `'unsafe-inline'`.
5. **Operational follow-through (deploy-side, already noted in README #9):** wire an external uptime monitor + metrics dashboard/alerts to the existing `/metrics` and health probes.

---

## 8. Reproducing this analysis

```bash
npm ci
npm run prisma:generate
npm run check:boundaries && npm run check:frontend-mutations
npm run lint && npm run typecheck
npm run test:coverage      # fast suite + 80/65/80 gate
npm run test:chaos
npm run test:db:local      # ephemeral Postgres
npm run test:redis:local   # ephemeral Postgres + Redis
npm run test:web
npm run build
npm audit
# performance (needs live DB+Redis, JWT_SECRET>=32 chars):
npm run loadtest
```

*Not run here (require external browsers/credentials):* `npm run test:e2e` (Playwright; needs `playwright install chromium` + running stack) and `npm run eval:outreach` (needs OpenAI key). Both are wired and ready; they were out of scope for a credential-free sandbox run.

---

*Bottom line: this is a green build on every axis I could measure. The codebase enforces its own invariants in CI, the test pyramid is broad and honest (negative paths included), and the only open risks are the ones the team has already written down.*
