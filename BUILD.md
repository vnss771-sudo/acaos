# Building & Running ACAOS

ACAOS is a TypeScript **npm-workspaces monorepo** (Node 20+, ESM). This guide covers
local development, the production build, Docker, and how the shared `@acaos/backend-core`
package resolves at build/dev/test/runtime.

```
apps/api/         Express API            → dist/server.js
apps/worker/      BullMQ worker          → dist/worker.js
apps/web/         React + Vite frontend  → dist/ (static)
packages/db/      Prisma schema + migrations (PostgreSQL)
packages/shared/  Typed API contracts (type-only, shared by api + web)
packages/backend-core/  Shared backend runtime (prisma, scoring, mail, queues, …)
                        used by BOTH api and worker
```

---

## 1. Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | **20+** (CI uses 22) | ESM + `--conditions` support required |
| npm | 10+ | workspaces |
| PostgreSQL | 14+ | only for running the app / `test:db` |
| Redis | 6+ | only for running the worker / `test:redis` |
| Docker | optional | for the one-command full stack / prod images |

---

## 2. Quick start (local dev)

```bash
cp .env.example .env          # fill in required values (see §5)
npm install                   # installs all workspaces
npm run prisma:generate       # generate the Prisma client
npm run prisma:migrate        # apply migrations to your dev DB

# Run each in its own terminal:
npm run dev:api               # http://localhost:4000
npm run dev:worker            # background queues (needs Redis)
npm run dev:web               # http://localhost:5173
```

`dev:*` run under `tsx` with `NODE_OPTIONS=--conditions=acaos-src` (wired into the
scripts), so `@acaos/backend-core` resolves to its **TypeScript source** — no build
step is needed for development.

---

## 3. Production build

```bash
npm run build      # builds backend-core → api → worker → web
```

What it produces:
- `packages/backend-core/dist/` — compiled shared runtime (JS + `.d.ts`)
- `apps/api/dist/server.js`
- `apps/worker/dist/worker.js`
- `apps/web/dist/` — static assets

Each app's build runs `prisma generate` and compiles `backend-core` first, then
itself — so a clean `npm run build` works with no prior setup. To run a single
service's build (as the Docker images do):

```bash
npm run build -w @acaos/api       # or @acaos/worker
```

### Run the built artifacts

```bash
# API (runs migrations first, then serves)
npm run start:prod                       # = node scripts/start-with-migrations.mjs
# Worker
npm --workspace @acaos/worker run start  # = node apps/worker/dist/worker.js
# Web: serve apps/web/dist/ behind any static host / nginx
```

At runtime (compiled `node`), `@acaos/backend-core` resolves to its `dist/` via the
package's conditional `exports` (`default`). No `NODE_OPTIONS` flag is needed in prod.

---

## 4. Docker

One command for the full stack (Postgres + Redis + api + worker + web on :8080):

```bash
docker compose up --build
```

Hot-reloading dev loop (source bind-mounted): `docker compose -f docker-compose.local.yml up`.

The production images Railway deploys are built from the root Dockerfiles:

```bash
docker build -f Dockerfile.api    -t acaos-api    .
docker build -f Dockerfile.worker -t acaos-worker .
docker build -f Dockerfile.web    -t acaos-web    .
```

Each Dockerfile copies only the workspaces it needs (incl. `packages/backend-core`),
runs `npm ci --include=dev`, generates the Prisma client, and builds that service.

---

## 5. Environment variables

See **`.env.example`** for the full, commented list. Required in production:

| Variable | Purpose |
|---|---|
| `JWT_SECRET` | Token signing (strong random string) |
| `EMAIL_ENCRYPTION_KEY` | AES-256 key for workspace SMTP/IMAP credentials |
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection string |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | Billing + webhook validation |
| `APP_URL` | Public URL of the web app (used in email links) |

Optional: `OPENAI_API_KEY` (research/outreach/reply AI), `APOLLO_API_KEY` /
`GOOGLE_PLACES_API_KEY` / `HUNTER_API_KEY` (discovery), `SENTRY_DSN` (error capture),
`METRICS_TOKEN` (bearer-gate `/metrics`).

Optional tuning (sensible defaults — see `.env.example`):

| Variable | Default | Purpose |
|---|---|---|
| `STEP_UP_MAX_AGE_MIN` | `15` | Freshness window (min) for step-up re-auth on sensitive mutations (billing, admin promotion, MFA disable). |
| `STATS_CACHE_TTL_MS` | `5000` | `/api/stats` single-flight cache TTL (`0` = pure single-flight). |
| `RETENTION_PURGE_INTERVAL_MS` | `86400000` | How often the worker runs the data-retention purge. |
| `RETENTION_*_DAYS` | per policy | Per-class retention windows (override `docs/DATA_RETENTION.md`). |

> **MFA secrets** are encrypted at rest with the same `EMAIL_ENCRYPTION_KEY` — see
> the rotation caveat in `docs/KEY_ROTATION.md` before rotating that key.

`npm run prisma:migrate` applies all migrations, including the MFA/step-up
`User` columns — no manual schema steps are needed.

### Operations & monitoring

Ready-to-use Prometheus/Grafana/Alertmanager + blackbox uptime assets ship in
[`ops/monitoring/`](ops/monitoring/); SLOs and per-alert runbooks are in
[`docs/SLO.md`](docs/SLO.md) and [`docs/RUNBOOKS.md`](docs/RUNBOOKS.md). Full
operator guide: [`docs/OPERATIONS.md`](docs/OPERATIONS.md).

---

## 6. Verify (CI gates)

```bash
npm run verify             # one-shot: boundaries + mutations + lint + typecheck + tests + web + build
# …or run individual gates:
npm run check:boundaries   # worker must not import apps/api (architectural guard)
npm run typecheck          # shared + backend-core + api + web + worker
npm run test               # fast unit/integration suite (no external services)
npm run test:coverage      # same, with the 80/65/80 coverage gate
npm run test:web           # frontend (Vitest)
npm run test:db            # needs PostgreSQL (test:db:local boots an ephemeral one)
npm run test:redis         # needs Redis   (test:redis:local boots ephemeral PG+Redis)
npm run test:e2e           # Playwright (run npm run test:e2e:install once first)
```

Test/`tsx` commands carry `NODE_OPTIONS=--conditions=acaos-src` so they resolve
`@acaos/backend-core` to source — no build required to run the suites.

---

## 7. How `@acaos/backend-core` resolves (one model, three tools)

`backend-core` is shared **runtime** code, so unlike the type-only `@acaos/shared`
it must load under tsc, tsx and node. Its `package.json` uses conditional subpath
exports:

```jsonc
"./lib/*.js":      { "acaos-src": "./src/lib/*.ts",      "default": "./dist/lib/*.js" }
"./services/*.js": { "acaos-src": "./src/services/*.ts", "default": "./dist/services/*.js" }
```

- **tsc** (typecheck): tsconfigs set `"customConditions": ["acaos-src"]` → source `.ts` (no dist needed).
- **tsx** (dev + tests): run with `NODE_OPTIONS=--conditions=acaos-src` → source `.ts` (no build needed).
- **node** (prod): no condition → `default` → compiled `dist/*.js` (build emits it).

Inside `backend-core`, modules import each other with relative paths, so they work
identically from `src` and `dist`. The API keeps thin re-export shims at the old
`apps/api/src/lib|services/*` paths so existing imports resolve unchanged.

---

## 8. Repackaging this source archive

```bash
npm run pack        # writes dist-pack/acaos-source.zip (tracked files only)
```
