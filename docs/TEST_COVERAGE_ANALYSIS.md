# Test Coverage Analysis & Improvement Plan

_Last updated: 2026-06-12_

## Summary

The suite is strong on **pure-function logic** but had **no coverage of the
HTTP/data layer** — the routes where authorization, billing, and data
integrity actually live. Every existing test runs without a database, without
Express, and without Prisma; two files (`lib-limits`, `outcomes-scoring`) even
re-implement logic inline rather than importing the real source, so those
production paths weren't being exercised at all.

This document records the gap analysis and a prioritized plan. The first
priority item has been implemented (see _Work completed_ below).

## Current coverage (baseline: 254 tests, all passing)

| Area | Module(s) | Coverage |
| --- | --- | --- |
| Validation / normalization | `lib/validation` | Strong (unit + chaos) |
| JWT & refresh tokens | `lib/jwt` | Strong (unit + chaos + adversarial) |
| Lead scoring | `lib/scoring` | Good |
| Signal engine | `lib/signalEngine` | Good |
| Error handling | `lib/http` | Good |
| Env guards | `lib/env` | Good |
| Auth middleware | `middleware/auth` | Good (mocked req/res) |
| Rate limiting | `middleware/rateLimit` | Good (mocked req/res) |
| Mail / OpenAI config guards | `services/mail`, `services/openai` | Config-only |
| **All 14 route handlers (~2,400 LOC)** | `routes/*` | **None** |
| Plan-limit enforcement | `lib/limits` | Inline copy only — real module untested |
| Learning-loop calibration | `lib/learningLoop` (`calibrate`) | Untested |
| Stripe / billing logic | `routes/billing`, `services/stripe` | Untested |

## Prioritized improvement plan

