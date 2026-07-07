# ACAOS Production-Readiness Audit

**Date:** 2026-07-07
**Method:** Six parallel specialist code reviews (security, correctness, reliability/scale, integrations/billing/onboarding, frontend/UX/ops, testing/CI). Every finding is graded **severity** × **confidence** and cites `file:line`. This is a **static source audit** — no live load test, no live Stripe/SMTP/IMAP/OpenAI exercise, no browser/screen-reader run. Those limits are listed per section under "Could not verify."

---

## 0. Why this audit exists (read this first)

During this engagement I reported "typecheck clean" locally and then shipped a change that failed CI's typecheck. That was not bad luck — it was a process error, and the testing review found the exact mechanism:

> The local `npm test` script runs `tsx --test`, which transpiles each file and **discards types**. A type error *cannot* fail `npm test`. The real local gate is `npm run verify` (typecheck + build), which I did not run.

So "green locally" was true and worthless for type safety. The fix is procedural (below, P0-9) and this audit is the correction: **verified claims, graded confidence, and an explicit list of everything I could not prove.**

---

## 1. Executive verdict

**Not ready for open public self-serve signup. Genuinely strong as a supervised beta for a field-service-vertical customer base.**

This is an unusually disciplined codebase — idempotent claim-first sends, a ledger-backed attribution model, signed Stripe webhooks with replay protection, SSRF-pinned mail, fail-closed secrets, real Docker/Trivy/CodeQL/gitleaks gates. The pipeline is fully implemented end to end; **no stage is a fake or UI-only shell.**

The gap to *public* readiness is concentrated and fixable: the multi-tenant backstop ships **inert by default**, one **exploitable webhook SSRF** hole exists, lead scoring is **hardwired to one vertical**, the "paid signup → first sent email" journey isn't continuously wired, and the simplification you're judging the UI on is **flag-gated off**. None of these are architectural rewrites.

### Readiness scorecard

| Dimension | Verdict | One-line |
|---|---|---|
| **Security & tenant isolation** | 🔴 Not ready (public) | Tenant guard inert by default; webhook SSRF; NODE_ENV-gated crypto |
| **Functionality & correctness** | 🟠 Partial | Pipeline fully works, but scoring is vertical-locked to field-service |
| **Reliability / performance / scale** | 🟠 Partial | Safe at moderate load; no DB connection-pool ceiling; per-pod rate limits on Redis loss |
| **Integrations / billing / onboarding** | 🟠 Partial | Pay→provision works; first-send journey not wired; AI quota not refunded on failure |
| **Frontend / UX / accessibility** | 🟠 Partial | Coherent system, but ships "mid-refactor": nav flag off, a11y gaps |
| **Testing & CI** | 🟠 Partial signal | Green proves it builds & modeled behavior holds — not real infra correctness |

Legend: 🔴 blocker for public · 🟠 works with known gaps · 🟢 solid

---

## 2. Must-fix before public launch (P0)

