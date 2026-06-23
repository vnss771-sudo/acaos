# ACAOS — Paying-Customer Readiness Review & Build Plan
**Date:** 2026-06-23 · **Method:** Council of 5 (Architecture, Security, Reliability/SRE, Product/Billing, Data/AI) — parallel evidence-based audit against `HEAD`, with the lead engineer verifying the highest-stakes findings firsthand.
**Scope question:** *Is ACAOS SaaS-quality and ready for paying customers?*

---

## 1. Verdict (the headline)

**Ready for a small, operator-supervised paid pilot — NOT yet for self-serve scale or broad GA.**

This is a genuinely well-built codebase: the *machinery to charge money is real and correct* (Stripe end-to-end, signature-verified idempotent webhooks, advisory-lock quota enforcement, RBAC, kill-switches), the core product loop works and is tested, and engineering discipline (typed route contracts, enforced module boundaries, three-tier tests, governance gates, zero TODO/`@ts-ignore` debt markers) is well above typical early-stage SaaS.

But "can take money" ≠ "should take money at scale today." Several things stand between the current state and *confident* paid GA, and none are cosmetic — two are trivially fixable but currently real:

1. **A real CAN-SPAM/CASL compliance gap** in follow-up emails (verified firsthand).
2. **Error reporting is a silent no-op** — `@sentry/node` is in no `package.json` and not installed, so `captureError()` never fires (verified). Combined with placeholder external probe targets, you would operate a paid service partially blind.
3. **The bulk-send path skips the block-severity tone guard** — on-the-fly campaign generation can ship the "creepy" copy the queue path blocks (verified). One import to fix.
4. **No specified, tested backup/restore or transactional tenant deletion** — unacceptable for paid data custody + GDPR erasure.
5. **The cross-tenant safety backstop is off by default** — isolation is correct-by-convention, with no net beneath it.
6. **Unbounded PII to OpenAI with no DPA surface**, and AI spend bounded by call-count not dollars (with bypasses).

The repo's own README is honest ("controlled paid beta candidate. Not yet ready for broad public launch"). The prior in-repo audit (`ENGINEERING_AUDIT_2026-06-22.md`) graded itself **"production-ready for current scale"** — the council's evidence says that is **optimistic**; several of its "closed" items are real but its scorecard understates live compliance and operational gaps. See §6.

**Bottom line:** With a focused **Phase 0 (~1–2 weeks)** you can confidently run a hand-held paid pilot (US-only, sequences-after-fix). **Phase 1 (~3–5 weeks)** gets you to bounded paid GA. Self-serve scale and "unicorn standard" is **Phase 2–3**.

---

## 2. Readiness scorecard

| Dimension | Score | One-line |
|---|---|---|
| Architecture & Code Quality | **7.5 / 10** | Strong bones; god-components, half the route contracts lack compile-time guards, send logic duplicated. |
| Security, Privacy & Compliance | **7.5 / 10** | Solid auth/crypto/suppression; tenant-guard off by default, TOTP replay window, cold-email compliance gaps. |
| Reliability, Scale & Operations | **6.5 / 10** | Excellent resilience primitives; observability not externally wired, backups unspecified, dead code in send path. |
| Product, Billing & Monetization | **7.5 / 10** | Billing is **REAL** and well-built; funnel has gaps (no in-product DPA/consent, manual offboarding). |
| Data & AI Quality | **6.5 / 10** | Good guardrails & metering; PII to OpenAI unbounded, research ignores ICP, learning loop dormant, no cost attribution. |
| **Overall** | **≈ 7.0 / 10** | **Pilot-ready, GA-soon. Not scale-ready.** |

---

## 3. What is genuinely strong (credit where due)

