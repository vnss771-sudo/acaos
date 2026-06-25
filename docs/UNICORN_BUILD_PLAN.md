# ACAOS — Build Plan to Unicorn Standard

**Date:** 2026-06-25
**Method:** Council of 5 — five independent principal-level audits run in parallel (Architecture & Scalability, Reliability & Operations, Security/Compliance/Trust, Product/Growth/Monetization, Code Quality/Testing/Velocity), then synthesized into a sequenced plan.
**Scope reviewed:** the full monorepo at master (post PRs #221/#224/#225 and the in-flight #226) — ~30k LOC, 37 data models, 23 API route groups, 11 web views, 178 test files.

---

## 1. Verdict

ACAOS is **past pilot-grade on engineering substance and ready for paying customers today at low-thousands scale.** The correctness, safety, and security foundations are genuinely staff-level — better than most Series-B outbound products. What stands between it and a unicorn outcome is **not soundness, it is three things:**

1. **Throughput architecture** — the send path is correct but not yet horizontally scalable (capped at ~2 concurrent campaigns platform-wide).
2. **Operability at scale** — no distributed tracing, no DLQ-replay / per-tenant drain tooling, AI-spend uninstrumented.
3. **Growth & moat surface** — the intelligence layer is a real, defensible wedge but is *latent*: zero product analytics, no CRM sync, email-only, single vertical.

Every one of these is well-scoped, mostly mechanical work on top of clean seams — not a rewrite.

### Council scorecard

| Dimension | Grade | One-line |
|---|---|---|
| Architecture & Scalability | **B+** | Cleanly-factored modular monolith; carries low-thousands of workspaces. First thing to break at scale: `send-campaign` concurrency. |
| Reliability & Operations | **A−** | Most operationally mature pilot-stage codebase the reviewer had seen — SLOs→alerts→16 runbooks→dashboard, held coherent by a CI gate. Blind spots: tracing, DLQ tooling, AI-spend alerting. |
| Security, Compliance & Trust | **A−** | Safe to hold customer data and send at scale today. Real adversarial thinking (DNS-rebind-safe SSRF, single-use TOTP, refresh-reuse family revoke). Residual risk: tenant isolation is correct-by-convention with the central guard shipped inert. |
| Product, Growth & Monetization | **B** | Full discover→score→write→send→reply→learn loop is closed and working, with a genuinely rigorous evidence-first intelligence moat. Gaps: no funnel analytics, no CRM sync, email-only, one hardcoded vertical. |
| Code Quality, Testing & Velocity | **A−** | Top-decile pre-Series-A discipline: compile-time route contracts, behavioral DB tests, governance gates that earn their keep, 0 TODO/FIXME, near-zero `any`. Drag: a few god-functions and type-unaware ESLint. |

---

## 2. Cross-cutting convergence

The signal worth acting on first is where **independent reviewers agreed without coordination:**

- **Tenant guard off → observe → enforce.** Flagged independently by **Architecture** (gap #4) *and* **Security** (gap #1) as the single highest latent risk: isolation rests on hand-written `workspaceId` filters with the central backstop shipped `mode: off`. One forgotten filter in a future route = silent cross-tenant PII leak, with nothing watching. **This is the #1 item.**
- **Serve dashboards from the read-model, not live `count()`s.** Architecture #2: `CampaignDailyStats` already exists and is reconciled, yet `campaigns.ts:/:id/stats` recomputes via 6× `count()` and `stats.ts:/campaigns` loads every contacted lead into Node.
- **Decompose `sendCampaignBatch` → unlocks the send fan-out.** Velocity #1 (god-function, ~560 lines) and Architecture #1 (throughput) are the *same* work approached from two sides: extract the per-lead eligibility pipeline, then fan out per-page jobs keyed by workspace.
- **Instrument AI spend.** Reliability #4 (runaway-cost blind spot — computed but never exported/alerted) and Product monetization (the `growth` tier is *unlimited* on shared keys — a single power user erases margin) are the same exposure from ops and business angles.
- **Distributed tracing & queue ops** (Reliability #1/#2/#3) are the MTTR story for a 24/7 on-call team.

---

## 3. The plan

Four phases. Phase 0 is days of high-leverage safety/observability ratchets I can largely execute now. Phases 1–3 are the scale, reliability, and growth build-out. Effort: **S** = <1 day, **M** = days, **L** = weeks.

### Phase 0 — Safety & observability ratchets (this week)

Cheap, high-value, mostly self-contained. Closes the latent-risk and blind-spot items before they can bite.

| # | Item | Source | Effort | Acceptance |
|---|---|---|---|---|
| 0.1 | `TENANT_GUARD_MODE=observe` in prod; inventory unscoped queries from `[tenant-guard]` warnings; confirm every route/job runs inside `runInWorkspaceContext` | Arch #4, Sec #1 | M | Observe-mode live; zero-warning baseline documented; enforce-mode ticket filed |
| 0.2 | Fence prospect-controlled fields in the LLM prompt (delimit + label `aiSummary`/`businessName`/`notes` as untrusted data) | Sec #2 | S | Injection test (prospect note = "ignore previous instructions…") produces no behavior change; POLICY_REVIEW backstop unchanged |
| 0.3 | Export `acaos_ai_cost_cents_total` + `acaos_circuit_open{provider}` from worker `/metrics`; add `AiSpendSpike` + `ProviderCircuitOpen` alert rules + dashboard panels | Rel #4/#5 | S | `check:monitoring-assets` green with new rules; panels render |
| 0.4 | Replace `isProduction()`-gated send-readiness with explicit `ENFORCE_SEND_READINESS` (default on); fail-closed for any non-dev env | Sec #3 | S | Non-prod, non-dev env cannot send without sender identity; unit test |
| 0.5 | `scripts/requeue-failed.mjs` (filter by queue + age, retry/discard) + `queue.pause()`/resume op; link from runbooks | Rel #2/#3 | M | Runbook entry; dry-run replays a seeded failed `send-campaign` job |
| 0.6 | Per-workspace `sendSuppressed` flag honored at top of `sendCampaignBatch` (drain one tenant without the global kill-switch) | Rel #3 | S | Suppressed workspace's batch no-ops; behavioral DB test |
| 0.7 | Enable `@typescript-eslint/no-floating-promises` (type-aware lint tier, gated after `prisma:generate`) | Vel #2 | M | New CI step; fails on an un-awaited prisma write; existing code clean |
| 0.8 | Promote compliance gate to launch-blocking once legal copy is signed (`COMPLIANCE_GATE_ENABLED=true`); assign sign-off owner in GO_LIVE | Sec #4 | S | Owner assigned; gate flips on legal sign-off |

### Phase 1 — Scale foundations (next 4–6 weeks)

The throughput + operability core. Ordered by dependency.

| # | Item | Source | Effort | Acceptance |
|---|---|---|---|---|
| 1.1 | **Decompose `sendCampaignBatch`** — extract pure `evaluateLeadSendEligibility()` (suppression→policy→AI-limit→pacing→window→reputation → `SendSkipReason \| 'OK'`); unit-test in isolation; add to `CRITICAL` coverage gate | Vel #1, Arch #1 | M | Function <150 lines; eligibility steps individually tested; send DB test still green |
| 1.2 | **Send fan-out** — `enqueueSendCampaign` emits one job per lead-page (chunked) keyed by workspace; raise concurrency; per-workspace fairness via BullMQ groups | Arch #1 | L | Two large workspaces no longer starve each other; throughput scales with worker replicas; exactly-once guarantees preserved (claim-first + advisory lock unchanged) |
| 1.3 | **Move AI draft generation off the send hot path** — `sendCampaignBatch` requires a prepared draft and skips (not generates) when absent; drive generation via `generate-outreach` queue ahead of send | Arch #1 | M | Send loop is pure I/O; no AI call inside the claim transaction |
| 1.4 | **Dashboards from the read-model** — rewrite `campaigns.ts:/:id/stats` + `stats.ts:/campaigns` to read `CampaignDailyStats`; delete the 6× `count()` block | Arch #2 | M | No `count()`/full-lead-load on stats paths; numbers match the ledger; reconciliation unchanged |
| 1.5 | **Distributed tracing** — propagate W3C `traceparent` from `requestContext` into the BullMQ payload; emit worker spans per job (OTel SDK or zero-dep span shim mirroring the Sentry transport) | Rel #1 | L | One send is followable API→worker→SMTP as a single trace |
| 1.6 | **Fan out mailbox/IMAP sync** — per-mailbox jobs sharded by workspace, bounded concurrency (replaces the serial `concurrency:1` loop) | Arch #5 | M | Reply-detection latency bounded independent of mailbox count |
| 1.7 | **Tenant guard → enforce** (after 0.1 burn-in) | Arch #4, Sec #1 | M | `TENANT_GUARD_MODE=enforce` in prod; cross-tenant query throws; consider Postgres RLS as the hard backstop |

### Phase 2 — Reliability & quality hardening (6–10 weeks, overlaps Phase 1)

| # | Item | Source | Effort | Acceptance |
|---|---|---|---|---|
| 2.1 | Partition `OutreachSent` + `ContactEvent` by month; switch retention from `deleteMany` to partition-drop; add a `ContactEvent` retention window | Arch #7 | L | Retention is O(drop-partition); event tables don't bloat at millions/mo |
| 2.2 | Cache sender-reputation per workspace (short-TTL Redis) + decouple the metrics domain snapshot from scrape cadence | Arch #6, Rel #9 | M | Per-batch reputation reads bounded; scrape latency flat as tenant count grows |
| 2.3 | Run one real DR drill; record measured RTO in `RECOVERY.md`; wire a "snapshot <24h old" check | Rel #7 | M | Drill executed; RTO is measured, not aspirational |
| 2.4 | `pg_trgm` GIN indexes for lead search + keyset pagination / approximate counts on the lead list | Arch #3 | M | Lead search/list no longer seq-scans at 10k-lead workspaces |
| 2.5 | Make `AuditEvent` append-only (DB grant denies UPDATE/DELETE) + mandatory await-and-alert for security-critical events; protect open-investigation windows from purge | Sec #5/#6 | M | SOC2-grade tamper-evident audit trail |
| 2.6 | Eliminate `req.user!` (115×) via typed `AuthedRequest`/`requireUser(req)`; TS project references (`tsc -b` incremental); changed-files coverage-delta gate | Vel #3/#4/#5 | M | No `!` on `req.user`; incremental typecheck; new uncovered lines fail CI |
| 2.7 | Progressive lockout/notification on N consecutive MFA failures | Sec #7 | S | Repeated TOTP failures lock + notify, not just rate-limit |

### Phase 3 — Product moat & growth engine (parallel track, 8–16 weeks)

This is what converts a strong product into a category-defining, fundable one. **Item 3.1 gates the rest — you cannot prioritize growth without it.**

| # | Item | Source | Effort | Acceptance |
|---|---|---|---|---|
| 3.1 | **Product analytics / funnel instrumentation** (event SDK; activation funnel: signup→ICP set→sender verified→first send→first reply→feature adoption) | Prod #1 (P0) | M | Activation & retention funnels live; experiments runnable; investor-grade engagement reporting |
| 3.2 | **Bi-directional CRM sync (HubSpot + Salesforce)** — contacts, activities, won/lost; doubles as a learning-loop input | Prod #2 (P0) | L | Pipeline flows to the system of record; closed-won feeds `learningLoop` |
| 3.3 | **Multichannel sequences** — extend the existing `OutreachSequenceStep`/`FollowupTask` engine to LinkedIn (partner API) + call/manual task steps | Prod #3 (P0) | L | Non-email steps run through the cadence engine with the same evidence layer |
| 3.4 | **Horizontal-ize ICP** — make scoring keyword/ICP packs fully data-driven per workspace; ship 3–5 vertical packs beyond FieldOps | Prod #4 | M | New vertical onboarded without code change |
| 3.5 | **ROI / closed-won attribution + shareable report** (campaign→reply→meeting→won) | Prod #5 | M | Renewal/expansion story: provable pipeline per campaign |
| 3.6 | **Pricing: add seats + metered overage / enterprise tier**; cap the "unlimited" `growth` tier with fair-use + discovery-COGS pass-through above a threshold | Prod #7, monetization | S | Seat-expansion revenue lever; margin protected on heavy-discovery accounts |
| 3.7 | **Public API + outbound webhooks** (reply received, meeting booked) + scoped API keys | Prod #6 | M | Zapier/automation + ecosystem embeddability |
| 3.8 | Native scheduling / meeting-booking on "interested" replies, feeding the WON loop | Prod #8 | M | Inbox "interested" → booking → attribution closes the conversion moment |

---

## 4. Sequencing

```
Week:        1   2   3   4   5   6   7   8   9  10  11  12 ...
Phase 0  ████                                              (safety/observability ratchets)
Phase 1      ██████████████████                            (1.1→1.2/1.3, 1.4, 1.5, 1.6, then 1.7)
Phase 2              ████████████████████                  (overlaps; hardening)
Phase 3      ░░░░3.1░░░░██████ CRM / multichannel ███████   (3.1 first, then the big builds)
```

- **Phase 0 ships first and fast** — it's the safety net under everything else.
- **1.1 (decompose) precedes 1.2/1.3 (fan-out)** — same code, must refactor before scaling.
- **0.1 (observe) precedes 1.7 (enforce)** — burn-in required.
- **3.1 (analytics) precedes all other Phase-3 prioritization** — instrument before you optimize.

## 5. Non-goals (don't do these now)

- **No microservice split.** The modular monolith is the right call; the seams are clean enough that `send`/`discovery` *can* split later as a packaging change. Splitting now adds ops cost for no benefit.
- **No rewrite of the send path.** Its correctness is the crown jewel — fan-out is *around* it (job topology), not *through* it. Preserve claim-first + advisory-lock exactly.
- **No new AI provider abstraction churn** — `providerClient.ts` is already a clean seam.
- **Don't replace the governance gates with "real" tooling** — they earn their keep; add the type-aware lint tier *alongside* them.

## 6. Success metrics

| Metric | Today | Target |
|---|---|---|
| Concurrent send throughput | ~2 campaigns platform-wide | Scales linearly with worker replicas; per-workspace fairness |
| MTTR for a cross-service send failure | log-grep a `requestId` | One distributed trace, < minutes |
| Cross-tenant isolation | correct-by-convention, unwatched | `enforce` mode + RLS backstop; provably zero unscoped queries |
| AI-spend runaway detection | discovered on the invoice | alerted within minutes |
| Activation funnel visibility | none | full signup→first-reply funnel instrumented |
| Switching cost | email silo | CRM-embedded + compounding learning dataset |
| Gross margin risk | unlimited tier on shared keys | fair-use cap + metered overage |

---

*Generated by the Council of 5 audit. Every claim above is backed by a `file:line` citation in the individual seat reports; this document is the synthesis and sequencing layer.*
