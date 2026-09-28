# CLAUDE.md

ACAOS (Agentic Client Acquisition OS) is a TypeScript npm-workspaces monorepo
(Node 22+, ESM). `BUILD.md` is the full build/run guide; `docs/` holds
operational runbooks, CI/CD, migrations and RBAC docs.

## Layout

```
apps/api/                 Express API (routes/, middleware/, services/)
apps/worker/              BullMQ worker (processors.ts, worker.ts)
apps/web/                 React + Vite frontend (views/, components/, lib/routeApi.ts)
packages/backend-core/    Shared backend runtime used by BOTH api and worker
packages/shared/          Type-only API contracts shared by api + web
packages/db/prisma/       Prisma schema + versioned migrations (PostgreSQL)
tests/                    Unit tier: no external services
tests-db/                 Needs PostgreSQL
tests-redis/              Needs Redis (may also use Postgres)
e2e/                      Playwright
scripts/                  CI guard scripts (check-*.mjs), release/ops tooling
```

## Commands

```bash
npm install                  # also generates the Prisma client (postinstall)
npm run lint                 # eslint (no type info; fast)
npm run typecheck            # shared + backend-core + api + web + worker
npm test                     # unit tier (tests/**), no services needed
npm run test:web             # frontend (Vitest)
npm run verify               # everything CI's `required` check runs
```

Run a single unit test:

```bash
NODE_OPTIONS=--conditions=acaos-src npx tsx --test tests/jwt.test.ts
```

`NODE_OPTIONS=--conditions=acaos-src` makes `@acaos/backend-core` resolve to
its TypeScript source, so no build is needed for dev or tests. The npm scripts
already set it; set it yourself when invoking `tsx` directly.

`test:db` / `test:redis` need live services; use `test:db:local` /
`test:redis:local` to boot ephemeral ones. Don't add service-dependent tests to
`tests/`.

## Architectural rules (enforced by `npm run check:*` in CI)

- **Shared backend code goes in `@acaos/backend-core`.** The worker must never
  import from `apps/api/src` (`check:boundaries`).
- **Import `@acaos/backend-core/lib/X.js` directly.** Don't add re-export shims
  under `apps/api/src/lib/` (`check:no-new-shim-imports`).
- **Frontend mutations go through the typed route client**
  (`apps/web/src/lib/routeApi.ts`), never a hand-built
  `body: JSON.stringify(...)` (`check:frontend-mutations`).
- **Test tiers stay isolated:** `tests/` must not import from `tests-db/` or
  `tests-redis/` (`check:test-tiers`).
- **Safety-critical guards have coverage floors**
  (`check:critical-test-coverage`). When changing them (outreach gate, tone,
  policy checks, caps, etc.), add or extend unit tests.
- **GitHub Actions are pinned to full commit SHAs** (`check:workflow-pinning`).
- Monitoring assets, the rollout contract, compose hardening and the Prisma
  offline stub each have their own `check:*` script. Run the relevant one when
  touching `ops/`, `docker-compose*.yml` or `packages/db/prisma/offline-client`.

## Conventions

- **Multi-tenant:** every data access is workspace-scoped. Check workspace
  membership/RBAC (see `docs/RBAC.md`) and bound list queries.
- **Human in the loop:** AI-generated content requires approval before
  sending. Don't add paths that send AI output without approval.
- **Secrets:** SMTP/IMAP credentials and MFA secrets are encrypted with
  `EMAIL_ENCRYPTION_KEY`. Never log secrets or tokens.
- **Schema changes:** add a versioned migration under
  `packages/db/prisma/migrations/` (see `docs/MIGRATIONS.md`). Never use
  `prisma db push` against real databases. Run `npm run prisma:generate` after
  editing `schema.prisma`.
- **Unused variables:** eslint only allows them when they are prefixed with `_`.
- **Commits and PR titles use Conventional Commits with a scope**, e.g.
  `fix(api): ...`, `feat(discovery): ...`, `ci(release): ...`.

## Before pushing

At minimum run `npm run lint`, `npm run typecheck`, `npm test` and any
`check:*` script covering what you touched. `npm run verify` is the full CI
gate.
