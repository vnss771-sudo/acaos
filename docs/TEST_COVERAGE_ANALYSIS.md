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

### P3 — Auth lifecycle (`routes/auth.ts`)
Signup (user + workspace + membership transaction), login, **refresh-token
rotation** (revoke-old / issue-new), and password change are untested. The pure
JWT helpers are covered, but the stateful flow around them is not.

### P4 — Plan-limit enforcement (`lib/limits.ts`) — DONE
Previously tested via an inlined copy. `tests/lib-limits-enforcement.test.ts`
now exercises the **real module**: the `>=` boundary on lead / AI caps, the
growth-plan short-circuit, and — most importantly — the lapsed-subscription →
`free` downgrade that prevents a past-due workspace from keeping unlimited
usage.

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

## Work completed

1. **Integration harness** — `tests/helpers/integration.ts`
   (`createFakePrisma`, `installPrisma`, `startTestServer`, `bearer`, plus call
   recording for negative assertions).
2. **P1 — workspace isolation**
   - `tests/routes-signals.test.ts` (10 tests) and
     `tests/routes-intelligence.test.ts` (12 tests).
   - **Fix:** `routes/signals.ts` and `routes/intelligence.ts` now call
     `userBelongsToWorkspace` on every endpoint, and `signals.ts` POST also
     verifies the prospect belongs to the named workspace. The cross-workspace
     test cases failed against the original code, confirming the defects.
   - Full-route audit completed: every other route was confirmed to enforce
     membership (or API-key) scope.
3. **Role-casing bug** — `routes/outcomes.ts` model-reset checked
   `role: 'OWNER'` while memberships are stored lowercase (`'owner'`), so the
   reset endpoint returned 403 for *every* legitimate owner. Fixed to `'owner'`
   and covered by a regression test in `tests/routes-outcomes.test.ts`
   (7 tests, including the dual API-key / JWT auth paths and the
   weight-recompute-every-7 logic).
4. **P2 — billing webhooks** — `tests/routes-billing-webhook.test.ts` (8 tests)
   exercising real Stripe signature verification and every subscription
   lifecycle transition.
5. **P4 — plan-limit enforcement** — `tests/lib-limits-enforcement.test.ts`
   (9 tests) against the real `lib/limits.ts`, including the
   lapsed-subscription downgrade.

Net: **+46 route/enforcement tests**, suite fully green, and three real bugs
fixed (two cross-workspace data leaks + one broken owner-only action).

> Note: `npm run typecheck` reports pre-existing errors caused by the Prisma
> client not being generated in this environment (a documented known limit).
> Verified that the changes above introduce **zero** new typecheck errors
> (intelligence.ts: 19 before and after; project total unchanged at 40).

## Suggested next steps

- **P3 — auth lifecycle**: signup transaction, login, refresh-token rotation,
  password change (`routes/auth.ts`).
- **P5 — ingest / bulk dedup**: `routes/ingest.ts`, `routes/leads.ts`.
- **P6 — learning-loop calibration**: `lib/learningLoop.ts` `calibrate()`,
  including the un-normalized-weights question.
- Wire `prisma generate` into a CI step so the full typecheck and a future
  DB-backed test tier can run.
