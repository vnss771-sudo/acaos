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
another workspace's signals by guessing an id. `routes/intelligence.ts` and
`routes/stats.ts` show the same implicit-scope pattern and need the same
treatment.

→ **Status: signals.ts fixed and covered (see below). intelligence.ts and
stats.ts still pending.**

### P2 — Billing & Stripe webhooks (money-critical)
`routes/billing.ts` contains a ~100-line untested webhook state machine
(`checkout.session.completed` → `active` → `past_due` → `canceled`, plan
resolution from `priceId`, subscription lookups). Tests needed for: invalid /
missing signature rejection, unknown-event acknowledgement, the
`active`-subscription-blocks-checkout guard, owner/admin-only access, and
`resolvePlanFromPrice` defaulting unknown prices to `starter`.

### P3 — Auth lifecycle (`routes/auth.ts`)
Signup (user + workspace + membership transaction), login, **refresh-token
rotation** (revoke-old / issue-new), and password change are untested. The pure
JWT helpers are covered, but the stateful flow around them is not.

### P4 — Plan-limit enforcement (`lib/limits.ts`)
Currently tested via an inlined copy. Test the **real module**: the `>=`
boundary on lead / AI caps, monthly-counter upsert idempotency, and the
lapsed-subscription → `free` downgrade — these are the actual bypass risks.

### P5 — Ingest / bulk dedup (`routes/ingest.ts`, `routes/leads.ts`)
Email-normalized dedup (within-batch + across-workspace), batch caps
(200 / 500), and API-key workspace scoping.

### P6 — Learning-loop calibration (`lib/learningLoop.ts`)
The `calibrate()` path: win-rate lift, `[0.5, 2.0]` multiplier clamp, ICP
percentile updates, and the `< 10` outcomes guard. Note: weights are **not**
re-normalized after the multiplier is applied — add a test to confirm whether
that is intended.

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

This complements rather than replaces a future full DB-backed tier; once
`prisma generate` + a test Postgres are reliably available in CI, the same
route tests can run against a real database with minimal change.

## Work completed in this pass

1. **Integration harness** — `tests/helpers/integration.ts`
   (`createFakePrisma`, `installPrisma`, `startTestServer`, `bearer`).
2. **P1 signals authorization tests** — `tests/routes-signals.test.ts`
   (10 tests). The three cross-workspace cases failed against the original
   code, confirming the isolation defect.
3. **Bug fix** — `apps/api/src/routes/signals.ts` now calls
   `userBelongsToWorkspace` on `GET`, `POST`, and `DELETE`, and verifies the
   target prospect belongs to the named workspace on `POST`. Suite is green
   (264 tests).

> Note: `npm run typecheck` reports pre-existing errors caused by the Prisma
> client not being generated in this environment (a documented known limit);
> none originate from the changes above.

## Suggested next steps

- Apply the same membership check + tests to `routes/intelligence.ts` and
  `routes/stats.ts` (P1).
- Add billing webhook tests using the harness with `express.raw` body and a
  stubbed `constructWebhookEvent` (P2).
- Wire `prisma generate` into a CI step so the full typecheck and a future
  DB-backed test tier can run.