Ranked. Each is small-to-moderate scope. Bracketed tag = the review(s) that found it; **items found by two independent reviewers are marked ⧉ (higher confidence they're real).**

| # | Blocker | Evidence | Fix |
|---|---|---|---|
| **P0-1** | **Tenant guard ships inert** (`TENANT_GUARD_MODE=off`) — isolation is convention-only, no defense-in-depth ⧉ | `tenantGuard.ts:63-67`; `middleware/tenantContext.ts:34` | Set `observe` in prod now; graduate to `enforce` before self-serve. Add a DB test that a deliberately unscoped query throws under `enforce`. |
| **P0-2** | **Outbound webhook SSRF** — customer-registered webhook URLs bypass the SSRF guard that protects SMTP/IMAP | `routes/webhooks.ts:24` (`z.string().url()` only); `lib/webhooks.ts:94` (`fetch(endpoint.url)`) | Run webhook URLs through the SSRF guard at save **and** pin at delivery; require `https`, block private/reserved ranges + cloud metadata IPs. |
| **P0-3** | **NODE_ENV-unset silently downgrades crypto** — ephemeral JWT secret + all-zero AES key (only a `console.warn`) | `config.ts:78-80`; `jwt.ts:45`; `encrypt.ts:36-40` | Require `JWT_SECRET` + encryption keys whenever `NODE_ENV !== development/test`, not only `=== production`. |
| **P0-4** | **No DB connection-pool ceiling** — N API pods × Prisma pools + worker can exhaust Postgres `max_connections` first | `prisma.ts:10-13`; `schema.prisma:10-14` (no `connection_limit`/pooler) | Front runtime `DATABASE_URL` with pgbouncer (transaction mode) or pin `connection_limit`; verify advisory-lock code under transaction pooling. |
| **P0-5** | **Interactive AI calls burn paid quota on failure, no refund** ⧉ | `routes/ai.ts:73,115,149` increment before the call, no refund on throw; worker does refund (`processors.ts:705,764`) | Wrap the generate call; `refundAiUsage` on error, mirroring the worker. |
| **P0-6** | **Lead scoring hardwired to field-service, ignores workspace ICP** — highest-weighted signal (industry 0.20) is meaningless for any other vertical | `scoring.ts:44-58,155-166` (fixed keyword list, not `WorkspaceICP.targetIndustries`) | Derive the industry sub-score from the workspace's own target industries. (Downgrade to P1 if the public target market *is* field-service only.) |
| **P0-7** | **Local gate is the weakest check** — `npm test` (`tsx --test`) never typechecks; this is the root cause of the shipped type error | `package.json` test script; observed 1555 green in 22s with no typecheck | Make `npm run verify` the documented local gate; add a pre-push hook running `npm run typecheck`. |

---

## 3. Should-fix before or shortly after launch (P1)

| # | Issue | Evidence | Impact |
|---|---|---|---|
| P1-1 | **Rate limits degrade to per-pod during a Redis outage** — AI + per-workspace limiters aren't clamped like auth is ⧉ (security + reliability) | `middleware/rateLimit.ts:71-85`; `workspaceRateLimit.ts:41-50` | K pods → K× the intended AI ceiling; one workspace can burst the shared OpenAI key. Clamp AI/workspace limiters with the auth `degradedMax` pattern. |
| P1-2 | **Onboarding never wires a first send** — no SMTP setup step, never creates/launches a campaign | `OnboardingWizard.tsx` Step4 (`:493`); `core.ts:254` | A paid customer lands on an empty radar with no path to send. Add a "connect mailbox / launch first campaign" step. |
| P1-3 | **`past_due` instantly hard-gates a payer to free-tier caps** — no grace window | `limits.ts:53` (any status ≠ `active` → free) | One failed invoice during normal Stripe dunning cripples a good customer. Honor a grace window. |
| P1-4 | **Interactive AI routes return unvalidated raw model output** — the strict schema trust boundary is only applied in the worker | `routes/ai.ts:100,135,152` vs `aiSchemas.ts:103` | Drifted/truncated model output reaches the UI unchecked. Validate on this path too. |
| P1-5 | **The 5-hub simplification ships flag-off; AI Tools page duplicates the new inline actions** | `hubs.ts:70-78` (default false); `AiTools.tsx` still routed at `App.tsx:432` + sidebar + palette + hub tab | The simplification you're judged on isn't live, and there are two doors to the same AI. Graduate the flag; retire the standalone page. |
| P1-6 | **No focus trap / focus restoration in modals, palette, drawer** | `ui/Modal.tsx`, `ui/Drawer.tsx`, `CommandPalette.tsx` (Escape + click-outside only) | Keyboard/screen-reader users get lost. Violates WCAG 2.4.3 / 2.1.2. Add a shared focus-trap + return-focus hook. |
| P1-7 | **Low-contrast secondary text fails WCAG AA** — `textFaint #475569` on `#030712` ≈ 2.6:1 (needs 4.5) | `styles.ts:12`, used pervasively for nav labels, meta, empty states | Large swaths of UI text are hard to read. Lighten `textFaint` for text-bearing uses. |
| P1-8 | **No browser-side error observability** — client crashes are invisible in prod | no Sentry in `apps/web/src`; `App.tsx:49` ErrorBoundary only shows Reload | Wire the browser Sentry SDK into the ErrorBoundary + global handlers. |
| P1-9 | **~22 silent `.catch(() => {})` sites** — a failed secondary fetch renders as "empty," not an error | Dashboard `:286,288`, Leads `:223,227`, Prospects `:374,382,389`, Settings, Billing, Admin | Set an error state + retry affordance; don't disguise failure as no-data. |
| P1-10 | **Manual `PATCH /leads/:id` bypasses the stage state machine** — allows illegal regressions, writes no ledger event | `routes/leads.ts:348-351` vs `leadStageMachine.ts:1-7` | Stage history can diverge. Route through `transitionLeadStage` or gate behind an explicit "reopen." |
| P1-11 | **Enqueue can hang the HTTP request while Redis is down** — BullMQ offline-queue, no status guard | `queues.ts:13-26`; AI/campaign/mailbox `.add()` paths | Requests hang instead of failing fast. Bound enqueue with a status check/timeout. |
| P1-12 | **IMAP fetch loop is untested** — only parsing/cursor/post-fetch DB writes are covered, not the live connect+fetch | `services/mail.ts:477` (dynamic `imapflow`); `tests/services-mail.test.ts` tests config only | An IMAP protocol/cursor regression ships green. Add a fake-IMAP integration test. |
| P1-13 | **CodeQL findings never block merge unless a repo var is set** | `codeql.yml` gates SARIF upload on `vars.ENABLE_CODE_SCANNING=='true'`; not in `required.needs` | Confirm the var is `true`; add CodeQL to branch-protection required checks. |

---

## 4. Findings by dimension

### 4.1 Security & multi-tenant isolation — 🔴 Not ready (public)

**Strong foundation, missing the public-tier backstop.** Verified: JWT fail-closed in prod + placeholder/length rejection at boot; refresh-token rotation with reuse-detection → revoke-all + audit; HttpOnly/Secure/SameSite cookies + CSRF header on refresh/logout; TOTP with replay-safe step consumption and progressive lockout; step-up re-auth on billing/admin/MFA; owner-only admin-grant (no lateral escalation); SSRF DNS-pinning for SMTP/IMAP with connect-by-IP (closes rebind TOCTOU); no raw SQL (only parameterized advisory-lock template literals); Stripe HMAC verify + idempotency; versioned encryption keyring; strict API CSP + HSTS; metrics 404-without-token in prod; pinned action SHAs, dependency-review, gitleaks, CodeQL, `npm audit`, committed lockfile.

**Blockers:** P0-1 (guard inert), P0-2 (webhook SSRF), P0-3 (NODE_ENV crypto). **Note:** even at `enforce`, the guard classifies `findUnique/update/delete`-by-id as `skipped` (`tenantGuard.ts:50-52`), so by-id IDOR still relies on fetch-then-authorize — keep that pattern mandatory. Per-route membership checks were spot-checked on leads/webhooks/billing/members/mailbox/ingest (all pass); campaigns/missions/outcomes/intelligence/signals/stats were **not** each line-audited.

**Could not verify:** whether prod actually sets `TENANT_GUARD_MODE` / `NODE_ENV=production`; that *every* mutating route across all 24 routers checks membership; the web CSP via `nginx.conf` at runtime; that no Postgres RLS exists (isolation is app-layer only).

### 4.2 Functionality & correctness — 🟠 Partial

**The full pipeline is implemented and robust** — every stage from discovery → scoring → research → draft → approval → send → IMAP ingest → classification → stage transitions → reporting is real code with fail-closed error handling. Sends are idempotent (unique `(campaignId,leadId)` + claim-first-before-AI); attribution deliberately sources sent/replied from the immutable `ContactEvent` ledger and booked/won from `Lead.stage` (avoids drop-loss) and is reconcilable. All five "dormant" feature flags (`FOLLOWUPS_ENABLED`, `SAFE_LAUNCH_MODE`, `COMPLIANCE_GATE_ENABLED`, `REPUTATION_GUARD_MODE`, `TENANT_GUARD_MODE`) are functional, not dead.

**Gaps:** P0-6 (vertical-locked scoring), P0-5 (AI quota refund), P1-10 (manual stage bypass). Smaller: Hunter discovery is a silent no-op stub (`prospectSources.ts:148`); default AI vertical falls back to field-service when ICP unset (`openai.ts:184,336`); the `interested` `CampaignDailyStats` column is dead (never incremented); "first send" activation fires at enqueue, not delivery (`campaigns.ts:541`).

**Could not verify:** live OpenAI/Apollo/Google/IMAP wire behavior (interfaces confirmed, not real responses); that `imapflow`/`nodemailer`/`openai` are present in the deployed image (dynamic imports 503 if missing).

### 4.3 Reliability, performance, scalability — 🟠 Partial

**Write-safety is genuinely strong (static analysis; no load test run).** Verified: daily send cap concurrency-safe via `pg_advisory_xact_lock` + `reserveDailySendSlot` inside the claim tx; AI metering race-safe; circuit-breaker OPEN state shared via Redis (fail-open on Redis error, single HALF_OPEN probe); single-flight caches don't cache failures; bounded job retention; AI backoff exceeds breaker reset; graceful shutdown with force-exit watchdog; readiness gates Redis in prod; hot query paths are indexed (leads list, per-domain pacing, ledger windows).

**Scaling blockers:** P0-4 (connection pool), P1-1 (per-pod rate limits), P1-11 (enqueue hang). Also: per-domain send pacing is in-process and not shared across concurrent send jobs/pods → provider overshoot risk (`processors.ts:463-474`); auto IMAP sync is one sequential job over all workspaces (`worker.ts:331-348`) → lags as mailboxes grow, doesn't fan out; send throughput is a fixed serial ceiling (adding pods won't linearly raise it); three unbounded `findMany` (`unsubscribe.ts:114`, `missions.ts:85`, `outcomes.ts:258`); `hashtext` advisory locks use a 32-bit key space (latent contention).