- **Billing is real, not a demo.** Stripe v16, `createCheckoutSession`/portal, webhook signature verification with raw-body wiring before `express.json`, idempotency via `ProcessedStripeEvent` PK with claim-release on failure, dunning on `invoice.payment_failed`, and **lapsed-subscription → `free` downgrade** so a cancelled card can't retain paid limits. (`apps/api/src/services/stripe.ts`, `routes/billing.ts`, `lib/limits.ts`.)
- **Quota enforcement is race-safe.** Every mutable quota (AI calls, discovery, lead capacity, daily send slot) uses `pg_advisory_xact_lock` inside a transaction. (`lib/limits.ts:54–190`.)
- **Send safety is layered & fail-closed.** Claim-before-send outbox with `@@unique([campaignId, leadId, sequenceStep])`, stale-SENDING recovery (→FAILED, never re-sent), suppression checked before dispatch, RFC 8058 one-click unsubscribe, reputation guard, send windows, per-domain pacing now indexed (`toEmailDomain`).
- **Cross-process circuit breakers** (Redis-synced, throttled) with retry backoff intentionally outlasting the reset window. (`lib/circuit.ts`, `queues.ts:52`.)
- **Operator blast-radius controls:** live env kill-switches (`FEATURE_AI/SEND/MAILBOX_SYNC/DISCOVERY`), `SAFE_LAUNCH_MODE` (forces approval + clamps daily cap), followups/reputation default to safe. (`lib/launchControls.ts`.)
- **Engineering hygiene:** typed route-contract system (frontend drift = compile error), enforced tier/boundary/coverage gates, SHA-pinned CI actions, schema-drift gate, structured logging with `requestId` propagated API→queue→worker.

This is the foundation that makes the gaps below *fixable in weeks, not quarters*.

---

## 4. Cross-cutting blockers (triangulated — fix before/at paid pilot)

These rose independently from multiple seats; that convergence is why they lead.

### B1 — [P1, legal] Follow-up emails omit the CAN-SPAM/CASL physical address *(verified firsthand)*
The initial-send footer appends sender business name + postal address (`processors.ts:745–748`); the follow-up footer (`processors.ts:913`) ends at the unsubscribe link with **no sender identity block**. CAN-SPAM §5(a)(5) and CASL §6(2) require a physical postal address in *every* commercial message. Flagged by Security, Architecture, and Data/AI seats independently.
**Mitigant:** follow-ups are dormant by default (`FOLLOWUPS_ENABLED=false`), so this only bites once sequences are enabled.
**Fix (S):** fetch `senderBusinessName`/`senderPostalAddress` in `sendFollowupTask` and reuse the `senderLine`; extract a shared `buildEmailFooter()` + shared `escapeHtml` into `backend-core` (the two inline `escHtml` copies also diverge from `api/lib/html.ts`, a latent injection inconsistency). **Gate:** do not enable sequences for any paying customer until merged.

### B2 — [P0/P1, ops] You would operate partially blind: error reporting is a silent no-op, and observability is wired in-cluster but not externally
**[P0] `@sentry/node` is not a dependency in *any* `package.json` and is not in `node_modules` *(verified firsthand)*.** `errorReporting.ts` loads it via `await import('@sentry/node')`, which therefore *always* fails — `captureError()` is a permanent no-op even when `SENTRY_DSN` is set. The capture seam is correctly wired into `server.ts` and `worker.ts`, but nothing receives the events: every unhandled exception and final-attempt job failure is swallowed. **Fix (S, ~30 min):** add `@sentry/node` to the api+worker workspaces and set `SENTRY_DSN`.
**[P1] Metrics/SLOs partly unwired.** In-cluster scrape targets are real (`acaos-api:4000`), but external blackbox/uptime probes are committed placeholders (`https://api.example.com`, `https://app.example.com` in `ops/monitoring/prometheus.yml:45–71`). `/metrics` 404s silently without `METRICS_TOKEN`. Metrics are in-memory per-process (reset on deploy, not aggregated across replicas). The documented send-backlog SLO (`docs/SLO.md`) has **no corresponding alert rule**. `discover-prospects` is absent from `WORKER_QUEUES` (`worker.ts:541`) so discovery jobs emit no metrics and no error capture — a one-line fix.
**Fix (M):** install Sentry (above); set real probe targets; make `/metrics` misconfig loud; add queue-depth/backlog alert rules matching the SLOs; register `discoverWorker` in `WORKER_QUEUES`.

### B3 — [P1, data] No specified/tested backup-restore; tenant deletion is manual & non-atomic; Railway `--accept-data-loss` still flagged
`GO_LIVE_CHECKLIST.md` lists "automated backups on" as a bare checkbox — no provider, retention, PITR window, or **tested restore**. Workspace deletion is an operator script (`DATA_RETENTION.md:44–49`), so GDPR Art. 17 erasure isn't a single transaction. `MIGRATIONS.md` still warns Railway's default start runs `prisma db push --accept-data-loss` (can silently drop columns) and relies on operators changing it manually.
**Fix (M):** document + **test** a restore; ship transactional `DELETE /api/workspaces/:id` (owner + step-up); verify the prod start command is `start-with-migrations.mjs`, not `db push`.

