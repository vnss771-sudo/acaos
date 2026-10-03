# Handover

The state of ACAOS for whoever picks it up next: what's done, what's waiting on a
decision, and where to start. Last refreshed October 2026.

## In one paragraph

ACAOS is a multi-tenant web app for trade contractors: it finds work (tenders,
development applications, businesses with buying signals), helps win it, runs it
(crew, shifts, sites) and reports which work actually made money. The product is
built and tested end to end and is **pre-launch**: what remains is hosting, keys,
legal sign-off and a few engineering decisions listed below. Product positioning
is in [`POSITIONING.md`](../POSITIONING.md), the user-facing loop in the
[`README`](../README.md).

## Repository map

| Path | What it is |
|---|---|
| `apps/api` | Express API (auth, workspaces, billing, every `/api/*` route) |
| `apps/worker` | BullMQ worker: sending, reply ingestion, scoring, sweeps. `processors.ts` holds the job handlers |
| `apps/web` | React + Vite single-page app |
| `packages/backend-core` | Runtime logic shared by api and worker (Prisma client, mail, scoring, guards). The worker must not import from `apps/api`; `npm run check:boundaries` enforces it |
| `packages/db` | Prisma schema and migrations |
| `packages/shared` | Typed request/response contracts shared by api and web |
| `tests`, `tests-db`, `tests-redis`, `e2e` | Unit, Postgres, Redis and Playwright test tiers |
| `ops/monitoring` | Prometheus, Alertmanager, Grafana and blackbox probe config |
| `docs/` | Operations, deployment, security and design docs (index below) |

## Getting it running

