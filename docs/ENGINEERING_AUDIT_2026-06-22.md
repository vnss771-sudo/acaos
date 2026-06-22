# ACAOS — Comprehensive Engineering Audit

**Date:** 2026-06-22
**Scope:** Full monorepo — `apps/api` (Express), `apps/worker` (BullMQ), `packages/backend-core`, `packages/db` (Prisma/Postgres), `packages/shared`
**Method:** Six parallel specialist reviews (architecture, security, reliability/data-integrity, scale/performance, observability/ops, tests/product-correctness), each evidence-backed with `file:line` citations, reconciled against a fully-verified build baseline.
**Codebase size:** 228 TS source files · 152 test files (108 unit + 44 DB) · 35 Prisma models · 60 migrations · 20 API route modules.

---

## 1. Verdict

**ACAOS is production-ready for its current scale, built with senior-level engineering discipline.** Security, architecture, and the core send/reply data-path are genuinely strong. The items rated *AT-RISK* are **forward-looking**, not current-state defects: scale headroom beyond ~100k sends/day, operational *visibility* for the newest (mostly dormant) subsystems, and *test depth* on crash/concurrency edge cases. None block production at present volume; all are the right next investments.

### Scorecard

| Dimension | Verdict | One-line |
|---|---|---|
| Architecture & maintainability | **STRONG** | Enforced boundaries, clean layering; shared type-contracts **EXCELLENT**. |
| Security & tenancy | **STRONG** | No critical vulns; mature authN/Z, SSRF, crypto, isolation. |
| Reliability & data integrity | **STRONG core / ADEQUATE overall** | Send path is at-most-once & fail-closed; gaps in edge-recovery. |
| Scale & performance | **AT-RISK at 100k+/day** | Solid indexes & pagination; specific hot-path scans need work. |
| Observability & operations | **STRONG core / AT-RISK for new features** | Great metrics/health/runbooks; new subsystems lack visibility. |
| Tests & product correctness | **Tests STRONG / correctness ADEQUATE** | Excellent tiers & gates; edge/concurrency coverage gaps. |