**Could not verify:** actual p50/p99, the real connection ceiling, per-domain overshoot magnitude, BullMQ behavior during a real Redis partition — **no load test was run; all perf claims are static inferences.**

### 4.4 Integrations, billing, onboarding — 🟠 Partial

**Pay → provision genuinely works** (given config): Stripe raw-body mounted before `express.json`, signature verified, event idempotency via `ProcessedStripeEvent` claim-first-then-release-on-failure, server-side price→plan mapping, unrecognized price never downgrades a payer, full subscription lifecycle handled. Email (SSRF-pinned SMTP, encrypted creds, cursor-based idempotent IMAP with bounce + ARF-complaint handling) and discovery degradation (unconfigured providers return `[]`, helpful 503) are unusually complete.

**Gaps:** P0-5 (AI quota refund), P1-2 (onboarding→first-send), P1-3 (`past_due` grace), P1-4 (unvalidated AI output). Also: `trialing` treated as free (latent — Stripe trials not enabled today); no in-app upgrade/downgrade (portal-only); dunning/verify email failures swallowed with no retry/alert; `/verify-email` has no rate limit.

**Honest answer to "can a real customer pay and use it end-to-end?"** — *Pay + get provisioned: yes. Guided path to a first sent email: no* (onboarding collects no mailbox and launches no campaign).

