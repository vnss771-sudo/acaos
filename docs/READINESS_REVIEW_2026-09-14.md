# ACAOS — Public-Launch Master Build Plan
**Date:** 2026-09-14 · **Method:** Council of 5 (Architecture, Security, Reliability/SRE, Product/UX-across-every-page, Data/AI) — five parallel agents, each independently reading the actual code and, for the UX seat, actually driving the running app in a browser and screenshotting all 26 states. The lead engineer read all five full reports, spot-verified the highest-stakes UX claims against the screenshots directly, and wrote this synthesis. Supersedes `docs/READINESS_REVIEW_2026-06-23.md` as the current source of truth — that review's Phase 0 is now almost entirely closed (tracked in §2).

---

## 1. Verdict

**Same bottom line as June, one tier up: ready for a supervised paid pilot today; the fastest path to a broad public launch is no longer scattered security/reliability gaps — it is a first-impression problem.** The backend has meaningfully hardened since June (four more P0s closed, a fifth-module's worth of new surface shipped to the same standard, 2,107 tests re-run live against real Postgres/Redis with zero failures). But a person's *actual* first five minutes with this product — the investor demo built specifically to create a first impression — currently crashes on a third of the core pages, and the two most important business nouns in the app ("Lead" and "Prospect") are never explained to each other. Neither is a redesign. Both are mechanical, well-scoped fixes. Fix them first.

## 2. Scorecard

| Dimension | June 23 | Now | Why |
|---|---|---|---|
| Architecture & Code Quality | 7.5/10 | **8/10** | Two more P0/P1s closed (typed-contract guard, dead-code zombie); Ops module shipped to the same high bar but with 0% compile-guard coverage on its own 17 endpoints — the gap moved, didn't shrink. |
| Security, Privacy & Compliance | 7.5/10 | **8.5/10** | Five of six named P1s closed and verified; the one genuinely new gap (Ops clock-in identity binding) is real but narrow — payroll-integrity, not a breach. |
| Reliability, Scale & Operations | 6.5/10 | **8/10** | All four SRE-domain P0s closed; live-verified 2,107 tests, 0 failures. Remaining gaps are correctly-scoped Phase 1/2 hardening (DLQ tooling, autoscaling), not launch blockers — modulo the GitHub Actions billing outage, which is an account setting, not a code state. |
| Product / UX — every page | *(not scored in June)* | **5.5/10** | The daily-use loop (Dashboard→Leads→Campaigns→Approvals→Inbox) is genuinely well-designed. But 4 of 12 core pages hard-crash in the product's own demo mode, the flagship Leads list shows 0 rows while Dashboard boasts 248 in the same session, and two structurally-similar core entities (Lead/Prospect) are never distinguished anywhere in the UI. |
| Data & AI Quality | 6.5/10 | **7.5/10** | Real fixes (tone guard, PII truncation, ICP-aware research, thin-research fallback) all verified. AI spend metering is the one still-dangerous gap: 3 of 4 AI-calling worker paths have zero server-side quota re-check, and `growth` has no ceiling to check against even if they did. |
| **Overall** | ≈7.0/10 | **≈7.6/10** | Pilot-ready, meaningfully closer to GA. The single highest-leverage remaining item is not a backend fix — it's making the product's own showcase mode actually show the product. |

---

## 3. What's already closed since June (do not re-litigate)

Verified firsthand by at least one council seat this round, several by two independently:

- **B1** Follow-up email footer now includes sender postal address (CAN-SPAM/CASL).
- **B2a** Sentry error aggregation works — via a deliberate custom HTTP transport, not `@sentry/node` (docs were stale, now corrected).
- **B4** `TENANT_GUARD_MODE` defaults to `observe`; all 5 new Ops models registered in the guard's `TENANT_MODELS`.
- **B6** Bulk-send tone-guard bypass closed — `assertOutreachTone` now runs on the on-the-fly generation path, not just the queue path.
- **Zombie code** `sendDecision.ts` deleted; documented in the coverage-gate script itself.
- **TOTP replay** A `totpLastUsedStep` column + atomic `consumeTotpCode()` closes the ~90s replay window; DB-integration-tested.
- **`EMAIL_ENCRYPTION_KEY`** Throws for any explicit deployed `NODE_ENV`; only unset/dev/test permit the insecure fallback, with a warning even then.
- **PII to OpenAI** `clampNotes()` truncates/sanitizes `lead.notes` before every prompt.
- **ICP-aware research** Both AI workers now fetch and use `WorkspaceICP`.
- **Thin-research fallback** Degenerate research output now force-downgrades to `manual_review_then_draft` instead of silently hallucinating outreach.
- **SMTP pooling**, **`discover-prospects` queue registration**, **Ops retention sweep**, **ingest API-key cache eviction on rotate** — all confirmed real and live-tested.
- **Local `npm run verify`** Was silently breaking its own final `build` step due to a test-isolation bug (fixed this session, two clean full runs since).
- **`sendCampaignSchema.approved`** Now a real typed, compile-guarded boolean, not `z.unknown()`.

The one item from June's "confirmed closed" list that needs an asterisk: **Stripe plan/price assertion is presence-only** — it checks the env var is non-empty, not that it resolves to a real, correct-tier Stripe price. See P1-8 below.

---

## 4. Phase 0 — Fix before anyone else sees it (target: days, not weeks)

These are the items where the cost of shipping today measurably exceeds the cost of fixing first. Ordered by leverage, not by seat.

**Status: all six closed as of 2026-09-14.** Verification for each: typecheck (shared/backend-core/api/web/worker) + lint + full unit suite (1573 tests) + full DB-tier suite against real Postgres (315 tests) all green; UI-affecting items also verified live in a browser. See commits `082503d`/`5dc4670` (0.1, 0.5), `6f5b2e5` (0.3, 0.6), `0ac6f14` (0.2), `22699a6` (0.4) on `claude/run-comparison-oz9ccj`.

| # | Item | Evidence | Effort | Status |
|---|---|---|---|---|
| **0.1** | **Investor-demo mode crashes 4 of 12 core pages** (Analytics, Missions, Billing, Settings) to a generic "Something went wrong," and the flagship Leads page shows 0 rows in the same session Dashboard shows 248. Root cause: `demoApi.ts`'s catch-all fixture returns a shapeless object; `Intelligence.tsx:395`, `Missions.tsx:110`, `Billing.tsx:165`, `CompliancePanel.tsx:67` destructure it with no guard, and `/api/leads?` has no seeded handler at all. One shared top-level `ErrorBoundary` (`App.tsx`) means one broken panel blanks the *entire* page — Settings loses Profile/Password/MFA/Team/ICP/API-keys too, none of which are actually broken. | Verified visually — screenshots `settings.png`, `leads.png` confirm the exact crash text and the 0-vs-248 discrepancy. | S–M | ✅ Done — fixtures seeded, defensive optional-chaining added at each crash site, and a reusable scoped `ErrorBoundary` extracted so a future failure degrades locally instead of blanking the page. |
| **0.2** | **AI spend has a real unbounded-cost exposure**: `research-lead`, `generate-outreach`, and `analyze-reply` worker handlers have zero server-side quota re-check (only `sendCampaignBatch` defends itself), and `growth` plan has `aiCallsPerMonth: Infinity` — so even a re-check has nothing to check against on that tier. Any direct BullMQ enqueue (an internal bug, a leaked producer credential) bypasses metering entirely. | `apps/worker/src/worker.ts:71-321`; `packages/backend-core/src/lib/limits.ts:21`. | S–M | ✅ Done — all three worker handlers now re-check via a new read-only `assertAiUsageAllowed` right before their model call (no double-counting against the enqueue-time check); the one truly-unmetered path (inbound-reply auto-analysis in `services/mail.ts`) now meters before enqueueing; a dollar-based hard ceiling (`AI_SPEND_CEILING_CENTS_<PLAN>`) now applies to every plan including `growth`. |
| **0.3** | **Ops clock in/out has no identity binding** — any workspace member can clock any crew member in/out, at any GPS coordinate, with no geofence check despite `radiusMeters` existing on the schema. Framed in code comments as "self-service" but the data model can't enforce that. Payroll/timesheet-integrity risk, not a cross-tenant leak. | `apps/api/src/routes/ops/clock.ts:36-101`; `OpsCrewMember` has no `userId` column. | M | ✅ Done — `OpsCrewMember.userId` (nullable) links a crew member to the account they ARE; clock in/out requires the caller be that account or hold `ops:manage` (recorded as a distinct `.supervisor` audit event); a haversine geofence check now rejects a clock-in/out outside the job site's configured radius, advisory-only when GPS isn't configured on either side. |
| **0.4** | **Two structurally-similar core entities, "Lead" and "Prospect," are never distinguished for the user anywhere** — same shape (company, contact, score, tier, stage), no visible relationship, no "convert to Lead" action, no explanation on either page or in onboarding of which to use first. | `Leads.tsx` vs `Prospects.tsx`, both read in full; `lib/hubs.ts` already groups them under one future "Prospects" hub behind a flag — see 4.6. | M | ✅ Done (scoped fix, not the Phase 1 hub-nav IA change) — a real `POST /api/prospects/:id/convert-to-lead` creates and 1:1-links a Lead from a Prospect's fields; a "Convert to Lead" action + status badge in the prospect detail panel; both pages carry a one-line inline explanation of what the entity is and where to go next. The hub-nav flip in 4.6/8 remains the recommended larger fix. |
| **0.5** | **`Prospects.tsx`'s header toolbar overflows the viewport at normal desktop width** — no `flexWrap`, unlike the identical pattern on `Leads.tsx:638` which does wrap. The "+ Add Prospect" button and part of the Win Prob column render off-screen. | Verified visually — `prospects.png`. | S (one line) | ✅ Done — root cause was actually `App.tsx`'s `<main>` (`maxWidth` + `padding` under default `content-box` sizing overflowing its flex parent by 41px at 1440px), not the missing `flexWrap` alone; fixed with `boxSizing: 'border-box'` on `<main>` (benefits every page) plus `flexWrap` on Prospects' own toolbar. Verified via `getBoundingClientRect()`/`scrollWidth` with zero overflow on `/`, `/leads`, `/settings`, `/ops/crew`. |
| **0.6** | **Ops module ships with zero compile-time contract guards** on all 17 of its new body-typed endpoints — the exact class of bug (`Assert<Extends<>>` missing) the June review flagged for `sendCampaign.approved`, now inherited wholesale by the newest, least-battle-tested API surface. No live drift today; no safety net against a future one. | `packages/shared/src/index.ts` — 13/46 total routes guarded, 0/17 Ops routes. | S | ✅ Done — every Ops route schema (crew, jobs, shifts, clock, roster's create/bulk/update/publish, alerts' review) now has an `Assert<Extends<>>` guard tying it to its `RouteContracts` entry. |

**Exit criteria:** demo mode shows every page correctly with realistic seeded data; no AI worker path can be driven past its plan's spend limit by anything other than the metered API route; a crew member can't be clocked in by someone else without an explicit, audited supervisor override; a first-time user can tell Lead from Prospect from the UI alone; Ops has the same compile-time drift protection as the rest of the app.

---

## 5. Phase 1 — Bounded public GA (target: 2–4 weeks after Phase 0)

**Status: all items below closed as of 2026-09-14**, implemented by a 5-seat council working in parallel isolated worktrees and merged sequentially onto `claude/run-comparison-oz9ccj` with a full re-verification (typecheck across all 5 packages, lint, 1589 unit tests, 329 DB-tier tests against real Postgres, 230 web tests, the full `npm run verify` governance-check + build pipeline) after every merge, not just trusted from each seat's own report.

Deferred, by explicit decision rather than oversight — tracked as Phase 2 backlog:
- **5e's Settings.tsx/Leads.tsx decomposition** — excluded from this round's scope to avoid conflicting with concurrent smaller edits to the same files; still needed.
- **5e's full deletion of the 23 `apps/api/src/lib/` shims** — judged too large/risky for one pass (~54 call sites); a CI ratchet (`check:no-new-shim-imports`) now blocks new shim imports as an interim guard-rail, with full deletion flagged as the real follow-up.
- **S1's rate-limit tier** doesn't cover `jobs.ts`'s `/research-bulk` route (only per-lead quota is checked there) — pre-existing gap, not the cited call sites.
- **R7's Dockerfile.web HEALTHCHECK** was code-reviewed only (no Docker daemon in the execution sandbox to live-test against).
- **Item B's OpsAlert unique constraint** ships with no data-dedup step — fine for a fresh DB, but a real production deploy would need to check for/merge existing duplicate `(shiftRecordId, alertType)` rows first.

### 5a. UX — page-by-page, every item evidence-backed (the seat the user asked to prioritize)

This section is organized by concrete, mechanical fix — not "polish," all of it is cheap relative to impact:

1. **Two competing EmptyState components** — `Spinner.tsx`'s `EmptyState` (icon + text, no action) is used by every legacy page (Dashboard, Intelligence, Prospects, Campaigns, Approvals, Missions, Inbox, Leads); `ui/EmptyState.tsx` (title + description + real button) is used by all 7 Ops pages and is strictly more capable. **Fix:** migrate every legacy call site to `ui/EmptyState`. Mechanical, no design work needed — the better component already exists.
2. **Hand-rolled `<table>` markup** on `Leads.tsx` (the highest-traffic list page in the product — no sorting, no shared hover/select wiring) and all three tables in `Admin.tsx`, instead of the shared `ui/Table` that Dashboard/Intelligence/Prospects/every Ops page already use. **Fix:** port both onto `ui/Table`, matching the pattern already proven on `Prospects.tsx`.
3. **Dashboard.tsx has two raw, non-responsive grid layouts** (`:154` TierDistribution, `:336` Hot Accounts/Signal Feed) that clip content at mobile width, on the same page where every other multi-column region correctly uses the shared, responsive `Grid` component. **Fix:** swap both to `<Grid cols={2|3}>` — already imported on the file.
4. **"Delete" / "Deactivate" / "Archive" / "Remove" all rendered in the same red danger color regardless of whether the action is actually irreversible.** Leads/Campaigns' Delete and Settings' Remove/Revoke are genuinely destructive; OpsCrew's Deactivate and OpsJobs' Archive explicitly preserve history and are reversible in effect — but use identical `s.btnDanger` styling, so the color no longer reliably signals real data loss. **Fix:** reserve red styling for genuinely irreversible actions; give history-preserving soft-removals a neutral/amber treatment, and standardize modal copy to always state explicitly what is and isn't kept (Ops's own copy — "will be removed from active rosters but their history is kept" — is the model to copy elsewhere).
5. **No persistent inline error state anywhere in the app** — a failed API call fires a toast that auto-dismisses, then the page renders identically to a genuinely-empty result. Affects Dashboard, Missions, Approvals, Inbox, Prospects, Campaigns, Leads. **Fix:** a shared "Failed to load — Retry" banner state, used the same way `EmptyState`/`Skeleton` already are.
6. **Ops KPI tiles render blank instead of "0"** when a count is missing (`OpsAlerts.tsx`, `OpsRoster.tsx`) — reads as a rendering glitch. **Fix:** `value ?? 0` at the two call sites (and check `KpiCard` itself for the same gap generically).
7. **`Admin.tsx`'s help text reads like a README, not a product UI** ("Admin access is granted by the `isPlatformAdmin` user flag... use `EMAIL_ENCRYPTION_KEY`...") — the one screen that breaks the rest of the app's operator-facing voice. **Fix:** move it to documentation.
8. **Turn on the hub-nav flag (`VITE_HUB_NAV`) as a real fix, not just a future option** — `lib/hubs.ts` already groups Prospects+Leads+Analytics under one "Prospects" hub and Campaigns+Missions+To Review+AI Tools under "Outreach." This is a more consolidated IA than the current flat sidebar and **directly resolves item 0.4 (Lead/Prospect) and the Missions/Campaigns overlap** flagged separately — it is already built and off by default. Recommend prioritizing flipping it over building anything new for the same problem.
9. Minor, batch together: AiTools' Copy button doesn't flip its label to "✓ Copied" like Settings'/MfaSettings' do (2-second inconsistency); Approvals hardcodes its own green instead of reusing `s.btnSuccess` (already exists, used by OpsShifts); onboarding wizard has zero demo-mode coverage (fix alongside 0.1's fixture work); Ops module has no terminology bridge explaining to a sales-focused user why a CRM also does crew scheduling (a one-line explainer on `OpsDashboard.tsx` would close this).

### 5b. Security / Compliance

- **S1** Per-workspace rate-limit tier for AI/mail (currently IP-keyed only) — `rateLimit.ts:141,157`.
- **S2** Startup warning when `ADMIN_EMAIL` is still set post-bootstrap.
- **S3** Pin `jwt.verify(..., { algorithms: ['HS256'] })` at both call sites in `jwt.ts`.
- **S5** Route Ops's compliance-sensitive audit events (roster publish, alert review) through `recordCriticalAudit`, not the fire-and-forget path.
- **O2** Enforce (or explicitly document as advisory-only) the `radiusMeters` geofence on clock-in — bundle with 0.3.

### 5c. Reliability

- **R1** `docs/OPERATIONS.md`/`DEPLOYMENT.md` still claim Redis is "non-fatal" for `/api/ready` — the code actually gates on Redis in production. Five-minute doc fix; do it before an operator leans on the wrong claim during an incident.
- **R2** Ship a minimal DLQ inspect/drain script (`scripts/queue-drain.mjs`) before granting any customer high send volume — alerting exists, remediation tooling doesn't.
- **R4** Startup warning when `DATABASE_URL` lacks `connection_limit` in production.
- **R7** Add a `HEALTHCHECK` to `Dockerfile.web` for parity with api/worker.

### 5d. Data & AI

- **1** (restated from Phase 0.2, the full fix) Add quota re-checks to all three unmetered AI worker paths; add a dollar-based hard ceiling independent of call-count, especially for `growth`.
- **2** Gate evidence-gating at WARM (≥48), not just HIGH_CONFIDENCE (≥70); validate `sourceUrl` as a real URL and cross-check its hostname against supplied input.
- **3** Broaden the tone-guard regex to catch plural-subject variants ("your crews are clearly losing jobs" currently passes uncaught).
- **4** Connect the orphaned learning signal: `applyReplyAnalysis` writes real reply-outcome data to `ScoringOutcome` that nothing in the self-serve product ever reads back — only an external, ingest-only endpoint (`POST /api/outcomes`) triggers a weight recompute. Wire the product's own reply pipeline to the same recompute trigger.
- **5** Replace the fixed `size: 0.65` scoring constant with the already-parsed-but-unused `estimatedTeamSize` from research output — a half-built fix, not a new one.
- **6** Wire the eval harness (`eval-outreach.ts`/`eval-research.ts`) into CI behind a spend-limited key, or a scheduled run — currently exits 0 without `OPENAI_API_KEY` and is referenced in zero workflows.
- **7** Add a `stripe.prices.retrieve()` boot-time check so a transposed or wrong-environment `STRIPE_PRICE_*` fails loudly instead of silently granting the wrong tier.
- **A** (Ops fatigue scoring) Widen the lookback used specifically for consecutive-day counting beyond 7 days, or explicitly label the number as "7+" — a 7-day streak and a 30-day streak currently report identically.
- **B** (Ops alert reconciliation) Add `@@unique([shiftRecordId, alertType])` and switch to a status-aware upsert, so a re-triggered condition after review reopens/references the existing alert instead of creating a duplicate row.

### 5e. Architecture

- Extract `researchWorker`/`outreachWorker` bodies from `worker.ts` into deps-injectable `processors.ts` functions, matching the pattern already used for `sendCampaignBatch` etc.
- Decompose `Settings.tsx` (967 lines/29 `useState`) and `Leads.tsx` (861/25) into per-section files.
- Either delete the 23 `apps/api/src/lib/` re-export shims and repoint imports at `@acaos/backend-core` directly, or add a gate that blocks new shim imports.
- Rename `validate.ts` or `validation.ts` to resolve the naming collision.
- Add `"@acaos/shared"` to `packages/backend-core/package.json`'s declared dependencies (works today only via npm workspace hoisting).

---

## 6. Phase 2 — Scale & self-serve (target: 6–10 weeks)

Unchanged from the June plan except where superseded above: aggregate metrics across replicas + distributed tracing; enforce Prisma `connection_limit`; queue-depth-adaptive worker concurrency; convert the static source-text "chaos/safety" tests to real behavioral tests; widen the load test to cover the worker/queue path and multi-tenant traffic; canary/blue-green deploy; extract `sendCampaignBatch` (now 565 lines) into named, tested steps.

## 7. Phase 3 — Unicorn polish (continuous)

Unchanged from June: explainable scoring surfaced to users, deliverability program (warmup automation, per-domain reputation dashboards), SOC2 track (audit-log durability, key-rotation execution, access reviews), in-product DPA/CASL consent capture for EU targeting.

---

## 8. Known, out-of-scope-for-code blockers (operator action required, not re-litigated here)

- **GitHub Actions has been non-functional for this repo since ~2026-08-09** — every job in every workflow fails in 8–13 seconds with 0ms billable compute (no runner ever assigned), almost certainly an Actions spending limit or restriction at the account level. Check Settings → Billing → Actions and Settings → Actions → General. No code change can fix this.
- **`staging`/`production` GitHub Environments referenced in `release.yml` don't exist yet** — create them in repository settings; `production` should require reviewer approval.
- **`ops/monitoring/prometheus.yml`'s blackbox probe targets are still placeholder `https://api.example.com`** — needs a real deployed domain, which doesn't exist yet.
- Counsel review of `docs/legal/` drafts before flipping `COMPLIANCE_GATE_ENABLED=true`.

---

## 9. How to use this document

Phase 0 is the whole point of this pass: it is short, cheap, and closes the gap between "the backend is solid" and "a person clicking around for the first time would believe that." None of Phase 0 requires the GitHub Actions/Environments blockers to be resolved first — all six items are pure application-code or fixture changes, verifiable locally. Phase 1 is where the June review's remaining Phase-0/1 items and this round's new UX backlog converge into one prioritized list; nothing in it is a redesign. Treat this document, not `READINESS_REVIEW_2026-06-23.md`, as current.

*Prepared by the lead engineer from five independent, evidence-cited council reports (Architecture, Security, Reliability, UX, Data/AI), each verified firsthand against `HEAD` — the UX seat additionally drove the live application in a browser and captured 26 screenshots, three of which (the Settings crash, the 0-vs-248 Leads discrepancy, and the Prospects overflow) were independently re-verified by the lead engineer before inclusion.*
