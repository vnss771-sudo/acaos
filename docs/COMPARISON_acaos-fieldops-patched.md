# Comparison: `acaos-fieldops-patched.zip` vs. current `master`

Source: uploaded archive `acaos-fieldops-patched.zip` (790 files, snapshot dated
2026-09-05, self-described as "Phases 1–12" of an "ACAOS + FieldOps merge").
Compared against `master` @ `a337521` (current HEAD of this branch's base).

**Bottom line:** the archive is a strict superset of `master` — **0 files are
missing** anything present today, **57 files are new**, and **62 files are
modified**. It bundles at least four separable workstreams into one drop, only
one of which (the Ops module) is documented in the archive's own reports.

## 1. What's actually in it

### A. New "Ops" module (the headline item, per `FINAL_REPORT.md`/`HANDOFF.md`)
A full port of a "FieldOps" product into ACAOS as a workspace-scoped module for
crew/shift/job-site management:
- **Schema**: 5 new models (`OpsCrewMember`, `OpsJobSite`, `OpsShiftRecord`,
  `OpsAlert`, `OpsRosterEntry`) via migration `20260903000000_ops_module_foundation`,
  plus a follow-up `20260903120000_ops_endtime_nullable` fixing `endTime` to be
  nullable so open (in-progress) shifts can be represented.
- **Backend**: new `apps/api/src/routes/ops/*` (index, crew, jobs, shifts, clock,
  roster, alerts, fatigue, admin, utils + 8 stub routers for
  branches/branding/currency/documents/integrations/notifications/portal/sso/webhooks/audit),
  a new `resolveOpsWorkspace` middleware, and `OpsAuthUser`/`OpsRequest` types +
  a `requireOpsUser` helper in `lib/http.ts`. Wired into `server.ts` at `/api/ops`.
- **Frontend**: a new `ops` hub in the sidebar nav (`lib/hubs.ts`) with 9 tabs, and
  9 new view components under `apps/web/src/views/ops/`.
- **Tests**: 9 new test files, ~110 tests (`routes-ops-*.test.ts`).
- **Docs/ops**: `HANDOFF.md`, `FINAL_REPORT.md`, `MERGE_REPORT*.md` (3 files),
  `DEPLOYMENT_OPS.md`, `PERFORMANCE_BASELINES.md`, `CHANGELOG_OPS.md`, plus 3 new
  Ops-specific alerts in `ops/monitoring/alerts.yml`.
- Its own report claims a P0 bug fix: every Ops route originally read
  `req.user.workspaceId`, a field that doesn't exist on `User` (workspace comes
  from `Membership`) — i.e. the module was non-functional before this patch.

### B. Mission-level ICP overrides (undocumented in the Ops reports)
- Migration `20260826000000_mission_icp_overrides` adds `Mission.icpOverrides` (JSONB).
- New `PATCH /api/missions/:id/icp` and `GET /api/missions/:id/icp` endpoints
  (merge/clear per-mission targeting overrides, resolve effective ICP against
  workspace ICP → pack preset fallback chain).
- New test `tests/routes-missions-icp.test.ts`.

### C. Security/reliability hardening (also undocumented in the Ops reports)
- **`webhooks.ts`**: outbound webhook delivery is rewritten to use a DNS-pinned raw
  HTTPS request (`node:https`) instead of `fetch`, rejects non-`https:` endpoint
  URLs, and decrypts the stored webhook secret (`decryptSecret`/`isEncrypted`) before
  signing — closing an SSRF/DNS-rebinding hole and implying webhook secrets are now
  stored encrypted at rest.
- **`tenantGuard.ts`**: replaces the old `findKey` (which returned on the *first*
  match anywhere in a nested `AND/OR/NOT` tree — including inside an `OR`, which
  can under-constrain) with `classifySubtree`, which requires **every** branch of
  an `OR` to be independently scoped, and never treats `NOT` as scoping evidence.
  This is a real correctness fix to the tenant-isolation guard's logic, not a
  refactor. Also adds `OpsCrewMember`/`OpsJobSite`/`OpsShiftRecord`/`OpsAlert`/`OpsRosterEntry`
  to the guarded-model allowlist.
- **`tenantContext.ts`**: adds a second workspace-resolution strategy — for
  resource-ID routes (`/api/{campaigns,leads,missions,prospects,sends,intents}/:id`)
  it now does a `findUnique` DB lookup by ID to recover `workspaceId` when it isn't
  present in the query/body, closing the "resource-id-only routes fall through
  uncovered" gap called out in the current code's own comment.
- **`limits.ts`**: adds `reserveMonthlySendSlot` (same advisory-lock pattern as the
  existing daily reservation) and a new platform-level `checkProviderQuota` for
  discovery providers (Apollo/Hunter/Google Places), Redis-backed with an
  in-process fallback.