**Could not verify:** live Stripe signature acceptance/webhook retries; real SMTP/IMAP against live providers; live OpenAI behavior; whether required env is actually provisioned.

### 4.5 Frontend, UX, accessibility, maintainability, ops — 🟠 Partial

**The design system is coherent** — one token file, consistent `Spinner`/`EmptyState`/`Card`/`Badge` primitives, product-voice empty states, toasts on primary loads, a real command palette, and the contextual `AiQuickAction` pattern executed cleanly. Ops hardening is excellent: read-only rootfs, `cap_drop: ALL`, `no-new-privileges`, non-root nginx, pinned digests, `/api/ready` healthchecks, strictly additive migrations (no `DROP` across all 71).

**But it ships mid-refactor:** P1-5 (nav flag off + AI Tools duplication), P1-6 (focus management), P1-7 (contrast), P1-8 (no browser error reporting), P1-9 (silent error swallow). Also: oversized view files (Settings 45KB, Leads 37KB, Prospects 35KB); nav source-of-truth duplicated across three files that already disagree; broad `connect-src 'self' https:` CSP.

**Reconciliation:** one reviewer flagged "no schema-drift guard in CI" from the static `ci.yml` lane — the **DB-integration `verify-db` job does run `prisma migrate diff` drift detection** (confirmed by the testing review). So drift *is* guarded, just in the DB tier, not the static tier. Not a gap.