Local setup and Docker are in the [README](../README.md#local-setup). Before any
push, run the same gate CI runs:

```bash
npm ci
npm run verify          # repo checks, lint, typecheck, unit + web tests, build
npm run verify:services # Postgres + Redis tiers (needs both running; see scripts/test-*-local.sh)
```

At handover `npm run verify` passed locally: 2,044 unit tests, 342 web tests, the
build, and every repo check. `master` was green on CI and CodeQL, and
`npm audit --omit=dev` reported 0 vulnerabilities.

## Waiting on the owner

### Pull requests

| PR | What | Action |
|---|---|---|
| #302 | GitHub Actions bumps (checkout, setup-node 7, cache 6, CodeQL), SHA-pinned | All checks green, merges cleanly: **merge** |
| #303 | Docker base-image digest refresh (node 26-alpine, nginx-unprivileged) | All checks green, merges cleanly: **merge** |
| #300 | node-dev group, mixes 3 patch bumps with TypeScript 7, ESLint 10, Vitest 5, jsdom 30 majors | Fails CI. **Close**: the patch bumps are applied directly; majors now arrive one per PR (see below) |
| #317 | node-prod group, 12 major upgrades at once (see next table) | Fails CI on nearly every job. **Close**, then upgrade one major at a time |

`.github/dependabot.yml` now groups only minor and patch updates, so routine bumps
stay one green PR a week and each major upgrade arrives on its own.

### Major upgrades deferred

None of these is needed for launch, and none has a known vulnerability on the
current version. Each is a migration in its own right; take them one at a time,
after launch, in roughly this order:

| Package | Current → available | Notes |
|---|---|---|
| `@types/node`, `jsdom`, `@testing-library/jest-dom` | dev only | Low risk; start here |
| `eslint` + `@eslint/js` 9 → 10 | dev only | Flat config is already in use |
| `vitest` + coverage 4 → 5 | dev only | Web test tier only |
| `dotenv` 16 → 18, `bcryptjs` 2 → 3 | prod | Small APIs; check hash compatibility for bcryptjs (existing hashes must still verify) |
| `openai` 6 → 7, `stripe` 16 → 22, `imapflow` 1 → 2 | prod | Provider SDKs, each used in one place: `backend-core/src/services/openai.ts`, `apps/api/src/services/stripe.ts`, `backend-core/src/services/mail.ts` |
| `ioredis` 5 → 6 with `bullmq` 5 → 6 | prod | Upgrade together: ioredis is pinned to 5.10.1 to match BullMQ's copy (commit `09b26c3`) |
| `express` 4 → 5 | prod | Path syntax and async error handling changes across every route |
| `react` / `react-dom` 18 → 19 | prod | Whole web app |
| `prisma` / `@prisma/client` 5 → 7 | prod | Largest: generator and client changes; run the DB tier and drift check |
| `typescript` 5 → 7 | dev | Native compiler; do last, after the rest settle |

`tsx` is pinned exactly at the root (`4.22.4`) and is left for the routine weekly PR.

## Open engineering backlog

Refreshed from issue #217 (the five-lens audit) against current code.

**Still open**

1. **Tenant guard to `enforce`.** The guard runs in worker jobs and, via the
   `tenantContext` middleware, on API requests that carry a `workspaceId`. Routes
   addressed only by resource id (e.g. `/campaigns/:id`) still rely on
   fetch-then-authorize. Wrap those handlers, run `observe` in production (the
   default when `NODE_ENV=production`), clear any `[tenant-guard]` warnings, then
   set `TENANT_GUARD_MODE=enforce`. Required before open self-serve signup; see
   [PRODUCTION_ENV_VARS](PRODUCTION_ENV_VARS.md).
2. **Reputation guard default (product call).** `REPUTATION_GUARD_MODE` defaults to
   `observe`: it logs a degraded bounce/complaint rate but doesn't stop sending.
   Decide whether launch runs with `enforce`.
3. **Per-workspace draft policy.** `policyCheck.ts` supports `maxLinks` and
   `requireUnsubscribeInBody`, but `WorkspaceDraftPolicy` has no columns for them.
   Add columns, migration and route only if per-workspace control is wanted.
4. **Safer defaults for new workspaces (product call).** `SAFE_LAUNCH_MODE`
   (forced approval plus a 20/day cap) exists but is off by default. Consider
   turning it on for launch.
5. **Module structure.** `packages/backend-core/src/lib` is a flat directory of
   113 files and `apps/worker/src/processors.ts` is about 2,000 lines. Split by
   domain (send, score, discover, inbox) before the next feature wave.
6. **Test gates.** `npm test` and the Redis tier have no coverage threshold (the
   gate lives in `test:coverage`, 84/78/87); the DB tier's branch floor is 68%;
   `e2e` has five happy-path tests. Add failure-mode browser coverage.

**Resolved since the audit**

- Membership-role cache: invalidated on member add, remove and workspace delete
  (`apps/api/src/lib/workspaces.ts`).
- Tenant guard is no longer silently inert in production (defaults to `observe`).
- Stranded `SENDING` rows are reaped (`staleSends.ts`) and in-flight sends count
  toward caps.

## Launch path

Follow [`GO_LIVE_CHECKLIST.md`](GO_LIVE_CHECKLIST.md) top to bottom. The long poles:

1. **Legal:** counsel reviews the drafts in [`docs/legal/`](legal/README.md); only
   then set `COMPLIANCE_GATE_ENABLED=true`.
2. **Hosting:** Postgres with snapshots and PITR, Redis with AOF, DNS and TLS,
   SPF/DKIM for sending domains. See [DEPLOYMENT](DEPLOYMENT.md) and
   [DEPLOY_RUNBOOK](DEPLOY_RUNBOOK.md).
3. **Secrets:** the required variables are listed in
   [PRODUCTION_ENV_VARS](PRODUCTION_ENV_VARS.md); every variable with its default is in
   [CONFIGURATION](CONFIGURATION.md).
4. **Monitoring:** replace the placeholder probe targets in `ops/monitoring/`.

## Where things are documented

| Need | Doc |
|---|---|
| Every env var and its default | [CONFIGURATION](CONFIGURATION.md) |
| Deploying, rolling back | [DEPLOYMENT](DEPLOYMENT.md), [DEPLOY_RUNBOOK](DEPLOY_RUNBOOK.md), [LAUNCH_RUNBOOK](LAUNCH_RUNBOOK.md) |
| Incidents and alerts | [RUNBOOKS](RUNBOOKS.md), [OPERATIONS](OPERATIONS.md), [SLO](SLO.md) |
| Backups and recovery | [RECOVERY](RECOVERY.md), [DATA_RETENTION](DATA_RETENTION.md) |
| Schema changes | [MIGRATIONS](MIGRATIONS.md) |
| Security model, roles, keys | [SECURITY](../SECURITY.md), [RBAC](RBAC.md), [KEY_ROTATION](KEY_ROTATION.md), [SECURITY_ASVS_MATRIX](SECURITY_ASVS_MATRIX.md) |
| CI and repo settings | [CI_CD](CI_CD.md), [GITHUB_ADMIN](GITHUB_ADMIN.md) |
| Mailbox sign-in (Google/Microsoft) | [MAILBOX_SIGN_IN](MAILBOX_SIGN_IN.md) |
| Demo | [DEMO_SCRIPT](DEMO_SCRIPT.md) |