### B4 — [P1, security] Cross-tenant guard is off by default
Isolation today is correct-by-convention per-route (`userBelongsToWorkspace`/role asserts, consistently applied) — but `TENANT_GUARD_MODE` defaults `off`, so the Prisma backstop that catches a *missed* check is inert. One future un-scoped query = silent cross-tenant leak.
**Fix (S, ops→code):** set `TENANT_GUARD_MODE=observe` in prod now (zero behavior change, emits warnings), burn down false positives, graduate to `enforce`.

### B5 — [P1, privacy] Unbounded PII flows to OpenAI; no cost-per-lead attribution
`lead.notes` (free-text, possibly emails/phones) is sent verbatim and untruncated to OpenAI (`services/openai.ts:152`, `worker.ts:80–86`); the research worker also ignores `WorkspaceICP`, so non-field-service workspaces get wrong-vertical prompts. Separately, AI spend is metered for *quota* but never attributed as *dollar cost* per lead/campaign, and `OPENAI_MAX_TOKENS_*`/`OPENAI_MODEL` are unvalidated env (`openai.ts:18,53–57`).
**Fix (S–M):** truncate/sanitize `notes` before prompting; pass workspace ICP into research; clamp max-tokens and allow-list the model; surface DPA/sub-processor disclosure (OpenAI) in onboarding/T&Cs.

### B6 — [P0, safety] The bulk-send path skips the block-severity tone guard *(verified firsthand)*
`assertOutreachTone` *throws* `OutreachToneError` on presumptuous "I know you're struggling"-class copy (`outreachTone.ts:63–68`). The `generate-outreach` queue path calls it (`worker.ts:220`), so pre-vetted drafts are protected — **but the on-the-fly generation inside `sendCampaignBatch` does not** (`processors.ts:708–709` runs `checkDraftPolicy` + `checkClaimGrounding` only; `assertOutreachTone` is never imported). A campaign that generates drafts at send time can therefore ship exactly the copy the queue path blocks — and that's the highest-volume path.
**Fix (S):** import and call `assertOutreachTone(parsed)` in `processors.ts` between `parseAiJson` and `checkDraftPolicy`, mirroring `worker.ts:220`. Pure, synchronous, zero infra change. Also tighten the two narrow guards (B-level findings) so variants ("your crews are clearly losing jobs") are caught.

### B7 — [P1, cost] AI spend is bounded by quota count, not dollars — and has bypasses
`growth` plan is `aiCallsPerMonth: Infinity` (`limits.ts:18`), so one abusive growth seat can run OpenAI spend unbounded; metering is enforced at the API route but the **worker re-checks nothing**, so any direct BullMQ enqueue bypasses the quota entirely; and the eval harness that would catch prompt-quality regressions **never runs in CI** (no `OPENAI_API_KEY`, scripts `exit(0)`). 
**Fix (M):** add a configurable hard ceiling + 80/100% usage alert even on `growth`; add a read-only quota re-check inside each AI worker processor (defense-in-depth); wire `eval-*` into CI behind a spend-limited key (or scheduled run).

---

## 5. Findings by dimension (condensed; full evidence in council transcripts)

### Architecture & Code Quality — 7.5
- **[P1]** ~Half of body-typed route contracts lack `Assert<Extends<>>` compile guards; `sendCampaignSchema.approved` is `z.unknown().optional()` while the contract says `boolean` — the exact class of drift the pattern exists to prevent. (`shared/src/index.ts:345–415`, `campaigns.ts:64`.) **M**
- **[P2]** `Settings.tsx` is a 930-line / 27-`useState` god-component; `Leads.tsx` similar. Extract per-section components. **M**
- **[P2]** `researchWorker`/`outreachWorker` embed business logic inline in `worker.ts` (Redis-bound, not unit-testable) while `sendCampaignBatch`/`calibrateScoring` were correctly extracted to `processors.ts`. Follow the established `deps` injection pattern. **M**
- **[P2]** 25 re-export shim files in `apps/api/src/lib/` create dual import paths; `check-boundaries.mjs` doesn't catch route→stub imports. **M**
- **[P3]** `no-explicit-any` globally disabled (only ~10 real uses — re-enable as warn). `validate.ts`/`validation.ts` name collision. `sendCampaignBatch` 539 lines.