**Could not verify:** real rendered contrast and actual screen-reader/keyboard traversal (**static a11y review only** — no axe/AT run); runtime behavior of swallowed-error paths.

### 4.6 Testing & CI — 🟠 Partial signal

**Observed, real:** backend unit **1555 pass / 0 fail (22.7s)**; apps/web **171 pass / 0 fail (28.2s)**; both green, zero flakes this run. tests-db (~246 tests, 56 files) and tests-redis (5 files) are CI-only (real Postgres/Redis). CI is thorough on build/deploy/supply-chain: real Docker image builds + Trivy scan, boot-smoke, `npm audit`, boundaries, real-Prisma typecheck, coverage-gated unit (84% line / 78% branch / 87% fn), DB integration with schema-drift diff, Redis queue test, Playwright e2e smoke.

**But green ≠ customer-ready, because:** P0-7 (`npm test` never typechecks); P0-1's `enforce` mode is never integration-tested; unit coverage is inflated by fake-Prisma execution (handler lines count as covered while queries run against an in-memory object); the `check-critical-test-coverage` floor only string-matches a path, not real assertions; IMAP fetch, and onboarding are tested structurally/against fakes, not exercised for real; P1-13 (CodeQL not blocking). Well-tested paths (verified): billing webhooks (real signature + real-DB idempotency), per-route tenant isolation (real two-tenant IDOR 403s), the send path (15+ real-DB tests).

---

## 5. What this audit did NOT do (so you can weight it)

- **No live load/stress test** — all performance and scaling claims are static-analysis inferences.
- **No live Stripe / SMTP / IMAP / OpenAI / discovery-provider exercise** — integration *logic* was read; real wire behavior was not observed.
- **No browser / screen-reader / axe run** — accessibility is a static review.
- **Not every one of the 24 API routers was line-by-line membership-audited** — a representative set was.
- **Runtime/deploy config could not be inspected** — whether prod sets `TENANT_GUARD_MODE`, `NODE_ENV=production`, a pooled `DATABASE_URL`, and all required secrets is unknown from the repo.

---

## 6. Suggested sequence

1. **This week (P0-7, P0-3, P0-1-observe):** switch the local gate to `npm run verify` + pre-push typecheck; require crypto keys outside dev/test; set `TENANT_GUARD_MODE=observe` in prod. Cheap, high-trust.
2. **Before any public signup (P0-1-enforce, P0-2, P0-4, P0-5, P0-6):** enforce tenant mode (with a test), close the webhook SSRF, put a pooler in front of Postgres, refund AI quota on failure, make scoring ICP-aware.
3. **Before scaling spend (P1 reliability + billing):** clamp rate limiters under Redis loss, wire onboarding→first-send, add a `past_due` grace window, validate interactive AI output.
4. **UX/a11y polish (P1-5..9):** graduate the hub-nav flag, retire the duplicate AI Tools page, add focus management + contrast fixes + browser error reporting, stop swallowing errors.

---

*Generated by a six-reviewer static audit. Every claim is traceable to `file:line`; confidence is graded; unverified areas are named. If a specific finding matters to a decision, ask and I'll trace it live rather than restating it.*
