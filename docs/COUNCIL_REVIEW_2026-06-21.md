# ACAOS — Council of Five Comprehensive Engineering Review

**Date:** 2026-06-21
**Commit reviewed:** `d806a75` (master, post-PR #152 "A+ hardening")
**Method:** Five independent specialist reviewers, each given a single lens and instructed to
cite `file:line` evidence for every claim and verify (not trust) the findings of the prior
reviews against the current tree. No files were modified during review.

---

## Verdict at a glance

| Seat | Domain | Grade | Δ vs 2026-06-20 |
|------|--------|-------|-----------------|
| 🔒 Security | AuthN/Z, injection, secrets, supply chain | **A−** | = |
| ⚡ Performance | DB, caching, queues, frontend | **A−** | ▲ from B+ |
| 🏛️ Architecture | Boundaries, type safety, error handling | **A** | ▲ from A− |
| 🧪 Testing | Coverage, reliability, chaos | **A** | ▲ from A− |
| 🚀 CI/CD & Ops | Pipelines, release identity, observability | **A−** | = |

**Overall: A−, clearly trending up.** Two seats were promoted since the 06-20 review, and every
prior headline finding — CodeQL upload gating, web-image root, the per-request 2nd DB hit, stats
cache invalidation, the `any`-typed offline Prisma stub, and the untested send path — was verified
by the Council as **actually closed**, not merely claimed. What holds the overall at A− is one
cross-cutting soft spot plus a governance gap introduced by the very supply-chain work that
earned the A+ label.

---

## Cross-cutting theme (flagged independently by two seats — fix first)

### ★ The worker send path (`apps/worker/src/processors.ts` · `sendCampaignBatch`) is the system's soft spot from two directions at once

- **⚡ Performance (HIGH):** ~3–5 sequential DB round-trips **per lead** (mission-status,
  already-sent, intent checks) → ~4,000–5,000 serial round-trips for a 1,000-lead campaign.
  Suppression is batched (`bulkCheckSuppression`), but the mission-status and already-sent checks
  are not (`apps/worker/src/processors.ts:338-523`).
- **🧪 Testing (HIGH):** the freshly-ratcheted coverage floors (84/78/87) **do not measure this
  file at all** — `package.json:31` runs coverage over `tests/**` only, while `processors.ts` is
  exercised exclusively by `tests-db/**`, which carries no coverage flags (`package.json:32`).
  The behaviour *is* tested (strong DB tests exist), but the headline coverage number governs the
  safer half of the system and exercises 0% of the SMTP-dispatch / outbox / mission-recheck /
  AI-quota-refund branches.

**Why this matters:** the single most safety-critical runtime path is simultaneously the
performance bottleneck and the coverage blind spot. The highest-leverage fix in the codebase is
to **batch the per-lead pre-checks** and **wire coverage into the `test:db` tier** so this code is
both fast and measured.

---

## Per-seat highlights

### 🔒 Security — A−
**Strengths:** TOCTOU-safe SSRF guard resolving all A/AAAA records, rejecting any private result,
and pinning the validated IP for the actual dial — wired end-to-end into the SMTP/IMAP transport
(`packages/backend-core/src/lib/ssrf.ts:87-119`, `services/mail.ts:97-98,210`). Consistent
tenancy isolation with no IDOR — single-object routes verify membership against the row's
`workspaceId` and bulk mutations re-scope the write itself (`apps/api/src/routes/leads.ts:282-302,386-388`).
bcrypt cost 12, SHA-256-hashed rotating refresh tokens with atomic single-winner rotation
(`auth.ts:195-201`), HttpOnly cookie + custom-header CSRF, AES-256-GCM secrets at rest, JWT
type-confusion defence (`jwt.ts:53-58`), dependency-free RFC-6238 TOTP with `timingSafeEqual`
(`totp.ts:85-94`), and a step-up-gated, audit-logged admin bootstrap (`admin.ts:29-56`).
**No Critical/High findings.** Mediums: reset/verify/invite tokens travel in **URL query strings**
(`auth.ts:293,485` — leak via `Referer`/history/logs). Lows: `trust proxy` hardcoded to `1`;
per-IP-only auth rate limiting (no per-account throttle); fixed-window burst at edges; TOTP replay
within the ±1-step skew window.

### ⚡ Performance — A−
**Strengths:** the prior B+-capping issues are genuinely resolved — per-request membership now
served from a 5s single-flight TTL cache (`apps/api/src/lib/workspaces.ts:82-108`); the `/api/stats`
single-flight cache is invalidated at all six mutation sites (`apps/api/src/lib/statsCache.ts:22`,
`routes/leads.ts:174,225,355,372,389,408`); query-aligned composite indexes
(`schema.prisma:203,263,563`); cursor pagination with hard caps on every unbounded path
(`leads.ts:246-272`, `processors.ts:97-141`); SQL-side aggregation; and route-level frontend
code-splitting (`apps/web/src/App.tsx:18-28`). **Findings:** HIGH — the per-lead send loop above.
Mediums: most BullMQ queues omit `removeOnComplete/removeOnFail` → unbounded Redis growth
(`packages/backend-core/src/lib/queues.ts:42-86`); no explicit Prisma pool/timeout config
(`prisma.ts:9-11`); `/api/intelligence/*` endpoints are uncached and re-fan-out per request.

### 🏛️ Architecture & Code Quality — A
**Strengths:** dependency direction correct and CI-enforced (`scripts/check-boundaries.mjs:28`);
the `apps/api/src/lib/*` files are genuine one-line re-export shims, not copies; the offline Prisma
stub now **throws** on real DB access and CI fails typecheck if it leaks in
(`packages/db/prisma/offline-client/default.js:11-22`, `ci.yml:89-90`) — prior Arch-H1 legitimately
closed; contract-first design with compile-time `Assert`/`Extends` drift guards
(`packages/shared/src/index.ts:19-20`); centralized typed error handling (`backend-core/lib/errors.ts:5`,
`apps/api/src/lib/http.ts:25-58`); single Redis connection per process (`apps/worker/src/lib/queue.ts:3,9`);
`strict:true` ×5. **Findings (all Medium/Low):** untyped `(req as any).resolvedWorkspaceId` cluster
in `outcomes.ts:152-197`; `workspaces.ts` is now the oversized router (764 LOC, ~20 handlers); drift
guards cover only 4 of ~40 contract routes; dead/duplicated queue exports in `worker/src/lib/queue.ts`;
no shared `tsconfig.base.json`.

### 🧪 Testing & Reliability — A
**Strengths:** measured `npm run test:coverage` — **1162 tests, 0 fail, ~19s**, lines **85.82** /
branches **81.94** / functions **89.40**, clearing the new 84/78/87 floors. The prior C3 gap is
closed with **behavioral** DB tests: `tests-db/send-campaign.test.ts:57-140` runs the real
`sendCampaignBatch` against live Postgres with a recording mailer (suppressed-skip, idempotent
no-resend, fail-closed claim, PAUSED-abort); `tests-db/billing-webhook.test.ts:101-161` proves
dedup *and* claim-release-on-failure against the real unique PK; deterministic job-ids
(`tests/lib-queues-jobid.test.ts`); cross-process breaker over real Redis
(`tests-redis/breaker-store.test.ts`); the worker shutdown watchdog now exists
(`worker.ts:564-568`); `golden-spine.test.ts` is an end-to-end truth audit. **Findings:** HIGH —
the coverage gate doesn't measure the worker send path (cross-cutting, above). Mediums:
`operational-chaos-safety-gates.test.ts` is still source-grep and partly redundant with the new DB
tests; `scripts/start-with-migrations.mjs` (fail-closed migration guard) is untested; low coverage
on real-money/external-IO branches (`stripe.ts` 64%, `mail.ts` 63%).

### 🚀 CI/CD & Operational Readiness — A−
**Strengths:** stable `required` aggregator gate treating only success/skipped as passing
(`ci.yml:457-489`); universal SHA-pinning enforced by `check-workflow-pinning.mjs` as the first CI
job; real production images built, boot-smoked, AND Trivy-scanned including the now-non-root web
image (`Dockerfile.web:33`, `ci.yml:210-214,255-265`); end-to-end release identity
(`smoke-deploy.mjs:141-157`) and fail-closed migrations (`start-with-migrations.mjs:77-80`);
monitoring contract-tested (`check-monitoring-assets.mjs`), 14 alerts mapped to 6 SLOs, SBOM +
SHA256SUMS on releases; CodeQL upload honestly gated on `vars.ENABLE_CODE_SCANNING`. **Findings:**
HIGH — the new `dependency-review` + `gitleaks` gates in `security-pr.yml` run on PRs but are **not
in branch protection** (the `required` aggregator can't reference cross-workflow jobs, and the admin
script lists only `required`) → advisory only. Mediums: Docker base-image tag/comment/digest drift
(`node:26-alpine` FROM with `node:22` comments and one shared digest across all three Dockerfiles);
metrics-token compare is not constant-time (`server.ts:79`, `worker/health.ts:63`). Lows: no CI
enforcement of the `.trivyignore` expiry/why policy; `ignore-unfixed: true` can mask shipped HIGHs.

---

## Recommended action plan (highest leverage first)

### Sprint 1 — the cross-cutting fix + the enforcement gap
1. **Batch `sendCampaignBatch` pre-checks** (bulk-load `OutreachSent` for the batch; cache mission
   status per batch) — keep the atomic per-lead claim as the race guard. *(Perf HIGH)*
2. **Wire coverage into the `test:db` tier** so the worker send path is actually measured/enforced.
   *(Testing HIGH)*
3. **Make `Dependency review` and `Secret scan (gitleaks)` required status-check contexts** in
   branch protection (they're separate-workflow checks, so they're added as explicit contexts, not
   via the aggregator's `needs:`). *(CI/CD HIGH)*

### Sprint 2 — Medium hardening
4. Move reset/verify/invite tokens out of URL query strings (fragment or server-set cookie) + add
   `Referrer-Policy: no-referrer`.
5. Reconcile the Docker `node:26`-vs-`node:22` comment/digest drift across all three Dockerfiles.
6. `removeOnComplete/removeOnFail` on the AI BullMQ queues; explicit Prisma pool config.
7. Constant-time metrics-token compare; type the `req` augmentation and drop the `as any` cluster.
8. Split `workspaces.ts` into sub-routers (mirror the prospects split); extend drift guards to the
   remaining mutation contracts.

### Operator-only (cannot be done from git)
- Re-enable `master` branch protection (with the new required contexts) without re-introducing the
  solo-maintainer approval deadlock (set required approvals to 0, or add an admin bypass).
- Cache/CDN-aware `trust proxy` hop count.

---

*Reviewed by the Council of Five. Grades reflect the state of `d806a75`; the action plan above is
what moves the overall grade from A− to a clean A/A+.*