### Security, Privacy & Compliance — 7.5
- **[P1]** TOTP has no used-code dedup → ~90s replay window. Add a per-user last-counter column. (`lib/totp.ts:85–95`.) **M**
- **[P1]** `EMAIL_ENCRYPTION_KEY` falls back to **all-zero key** when `NODE_ENV!=production` and unset — a mis-set staging env encrypts SMTP creds/TOTP under a known key. Throw instead of warn outside dev/test. (`lib/encrypt.ts:29–33`.) **S**
- **[P2]** Rate limits are IP-keyed for AI/mail; add a per-workspace tier (the shared OpenAI key is the asset at risk). `ADMIN_EMAIL` bootstrap stays an escalation vector if not removed — add a startup warning. **S–M**
- **[P3]** Pin JWT `algorithms:['HS256']` in verify; audit log is best-effort fire-and-forget (gaps under DB pressure); web CSP keeps `style-src 'unsafe-inline'`.
- **Compliance:** unsubscribe + suppression are compliant and honored pre-send; initial-send physical address compliant. **Gaps:** B1 (follow-ups), no in-product GDPR legitimate-interest/CASL consent capture, no DPA surface, manual erasure (B3).

### Reliability, Scale & Operations — 6.5
- **[P0]** `@sentry/node` not installed (B2) — error reporting silently disabled in prod. **S**
- **[P0/P1]** `sendDecision.ts::canSendOutreach` (14 eligibility checks) has **zero callers, zero tests** *(verified)* — the live logic is duplicated inline in `processors.ts`, unverified to match. Delete or wire+test. **S–M**
- **[P1]** B2 observability gaps (placeholder probes, in-memory metrics, uninstrumented SLOs, `discover-prospects` dark). No DLQ processor (failed jobs sit in BullMQ failed set, no auto-drain/alert beyond a >50/1h rule). **M**
- **[P1]** SMTP transport created per-send (`mail.ts:279`, no `pool:true`) — new TCP+TLS per email will hit ESP connection limits at volume. **S**
- **[P1]** Rate limiter falls back to per-pod in-memory map on Redis outage — at multi-replica, auth limits multiply by replica count exactly when protection matters most. **M**
- **[P2]** Prisma `connection_limit` unset in code (relies on operators editing `DATABASE_URL`); `ingestCache` 5-min per-pod staleness delays plan/API-key revocation propagation; worker concurrency static (no queue-depth autoscale). **M**
- **[P2]** Coverage gate is *reference-based*, and the "chaos/safety-gate" tests are **static source string-matching**, not behavioral — they survive logic bugs. **M**
- No canary/blue-green; post-deploy smoke isn't auto-triggered by release. **S–M**

### Product, Billing & Monetization — 7.5 · Billing verdict: **REAL**
- **[P1]** Funnel gaps for paid GA: no in-product consent/DPA capture (B5/compliance), manual non-atomic offboarding (B3), no self-serve seat management surfaced.
- **[P2]** A missing `STRIPE_PRICE_*` env silently leaves a paid customer on the wrong tier (handler preserves existing plan rather than failing loud) — add a startup assertion that configured plans resolve to prices.
- **[P2]** `free`=15 AI calls/mo may be too thin to demonstrate value pre-paywall; revisit trial design. Plan features list "Multiple workspaces/Team members" under growth — verify enforced, not just displayed.
- Onboarding wizard + example-seed flow exists and is E2E-tested (`e2e/onboarding-seed.spec.ts`).

