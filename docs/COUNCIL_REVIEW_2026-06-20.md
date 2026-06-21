# ACAOS — Council of Five Comprehensive Engineering Review

**Date:** 2026-06-20
**Commit reviewed:** `523b916` (master, post PR #141 merge)
**Method:** Five independent specialist reviewers, each given a single lens and instructed to cite `file:line` evidence for every claim. No files were modified during review.

---

## Verdict at a glance

| Seat | Domain | Grade |
|------|--------|-------|
| 🔒 Security | AuthN/Z, injection, secrets, supply chain | **A−** |
| ⚡ Performance | DB, caching, queues, frontend | **B+** |
| 🏛️ Architecture | Boundaries, type safety, error handling | **A−** |
| 🧪 Testing | Coverage, reliability, chaos | **A−** |
| 🚀 CI/CD & Ops | Pipelines, release identity, observability | **A−** |

**Overall: A−.** This is a genuinely well-engineered codebase — defense-in-depth security with a real DNS-pinning SSRF guard, contract-first design with compile-time drift guards, a five-tier test matrix on real services, SHA-pinned CI with a stable aggregator gate, and end-to-end release identity. It is held back from an A/A+ by a small number of **cross-cutting** gaps, most of which are one-PR fixes, plus the per-request DB cost that caps the performance grade.

---

## Cross-cutting themes (flagged by ≥2 seats — fix these first)

### ★ C1 — CodeQL analyzes but never uploads results *(Security + CI/CD, HIGH)*
`.github/workflows/codeql.yml:38` sets `upload: false`. Analysis runs every PR but no SARIF reaches the Security tab, so alerts never surface and CodeQL can't gate branch protection — yet `docs/GITHUB_ADMIN.md:48` tells operators to "enable code scanning." The wiring contradicts the doc.
**Fix:** remove `upload: false` (default uploads); `security-events: write` is already present (`codeql.yml:18`). One line.

### ★ C2 — The web (nginx) image is the weak link *(Security + CI/CD, HIGH/LOW)*
- Not CVE-scanned: matrix sets `runtime_scan: false` for web (`.github/workflows/ci.yml:207-208`), so `nginx:alpine` ships with no Trivy gate.
- Runs as root: `Dockerfile.web:23-28` has no `USER` (api/worker correctly drop to `node`).
- Floating tag, not digest-pinned (`Dockerfile.web:23`).
**Fix:** switch to `nginxinc/nginx-unprivileged:alpine`, digest-pin it, and add a Trivy step for the web image in the CI matrix.

### ★ C3 — `sendCampaignBatch` — the most safety-critical runtime path — has no behavioral test *(Testing HIGH, echoed by Performance)*
`apps/worker/src/processors.ts:253` (SMTP dispatch, suppression check, outbox idempotency, mission-stop re-check, AI-quota refund) is "covered" only by **static source-grep** assertions in `tests/operational-chaos-safety-gates.test.ts:38-101` — which pass even if the behavior is broken and rot on any refactor. Its siblings `scoreProspects`/`calibrateScoring` already have real DB-tier tests.
**Fix:** add a `tests-db/` test running `sendCampaignBatch` with a stubbed `sendMail`, asserting suppressed-skip, duplicate-not-resent, refund-on-failure, and mission-PAUSED-aborts. (`packages/backend-core/src/lib/suppressions.ts:3-25` is likewise untested directly — a compliance risk — add a `bulkCheckSuppression` DB test too.)

### ★ C4 — Branch-coverage gate is lenient *(Testing + CI/CD, MEDIUM)*
`package.json` coverage gate is lines 80 / functions 80 / **branches 65** — permissive for code whose risk lives in conditional send/approval/quota/migration branches.
**Fix:** ratchet branches toward 75 incrementally, or set a higher per-directory threshold for `apps/worker/src` and `packages/backend-core/src/lib`.

---

## Per-seat highlights

### 🔒 Security — A−
**Strengths:** SSRF guard is real, not theater — `resolvePublicMailHost` resolves A/AAAA, rejects any private result, then pins the validated IP for connect while preserving TLS servername, closing the DNS-rebinding TOCTOU window (`packages/backend-core/src/lib/ssrf.ts:43-119`), wired at both config-save and connect time. No SQL/command injection surface (Prisma-only, parameterized raw at `lib/limits.ts:56,100,152`). Uniform tenancy/RBAC re-authorization, no IDOR found. Scoped MFA tokens (`lib/jwt.ts:53-73`), sha256-hashed rotating refresh tokens (`routes/auth.ts:188-203`), `timingSafeEqual` TOTP, AES-256-GCM secrets at rest. Zero XSS sinks in the frontend.
**No Critical/High findings.** Mediums: C1 (CodeQL), and no PR-time dependency-review gate (`npm audit` is post-merge). Lows: bcrypt cost 10 → raise to 12 (`routes/auth.ts:71`); password policy is length≥8 only (`lib/validation.ts:17-20`); web image as root (C2); no secret-scanning gate (gitleaks); invite-accept uses a raw `fetch` bypassing the typed client + mutation ratchet (`apps/web/src/App.tsx:159-162`).

### ⚡ Performance — B+
**Strengths:** deliberate, query-driven composite indexes (`packages/db/prisma/schema.prisma:201-203,261-263`); single-flight + TTL cache on the hot `/api/stats` fan-out (`apps/api/src/lib/ttlCache.ts:38-58`); cursor pagination with hard caps on all unbounded paths (exports, rescore loop); SQL-side aggregation instead of load-and-sum; sound queue hygiene (deterministic jobId dedup, tuned backoff).
**Findings:** **H1 (caps the grade)** — every authed request does two serial DB round-trips: `user.findUnique` in `requireAuth` (`middleware/auth.ts:57-60`) then `membership.findFirst` (`lib/workspaces.ts:48-55`); cache membership in a short-TTL map or fold into the data query. **H2** — `/api/stats` cache is per-instance, never invalidated on writes, and the equally-heavy intelligence endpoints have no cache at all (`routes/intelligence.ts:75-87`). **H3** — `sendCampaignBatch` issues multiple sequential queries *per lead* (~5000 round-trips for a 1000-lead campaign); batch the pre-checks and cache mission status. Mediums: no frontend code-splitting (everything in one bundle, `App.tsx:10-22` → `React.lazy`); no explicit Prisma pool/timeout config; `analyze-reply` upserts the scoring model on every reply (`worker.ts:214-225`).

### 🏛️ Architecture & Code Quality — A−
**Strengths:** clean dependency direction, no upward leaks, CI-enforced (`scripts/check-boundaries.mjs`); the `apps/api/src/lib/*` files are genuine one-line re-export shims, not copies; contract-first design with `Assert`/`Extends` compile-time drift guards (`packages/shared/src/index.ts:19-20`) + an enum-drift meta-test; typed centralized error handling (`backend-core/src/lib/errors.ts`, single Express middleware, `asyncHandler` on ~146 routes); `strict: true` in all five tsconfigs; accurate README.
**Findings:** **H1** — the offline Prisma stub types `PrismaClient` as `{ [key:string]: any }` (`packages/db/prisma/offline-client/default.d.ts:5,13`); when installed in offline CI, every `prisma.*` call type-checks as `any`, so a green typecheck can hide real Prisma type errors. Cache/commit a real generated client for typecheck. Mediums: `prospects.ts` is 1122 LOC / 22 routes (split it); two divergent Redis connections in the worker (`worker/src/lib/queue.ts` vs `backend-core/src/lib/queues.ts`); dead `defaultJobOptions` export; untyped `(req as any).resolvedWorkspaceId` cluster (`routes/outcomes.ts`).

### 🧪 Testing & Reliability — A−
**Strengths:** five-tier suite all wired into CI on real `postgres:16` + `redis:7` (1159 unit tests pass in ~21s, 0 failures); coverage gate enforced in CI; RFC-6238-pinned TOTP tests, SSRF range-rejection tests, IEEE-754 money tests; strong reliability primitives — versioned `migrate deploy` that refuses to start half-migrated (`scripts/start-with-migrations.mjs:77-80`), graceful shutdown + watchdog, distinct live/ready/health probes, deterministic clock-injectable job IDs.
**Findings:** C3 (untested send path + suppressions). Mediums: route tests run against an in-memory fake Prisma (won't catch missing constraints/scoping) — add DB-tier billing-webhook dedup test; three "chaos" suites are source-inspection not runtime chaos (rename + back with behavioral tests); `breakerStore.ts` cross-process state untested. Lows: worker shutdown lacks the API's forced-exit watchdog (`worker.ts:536-556`); API readiness treats Redis as non-fatal silently (`server.ts:96`).

### 🚀 CI/CD & Operational Readiness — A−
**Strengths:** stable `required` aggregator gate that survives matrix churn (`ci.yml:449-482`, `permissions: {}`); universal SHA-pinning enforced by `check-workflow-pinning.mjs`; least-privilege tokens; tests the *real* artifacts (standalone builds, deterministic offline build, Docker matrix that runtime-smokes + Trivy-scans); end-to-end release identity (`release-metadata.mjs` → `X-Acaos-Release-Id` → `smoke-deploy.mjs` cross-target coherence); safe migrations on deploy; governance ratchets as gates; real SLO multi-window burn-rate alerts with runbook enforcement.
**Findings:** C1, C2, C4 above. Mediums: shell-injection surface in Docker build-args (`ci.yml:215-217` — `GITHUB_REF_NAME` via heredoc; the release job shows the safe `env:` pattern); base images tag-pinned not digest-pinned; no SBOM / no release-asset checksums or signing. Lows: `/metrics` auth is soft-optional — public if `METRICS_TOKEN` is unset (`server.ts:71-72`) → make it a required prod env var; Trivy `ignore-unfixed: true` silently passes unpatched CVEs.

---

## Recommended action plan

### Sprint 1 — quick wins, one PR each (hours)
1. **C1**: delete `upload: false` from `codeql.yml:38`.
2. **C2**: web image → `nginx-unprivileged`, digest-pin, add Trivy scan.
3. Move Docker build-arg refs into `env:` (kill the injection surface).
4. Security one-liners: bcrypt cost → 12; stronger password minimum; add `dependency-review-action` + gitleaks on PR.
5. Architecture cleanups: delete dead `defaultJobOptions`; typed `express` request augmentation to remove the `as any` cluster; route `circuit.ts`/`queue.ts` logging through the structured logger.
6. Reliability: add the worker shutdown watchdog; make `METRICS_TOKEN` required in prod config validation.

### Sprint 2 — higher-value efforts (days)
1. **C3**: behavioral DB-tier tests for `sendCampaignBatch` + `bulkCheckSuppression`.
2. **Perf H1**: membership/auth caching (or query-folding) across the authed surface — the single biggest throughput win.
3. **Perf H3**: batch `sendCampaignBatch` pre-checks; cache mission status.
4. **Arch H1**: make CI typecheck against a real generated Prisma client so the `any`-stub never governs typechecks.
5. **C4**: ratchet branch coverage upward.
6. Decompose `prospects.ts`/`workspaces.ts` into sub-routers; unify the worker's two Redis connections.

### Operator-only (cannot be done from git — tracked in `docs/GITHUB_ADMIN.md`)
- Branch protection requiring **only** the `required` check.
- Create `staging`/`production` environments + reviewers + `SMOKE_API_URL`/`SMOKE_WORKER_URL` vars + `METRICS_TOKEN` secret.
- Enable Dependabot alerts, dependency graph, **code scanning** (unblocked once C1 lands), secret-scanning push protection.

---

*Reviewed by the Council of Five. Grades reflect the state of `523b916`; the action plan above is what moves the overall grade from A− to A/A+.*