### Verified baseline (this audit)
`1364 unit · 208 DB · lint · module-boundary · test-tier isolation · 5/5 package typechecks` — all green on the merged head. (CI's offline-Prisma-stub build path is the one recurring fragility — see §5.)

---

## 2. Dimension summaries

### 2.1 Architecture & maintainability — STRONG
**Strengths.** Three-tier dependency direction (`apps/api → backend-core ← apps/worker`) enforced at CI by `scripts/check-boundaries.mjs`; queue processors extracted to `apps/worker/src/processors.ts` so business logic is DB-testable without BullMQ; unified error handling (`ApiError`/`asyncHandler`/`errorHandler`); boot-time-validated config (`lib/config.ts`); live, operator-driven feature flags (`lib/launchControls.ts`); **EXCELLENT** shared contracts — `packages/shared` with compile-time `Assert<Extends<>>` checks and a runtime enum-conformance test that makes frontend/backend drift impossible.
**Top gaps.** `sendCampaignBatch` is a ~530-line orchestrator (extract `validateSendEligibility`/`applyDomainPacing`/`checkSendWindow` helpers); a handful of `as any` casts (`mail.ts` ImapFlow, auth tx, worker messageId) should be justified or typed; no enforced DTO layer on responses (acknowledged trade-off); recommend adding `check:prisma-real` and a circular-dep check to the `verify` step.

### 2.2 Security & tenancy — STRONG (no critical findings)
**Strengths.** JWT with strict secret validation + rotation & reuse-detection; bcrypt cost 12; TOTP (encrypted) + step-up re-auth for sensitive mutations; explicit RBAC matrix (`lib/permissions.ts`) enforced on every mutating route; consistent workspace-scoped queries with a dedicated cross-tenant IDOR suite; AES-256-GCM at rest with a versioned keyring; API keys hashed; **DNS-rebinding-safe SSRF guard** (resolve-then-pin, full private-range coverage); ubiquitous zod validation + 1 MB body limits; layered per-IP/account/key rate limiting; **zero raw SQL** beyond a parameter-free health check; locked CSP + security headers; log redaction of token URLs in prod.
**Top gaps (all MEDIUM/LOW, mostly operational).** 5-second membership-cache window after removal; refresh-race forces re-login (documented trade-off); `requireVerifiedForMutationExcept` allow-list should be re-confirmed; `ADMIN_EMAIL` bootstrap (already step-up-gated + audited) should be removed post-bootstrap; ingest API keys are long-lived (rotate on a cadence).

### 2.3 Reliability & data integrity — STRONG core / ADEQUATE overall
**Strengths.** Claim-first outbox with `@@unique(campaignId, leadId, sequenceStep)` = at-most-once dispatch; P2002 handled everywhere; fail-closed (`FAILED`/`SENDING` never auto-resent); the SENT confirmation is one atomic transaction across outbox + lead stage + ContactEvent ledger + daily stats + intent; per-workspace advisory locks for cap reservation; expand-and-contract migrations; circuit breaker (Redis-shared, fail-open); graceful shutdown with watchdog; prior race bugs fixed with unique constraints (reply double-count; AiPromptVersion `promptHash`).
**Top gaps.** (H) `ContactEvent` FAILED write not in the same tx as the outbox `FAILED` update (best-effort) — ledger can under-count; (H) no auto stats-reconciliation if the ledger and an `OutreachSent` row diverge (manual `rebuildCampaignStats` only); (M) **stale `SENDING` rows consumed cap forever** — *addressed in this pass, §4*; (M) per-domain pacing counter is in-memory, so concurrent batches can exceed it (advisory by design); (M) mission-pause re-check is not atomic with the claim (a pause mid-loop can let one more send through).

### 2.4 Scale & performance — AT-RISK at 100k+/day
**Strengths.** Thoughtful compound indexes on the hot tables; cursor-paginated send batch (`PAGE=250`) and prospect scoring; one bulk fast-path query per page (not per-lead); advisory-locked cap reservation; short-TTL single-flight stats cache; bounded job retention.
**Top gaps.** (H) **per-domain pacing** loads *all* of today's sends into memory per batch and uses an unindexed `endsWith('@domain')` count per follow-up — the first thing to bite at 10×; (H) the **reputation guard's per-type counts lacked a supporting index** — *addressed in this pass, §4*; (M) follow-up path runs ~5 sequential contact-policy queries *per task* (batch them); (M) the dashboard score-distribution `groupBy` is unbounded; worker concurrency (2–3/queue) is conservative and will underutilize at scale.

### 2.5 Observability & operations — STRONG core / AT-RISK for new features
**Strengths.** Dependency-free Prometheus exporters (API + worker), job/queue-depth gauges, provider-call outcomes; three-tier health probes (`/live`, `/ready`, `/ready/strict`) with timeouts; structured JSON logging with per-request correlation; Sentry seam that only reports final-attempt failures; 13 runbooks + 7 SLOs + 15 alert rules with a monitoring-asset integrity check; **live, tri-state operator controls** and rich skip-reason accounting; `/api/stats/reputation` and `/api/stats/ai-prompts` endpoints.
**Top gaps.** (H) the newest subsystems — reputation guard, follow-up backlog, warmup progress, bounce/complaint spikes — have **no dedicated metrics, alerts, or runbooks**; (H) launch-control env vars were **undocumented** — *addressed in this pass, §4*; (M) the per-request `requestId` is not threaded into queue jobs, so API→worker tracing is manual; (M) no single `/api/admin/status` surfacing `launchControlsSnapshot()` + queue depths; warmup/follow-up state is not queryable per workspace.

### 2.6 Tests & product correctness — tests STRONG / correctness ADEQUATE
**Strengths.** Rigorously isolated tiers (service-free unit, real-Postgres DB, static safety gates, enum conformance) enforced by `check-test-tiers`/`check-boundaries`; 13 source-level chaos gates pin send-path invariants; deep behavioral DB coverage of suppression, idempotency, fail-closed, mission-stop, reply attribution, bounce classification, contact policy, follow-ups, reputation, RBAC, cross-tenant; a golden-spine end-to-end test of signal→…→send; multi-tier CI (unit/DB/Redis/browser/Docker/offline/Node-26).
**Top gaps.** (H) the **AI-generation-failure refund path** is only source-gated, not behaviorally tested — `generateOutreach` isn't injectable in `sendCampaignBatch`; (H) `OutreachIntent` non-happy states (`REJECTED`/`QUEUED`/`WON`/`LOST`) and "only `APPROVED` may materialize" are unguarded by tests; (H) no **stuck-`SENDING` recovery** test — *recovery now exists & is tested, §4*; (M) concurrent first-time replies (distinct uids, same lead) untested; (M) suppression isn't re-checked when a suppressed address is re-discovered into a new campaign.

---

## 3. Cross-cutting / convergent findings
Issues independently flagged by **multiple** reviewers (highest signal):

1. **Stale `SENDING` recovery** — reliability + tests + observability. *Closed in this pass.*
2. **Reputation-guard index** — scale; supports the guard that observability wants alerted. *Closed in this pass.*
3. **New-feature operability** — observability flags missing metrics/alerts/runbooks; the launch-control env vars were undocumented (*docs closed in this pass*); the rest is a focused P1.
4. **`requestId` correlation API→worker** — observability + architecture; the queue schema already carries an optional `requestId`, it just isn't populated by the producers.
5. **AI-failure behavioral coverage** — tests + reliability; needs a `generateOutreach` injection seam (mirroring the existing `sendMail` dep seam).

---

## 4. Closed in this pass (hardening landed with the audit)
Three convergent, safe, additive fixes — verified against the full gate suite:

- **`ContactEvent(workspaceId, type, occurredAt)` index** (`migration 20260622160000`) — directly backs the sender-reputation guard's per-type windowed counts (run once per send batch); the prior indexes lead with `emailKey`/`campaignId` and couldn't serve a type-only aggregation.
- **Stale-`SENDING` recovery** (`lib/staleSends.ts` → wired into the worker's maintenance sweep) — reclaims outbox rows stranded `SENDING` by a crashed dispatch (which otherwise consume the daily/monthly cap forever) by marking them `FAILED`. Fail-closed: identical to the existing crash-after-claim contract, so it can never cause a duplicate send. Threshold via `STALE_SENDING_RECOVERY_MINUTES` (default 120). DB + unit tested.
- **Launch-control env-var catalogue** (`docs/PRODUCTION_ENV_VARS.md`) — every kill-switch, safe-launch, follow-up, reputation, warmup, pacing, abuse-prevention, AI-governance, and observability variable, with defaults — so operators can actually enable/tune the dormant subsystems.

---

## 5. Prioritized roadmap (remaining)

**P0 — operability (days)**
- Add `npm run check:prisma-real` to the `verify` step. The offline-Prisma stub is hand-maintained; it has broken CI twice when new `Prisma.*` types were referenced. Either auto-generate the stub from the schema or gate it.
- Thread `requestId` (+ `userId`) from API enqueue into job payloads and worker logs (schema already supports it).

**P1 — new-subsystem visibility & safety (1–2 weeks)**
- Metrics + alerts + runbooks for: reputation enforce-blocks, follow-up queue backlog, warmup progress, bounce/complaint spikes.
- `/api/admin/status` exposing `launchControlsSnapshot()` + queue depths + dependency health; per-workspace warmup/follow-up state endpoints.
- Behavioral AI-failure test via a `generateOutreach` injection seam; `OutreachIntent` state-transition guard + tests (only `APPROVED` materializes; `REJECTED` never sends).
- Make `ContactEvent` FAILED-on-generation-failure atomic with the outbox update (or add a reconciliation job).

**P2 — scale headroom for 10×+ (2–4 weeks)**
- Per-domain pacing: persist an extracted `toEmailDomain` (indexed) or a Redis daily per-domain tally; drop the in-memory full-day load and the `endsWith` scans; move the increment under the advisory lock to make the cap hard.
- Batch the follow-up contact-policy checks; bound the dashboard score-distribution `groupBy`; revisit per-queue worker concurrency under load tests.
- Daily ledger↔outbox reconciliation job to keep `CampaignDailyStats` honest under manual edits/retention.

**P3 — refactors & polish (ongoing)**
- Decompose `sendCampaignBatch` into named pure helpers; justify/eliminate remaining `as any`; add a circular-dependency check; consider a `RetryableError` taxonomy for finer queue retry control.

---

## 6. How to read the AT-RISK ratings
Two dimensions are AT-RISK and both are about *headroom*, not present breakage:
- **Scale** is AT-RISK *at 100k+ sends/day* — at today's volumes the hot paths are fine; the named fixes buy 10–100×.
- **Observability** is AT-RISK *for the newest subsystems*, which ship **dormant by default** (`FOLLOWUPS_ENABLED` off, `REPUTATION_GUARD_MODE=observe`, warmup/pacing opt-in). The visibility work should land *before* those flags are flipped on in production — which is exactly the controlled-rollout posture the codebase already encodes.

**Bottom line:** strong, shippable foundation; the roadmap above is the path from "production-ready" to "operate-at-scale-with-confidence."