- **`config.ts`/`openai.ts`**: adds `validateModelConfig()` (hard-fails startup in
  production if `OPENAI_MODEL` isn't allow-listed) and `checkEncryptionKeyHealth()`
  (warns if an encryption key ring is misconfigured), both called from `server.ts`
  startup. New `scripts/rotate-encryption-key.mjs` and `scripts/migrate-webhook-secrets.mjs`.

### D. Web UI visual overhaul (unrelated to Ops)
- `styles.ts` adds a "premium" design layer: glow colors, a `shadows` system, and
  gradient presets, applied through `Sidebar.tsx`, `CommandPalette.tsx`, `Card.tsx`,
  `Modal.tsx`, `Badge.tsx`, `KpiCard.tsx`, and a large `animations.css` addition.
- New light theme (`theme-light.css`, `hooks/useTheme.ts`) and mobile support
  (`responsive.css`).
- New marketing pages `views/Landing.tsx`, `views/Pricing.tsx`, and new shared
  components `EmptyState.tsx`, `HelpTooltip.tsx`.

### E. Tooling / CI additions
- `scripts/generate-openapi.mjs` + `scripts/openapi-ops-schemas.mjs` → `docs/openapi.json`.
- `scripts/check-contract-coverage.mjs`, `scripts/check-no-shipped-secrets.mjs`,
  `scripts/check-inline-style-budget.mjs` — three new `npm run verify` gates.
- `scripts/deploy-production.mjs` (+ `--dry-run`).
- New docs: `BETA_OPERATIONS.md`, `DEPLOYMENT_RUNBOOK.md`, `RELEASE_HARDENING.md`,
  `SECURITY_MODEL.md`, `SEND_STATE_MACHINE.md`, `IMPLEMENTATION_REPORT_2026-08-28.md`.
- `package.json`: raises `--test-timeout` from 60s→120s across `test`/`test:chaos`/
  `test:redis`, adds a `test:ops` script, bumps `tsx` to `^4.23.13`, and pins
  `@types/express` to `^4.17.25` — **this actually fixes an existing mismatch**:
  root `package.json` currently pins `@types/express@^5.0.1` while
  `apps/api/package.json` depends on the real `express@^4.19.2` runtime.

## 2. Things worth flagging before adopting any of this

- **Scope mismatch**: `FINAL_REPORT.md`/`HANDOFF.md` describe this as a 9-file,
  Ops-only change ("6 bugs fixed, 90 tests added"). The actual diff touches 62
  existing files and adds 57 new ones across security-critical code
  (`tenantGuard.ts`, `tenantContext.ts`, `webhooks.ts`) that the Ops reports never
  mention. Anyone reviewing off those reports alone would miss most of the diff.
- **`.env.production` is included in the archive.** Checked by hand — every value
  is a placeholder (`CHANGE_ME`, `sk-CHANGE_ME`, etc.), no live secret. But shipping
  this file at all is exactly what the archive's own new
  `check-no-shipped-secrets.mjs` gate presumably exists to catch — worth deciding
  whether it should be committed even as a placeholder template, or dropped in
  favor of `.env.example`.
- **`tenantContext.ts`'s new resource-path resolution adds a DB round-trip**
  (`findUnique`) on every request to a resource-ID route when the tenant guard is
  enabled and no `workspaceId` was already supplied — a latency/load consideration
  for `enforce` mode, not just a correctness one.
- **The `tenantGuard.ts` `OR`-branch fix changes guard verdicts** for any existing
  query shaped like `OR: [{workspaceId: x}, {other: y}]` — previously "scoped"
  (first match wins), now correctly "unscoped" unless every branch is scoped. If
  the guard runs in `enforce` mode anywhere today, this could newly reject queries
  that used to pass; worth an explicit audit of current `OR`-shaped queries before
  flipping this in.
- **No destructive changes**: nothing in `master` is deleted, renamed away, or
  behaviorally removed — every diff is additive or a targeted fix, which makes
  this safe to review incrementally rather than all-or-nothing.

## 3. Suggested path forward

Given the archive mixes one large new feature (Ops), one small new feature
(mission ICP overrides), several independent security fixes, and a UI reskin,
recommend **splitting into separate PRs** rather than one bulk merge:

1. Security/reliability fixes (`webhooks.ts`, `tenantGuard.ts`, `tenantContext.ts`,
   `limits.ts` quotas, encryption-key tooling) — smallest, highest-value, easiest
   to review and test in isolation (`npm test`, `npm run test:db`).
2. Ops module (schema + routes + middleware + frontend + tests + monitoring) —
   large but self-contained; `npm run test:ops` (110 tests) already exists to gate it.
3. Mission ICP overrides — small, independent.
4. UI visual overhaul (styles/animations/theme/landing/pricing) — purely additive,
   lowest risk, best done last since it touches the most shared frontend files
   (`Sidebar.tsx`, `styles.ts`) and would conflict with the other three landing on
   `master` first.

No code was merged into this branch as part of this comparison — this document
is the deliverable. Say the word if you want any of the four workstreams above
actually applied to `master`.

## 4. Status

Workstream B (mission ICP overrides) and the `limits.ts` provider-quota and
encryption-key-tooling items from workstream C have since been implemented and
merged (PRs #268, #270, #269).

**Deferred — Ops webhooks + CSV exports.** The 8 "stub routers" listed in
section A under the Ops module (`branches`/`branding`/`currency`/`documents`/
`integrations`/`notifications`/`portal`/`sso`/`webhooks`/`audit`) were stubs in
the source archive itself, not existing functionality — there was nothing to
port. Building real Ops webhook notifications or CSV report exports is
therefore a new product feature to design, not outstanding merge/porting work.
Revisit based on customer requirements.