### Data & AI Quality — 6.5
- **[P0]** B6 — `sendCampaignBatch` inline generation skips `assertOutreachTone` (block guard) *(verified)*. **S**
- **[P1]** B5 (PII to OpenAI, ICP-less research, unbounded cost knobs) + B7 (growth=∞ spend, worker metering bypass, evals not in CI).
- **[P2]** Other guards are bypassable: `outreachTone` presumptuous-phrase regex is narrow (misses "your crews are clearly losing jobs"); `recommendationPolicy` only evidence-gates priority ≥70 (a 68 "warm" rec needs no evidence); a `confirmed` evidence item can carry a structurally-valid but fabricated URL; `parseLeadResearchJson` is silently lenient (empty research → generic hallucinated outreach). Tighten patterns; gate evidence at WARM; downgrade empty research to `manual_review_then_draft`. **M**
- **[P2]** Learning loop is a **no-op under 10 WON/LOST outcomes** (most small workspaces never qualify); `ScoringOutcome` reply data is collected but never read by `calibrate()` (orphaned stream); no recency weighting. Set expectations + wire the orphaned signal. **M**
- **[P2]** `scoring.ts` `size` is a fixed 0.65 constant contributing ~11.7 pts to every lead — score rationale is partly opaque. **S–M**
- **[P3]** `OutreachDraftOutputSchema.email` caps at 8000 chars (~13× the ~90-word target); eval scripts are real but their fabrication checks are pattern-narrow and don't cross-check `confirmed` URLs against provided inputs.

---

## 6. Doc honesty audit (where the repo's own docs drift from code)

The docs are unusually candid, but several claims are stale or optimistic:
- **`ENGINEERING_AUDIT_2026-06-22.md` verdict "production-ready"** overstates: live CAN-SPAM follow-up gap (B1), externally-unwired observability (B2), and unspecified backups (B3) are launch-relevant and not reflected in its scorecard.
- That audit's **scale finding** (per-domain pacing loads all sends/unindexed `endsWith`) was **fixed the same day** by migration `…_outreach_to_email_domain` — roadmap still lists it as open (now stale-closed). Its **"generateOutreach not injectable"** claim is also stale — the `deps` seam now exists (`processors.ts:303`).
- **`SECURITY_ASVS_MATRIX.md`**: "tenant isolation on every route ✅" should be 🟡 — the systemic backstop is off (B4). MFA ✅ should be 🟡 (TOTP replay).
- **`OPERATIONS.md`**: says Redis-on-readiness is "non-fatal" — in production `/api/ready` *fails* on Redis down (`server.ts:129`), pulling the pod from rotation. Operators could mis-assess a Redis blip.
- **`COMPREHENSIVE_ANALYSIS_2026-06-19.md`** file/exemption counts are ~35% stale (215 source files now, 2 mutation-exemptions not 1).

**Recommendation:** treat this document as the current source of truth and supersede the "production-ready" framing with "pilot-ready."

---

## 7. The build plan to "unicorn standard"

Phased, with hard exit criteria. Effort tags: **S**≈≤1d, **M**≈2–5d, **L**≈1–2wk. Each item lands behind the existing verify gates (lint, typecheck-real-client, unit/db/redis/web, offline build, no-drift).

### Phase 0 — Pilot blockers (target ~1–2 weeks) → *confident hand-held paid pilot*
| # | Item | Why | Effort |
|---|---|---|---|
| 0.1 | **B1** Shared `buildEmailFooter()` + `escapeHtml` in backend-core; follow-up footer includes sender address | Legal (CAN-SPAM/CASL) | S |
| 0.2 | **B6** Call `assertOutreachTone` in `sendCampaignBatch` inline generation; tighten the narrow patterns | Brand/safety on highest-volume path | S |
| 0.3 | **B2a** Install `@sentry/node` (api+worker) + set `SENTRY_DSN`; register `discoverWorker` in `WORKER_QUEUES` | Stop swallowing errors | S |
| 0.4 | **B4** `TENANT_GUARD_MODE=observe` in prod; triage false positives | Breach backstop | S |
| 0.5 | **B2b** Real Prometheus probe targets; `/metrics` misconfig loud (not silent 404) | Operate with eyes open | S–M |
| 0.6 | **B3a** Verify prod start = `start-with-migrations.mjs`; document + **run a restore drill** | Data custody | M |
| 0.7 | **B5a** Truncate/sanitize `lead.notes` + reply body before OpenAI; clamp `OPENAI_MAX_TOKENS_*`; allow-list `OPENAI_MODEL` | Privacy + cost | S |
| 0.8 | **Decommission `sendDecision.ts`** (delete) or wire+test it | Dead code in send path | S |
| 0.9 | Stripe startup assertion: every configured plan resolves to a price | Avoid wrong-tier paid users | S |
| 0.10 | SMTP transporter pooling (cache per workspace, `pool:true`) | Avoid ESP connection-limit failures at volume | S |