### P1 — Authorization / workspace isolation (security-critical)
The routes scoped by a **client-supplied `workspaceId` / record id** are the
highest risk. `routes/signals.ts` was verified to have **no membership check**
on `GET`, `POST`, or `DELETE` — any authenticated user could read or delete
another workspace's signals by guessing an id. A full audit found the same
defect in `routes/intelligence.ts` (all three endpoints leaked another
workspace's pipeline, revenue forecast, and prospect stats). `routes/stats.ts`
was audited and is **already correctly guarded** (the earlier "implicit scope"
note was a false alarm).

→ **Status: DONE. `signals.ts` and `intelligence.ts` fixed and covered; the
rest of the route layer was audited and confirmed guarded.**

### P2 — Billing & Stripe webhooks (money-critical) — DONE
`routes/billing.ts` had a ~100-line untested webhook state machine
(`checkout.session.completed` → `active` → `past_due` → `canceled`, plan
resolution from `priceId`, subscription lookups). Now covered by
`tests/routes-billing-webhook.test.ts`, including **real signature
verification** (forged / missing signatures rejected with no DB write), each
lifecycle transition, unknown-event acknowledgement, and plan resolution.

### P3 — Auth lifecycle (`routes/auth.ts`) — DONE
`tests/routes-auth.test.ts` (10 tests) covers signup (user + workspace +
membership transaction, email normalization, duplicate / weak-password
rejection), login (generic `Invalid credentials` for both wrong-password and
unknown-email), and the security-critical **refresh-token rotation**: a used
token is revoked and a new one issued; revoked / expired tokens are rejected;
logout revokes.

### P4 — Plan-limit enforcement (`lib/limits.ts`) — DONE
Previously tested via an inlined copy. `tests/lib-limits-enforcement.test.ts`
now exercises the **real module**: the `>=` boundary on lead / AI caps, the
growth-plan short-circuit, and — most importantly — the lapsed-subscription →
`free` downgrade that prevents a past-due workspace from keeping unlimited
usage.

### P5 — Ingest / bulk dedup (`routes/ingest.ts`, `routes/leads.ts`) — DONE
`tests/routes-ingest.test.ts` (11 tests): API-key workspace scoping,
within-batch dedup (first wins, case-insensitive), cross-workspace dedup,
batch cap (500), missing-businessName skip, campaign validation, and
owner-only key rotation / deletion. `routes/leads.ts` was audited and confirmed
to enforce membership on every endpoint.

### P6 — Learning-loop calibration (`lib/learningLoop.ts`) — DONE
`tests/lib-calibrate.test.ts` (6 tests): the `< 10` outcomes guard, baseline
win rate, win-rate lift with the `[0.5, 2.0]` multiplier clamp, the
`< 3`-sample skip, ICP industry / employee-band updates, and the
no-division-by-zero path when nothing was won.

## Recommended harness

A database-free integration tier (added in `tests/helpers/integration.ts`):
the production `lib/prisma.ts` resolves its client lazily from
`globalThis.__acaosPrisma__`, so a **fake Prisma client** can be injected
before any request runs. Tests mount the real router on an ephemeral-port HTTP
server and drive it with the built-in `fetch`, exercising routing, auth
middleware, handler logic, and error handling end to end — **no new
dependencies and no live PostgreSQL required**. The fake records every call
(`prisma.callsTo('signal', 'delete')`) so tests can assert that a denied
request never reached the database.

This complements rather than replaces the DB-backed tier below.

## Database-backed tier (`tests-db/`)

A second tier runs the **real** Prisma client against a **live PostgreSQL**
instance, to catch what the fake can't: actual query shapes, unique
constraints, `$transaction` behavior, and cascade deletes.

- **Isolation model:** set `DATABASE_URL`, inject *no* fake — `lib/prisma.ts`'s
  lazy client connects to the test DB. `tests-db/helpers/db.ts` provides
  `resetDb()` (truncates all tables between tests via
  `TRUNCATE … RESTART IDENTITY CASCADE`) and seed helpers, and reuses
  `startTestServer` / `bearer` from the fake-tier harness.
- **Serial execution:** the tier shares one database, so it runs with
  `--test-concurrency=1` (one file's `resetDb` must not truncate mid-test in
  another). This is wired into the `test:db` script.
- **Coverage (15 tests):** `auth` (real signup transaction, unique
  email/slug constraints, refresh-token rotation with real revocation),
  `ingest` (real within-batch + cross-workspace email dedup, workspace-scoped
  uniqueness), and `signals` (authorization + real rescore side effects).
- **Running it:**
  - Local: `npm run test:db:local` — `scripts/test-db-local.sh` boots an
    ephemeral Postgres cluster, applies migrations, runs the tier, and tears
    down. (Runs the server as the `postgres` OS user when invoked as root.)
  - CI: the `verify-db` job uses a `postgres:16` service container, runs
    `prisma migrate deploy`, then `npm run test:db`.
- **Boundary:** `npm test` (the fast fake tier) stays default and
  dependency-free; the DB tier is opt-in via `test:db` and requires a Postgres.

## Work completed — full roadmap (P1–P6) closed

All six priorities are done. **195 tests pass**, `npm run typecheck` is **clean
across api / web / worker**, and CI enforces both.

### Test additions (harness + ~100 new tests)
1. **Integration harness** — `tests/helpers/integration.ts`
   (`createFakePrisma` with call recording + `$transaction` support,
   `startTestServer`, `bearer`).
2. **P1 workspace isolation** — `routes-signals.test.ts` (10),
   `routes-intelligence.test.ts` (12), `routes-prospects.test.ts` (9).
3. **P2 billing webhooks** — `routes-billing-webhook.test.ts` (8), real
   signature verification.
4. **P3 auth lifecycle** — `routes-auth.test.ts` (10), incl. refresh rotation.
5. **P4 plan limits** — `lib-limits-enforcement.test.ts` (9), real module.
6. **P5 ingest / dedup** — `routes-ingest.test.ts` (11).
7. **P6 calibration** — `lib-calibrate.test.ts` (6).
8. **outcomes** — `routes-outcomes.test.ts` (7), dual-auth + reset regression.

### Bugs fixed (all were live defects)
- **Cross-workspace data leaks** in `routes/signals.ts` and
  `routes/intelligence.ts` (read/delete/forecast/stats with no membership
  check). Now enforced.
- **Broken owner-only action** — `routes/outcomes.ts` model-reset checked
  `role: 'OWNER'` vs the stored lowercase `'owner'`, so it 403'd every owner.
- **Missing module** — `routes/prospects.ts` imported a non-existent
  `services/apollo.js`; the `/enrich` endpoint would 500 at runtime. Added a
  config-guarded `services/apollo.ts` scaffold (clean 503 when unconfigured).
- **`instanceof` 500 leak** — that enrichment path used a dynamic
  `import('../services/apollo.js')`, which under the tsx runtime loads a second
  copy of `lib/http.ts`, so the thrown `ApiError` failed `errorHandler`'s
  `instanceof` check and leaked a 500. Switched to a static import.
- **ICP null/undefined bug** — `apps/worker/src/worker.ts` passed a raw
  `WorkspaceICP` (with `null` fields) where the scoring engine expects a shaped
  `ICPConfig`; now shaped consistently with the route layer.

### Tooling
- **Typecheck is now clean** (40 → 0) once the Prisma client is generated;
  fixed the remaining real type errors in `routes/prospects.ts`.
- **CI** — `.github/workflows/ci.yml` runs `npm ci` → `prisma generate` →
  `typecheck` → `test` on every push / PR, so the green state is enforced.

## Suggested next steps (optional hardening)
- Stand up a DB-backed test tier (test Postgres) and re-run the route suites
  against a real database to catch Prisma-query-shape issues the fake can't.
- Extend coverage to the smaller remaining routes (`campaigns`, `workspaces`,
  `jobs`, `mailbox`) for completeness — all are already authorization-guarded.