**Exit:** sequences safe to enable; tone guard on every send path; errors actually captured; cross-tenant alerting on; external uptime live; restore proven; no untruncated PII to OpenAI; no zombie in the send path.

> **Note (P0 count):** Phase 0 now closes **4 verified P0s** — B1 (legal), B2a Sentry no-op, B6 tone bypass, and the `sendDecision.ts` zombie — plus the highest-leverage P1s. All four P0s are **S-effort**; they are dangerous because they're *latent*, not because they're hard.

### Phase 1 — Bounded paid GA (target ~3–5 weeks) → *self-serve for a defined segment (US, no-EU-until-DPA)*
| # | Item | Effort |
|---|---|---|
| 1.1 | Transactional `DELETE /api/workspaces/:id` (owner + step-up) — GDPR erasure (B3b) | M |
| 1.2 | TOTP used-code dedup; harden `EMAIL_ENCRYPTION_KEY` zero-key fallback to throw | S–M |
| 1.3 | Per-workspace rate-limit tier on AI/mail; `ADMIN_EMAIL`-still-set startup warning | S–M |
| 1.4 | Complete `Assert<Extends<>>` coverage; fix `sendCampaign.approved` schema | M |
| 1.5 | Queue-depth/backlog alert rules matching `SLO.md`; DLQ inspection runbook + drain script | M |
| 1.6 | Pass `WorkspaceICP` into research; tighten tone/evidence guards (gate at WARM) | M |
| 1.7 | Cost-per-lead/campaign attribution (dollarize metered AI usage) | M |
| 1.8 | In-product DPA/sub-processor disclosure + (for EU) legitimate-interest/CASL consent capture | M |

**Exit:** erasure is one transaction; AI spend is attributable + bounded; SLOs alert; compliance posture documented in-product; route contracts fully guarded.

### Phase 2 — Scale & self-serve (target ~6–10 weeks) → *grow without operator babysitting*
- Aggregate metrics across replicas (push-gateway or per-replica scrape + recording rules); distributed tracing (OTel) across API→queue→worker.
- Pin/enforce Prisma `connection_limit` + PgBouncer sizing; cache-invalidation for `ingestCache` (plan/key revocation propagates immediately).
- Queue-depth-adaptive worker concurrency / autoscaling; DLQ processor with auto-retry policy.
- Convert static "chaos/safety" string tests to behavioral tests; make the coverage gate line/branch-based on safety-critical modules.
- Canary/blue-green deploy with automatic rollback on burn-rate; auto-trigger post-deploy smoke from release.
- Extract `Settings.tsx`/`Leads.tsx` god-components; remove the 25 re-export shims; split `sendCampaignBatch` into named, tested steps.

### Phase 3 — Unicorn polish (continuous)
- Learning loop that earns its name: lower/explain `MIN_OUTCOMES`, wire the orphaned `ScoringOutcome` reply signal, add recency weighting, expose model lift in the eval harness as a CI quality gate.
- Replace the constant `size` scoring dimension with enrichment-derived data; explainable scoring surfaced to users.
- Deliverability program: warmup automation, per-domain reputation dashboards, bounce/complaint feedback loops feeding suppression.
- SOC2 track: formalize audit-log durability (DLQ), key rotation runbook execution, access reviews.

---

## 8. How to use this

- **Decision:** green-light a **supervised paid pilot after Phase 0** (≈1–2 wks). Hold broad/self-serve GA until Phase 1.
- **Guardrails already in your favor:** `SAFE_LAUNCH_MODE` (approval-forced, cap-clamped) + `FOLLOWUPS_ENABLED=false` mean you can onboard the first paying customers safely *today* in approval-only, single-touch mode while Phase 0 lands.
- **Sequencing tip:** 0.1, 0.2, 0.3 are independent and parallelizable; 0.4 needs an ops/staging window.

*Prepared by the lead engineer with a 5-seat specialist council. Highest-stakes findings (B1, the `sendDecision.ts` zombie, Prometheus targets, feature defaults) were verified firsthand against `HEAD`.*
