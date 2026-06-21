# Deployment

How to deploy ACAOS to production. This is the operator quick-path; it links out
to the deeper references rather than duplicating them.

- Environment variables → [`docs/PRODUCTION_ENV_VARS.md`](./PRODUCTION_ENV_VARS.md)
- Day-2 operations & incident response → [`docs/OPERATIONS.md`](./OPERATIONS.md), [`docs/RUNBOOKS.md`](./RUNBOOKS.md)
- Secret/key rotation → [`docs/KEY_ROTATION.md`](./KEY_ROTATION.md)
- Local build details → [`BUILD.md`](../BUILD.md)

## Topology

Three deployable services from one repo:

| Service | Image | Entry | Notes |
|---|---|---|---|
| `api` | `Dockerfile.api` | `node scripts/start-with-migrations.mjs` | Runs migrations, then the Express API. The **only** migration writer. |
| `worker` | `Dockerfile.worker` | worker `start` | BullMQ consumer. Never runs migrations. |
| `web` | `Dockerfile.web` | nginx (unprivileged, port 8080) | Static SPA; talks to the API. |

Backing services: PostgreSQL 14+ and Redis 6+.

## 1. Required environment

Set the production env vars from [`docs/PRODUCTION_ENV_VARS.md`](./PRODUCTION_ENV_VARS.md).
At minimum the app fails fast without: `DATABASE_URL`, `JWT_SECRET`,
`EMAIL_ENCRYPTION_KEY` (64 hex chars), and `REDIS_URL` for the worker. Generate
secrets with `openssl rand -hex 32`. Never reuse the local-only placeholders from
the compose files.

## 2. Build

CI builds and Trivy-scans the real images on every push. To build locally:

```bash
docker build -f Dockerfile.api    -t acaos-api    .
docker build -f Dockerfile.worker -t acaos-worker .
docker build -f Dockerfile.web    -t acaos-web    --build-arg VITE_API_BASE_URL=https://api.example.com .
```

(Or `npm ci && npm run prisma:generate && npm run build` for a non-Docker build.)

## 3. Migrations

Migrations are **versioned** (`prisma migrate deploy`) and run automatically at
API container start by `scripts/start-with-migrations.mjs`:

1. `prisma migrate deploy` applies only pending, reviewed migrations.
2. One-time auto-baseline if the DB predates the migration history (P3005).
3. If migrations cannot be applied the container **exits non-zero and does not
   start** — a half-migrated API is worse than a failed deploy.

Never use `prisma db push` in production (it can drop data). Schema drift is
caught in CI (the "Check for schema drift" step) so the migration history always
matches `schema.prisma`.

## 4. Health checks

Wire your platform's probes to:

| Endpoint | Purpose | Probe |
|---|---|---|
| `GET /api/live` | process is up (no I/O) | liveness |
| `GET /api/ready` | config valid + Postgres reachable (Redis reported, non-fatal) → 200/503 | readiness / LB gate |
| `GET /api/ready/strict` | config valid + Postgres **and** Redis reachable → 200/503 | LB gate for Redis/BullMQ-dependent deployments |
| `GET /api/health` | DB + Redis status | dashboards |

Use `/api/ready` when the service can tolerate a transient Redis outage (rate
limiting degrades gracefully); use `/api/ready/strict` when critical flows are
Redis/BullMQ-backed and serving traffic without Redis is worse than briefly
shedding it.

Build/version metadata (commit SHA, build time, version) is exposed on `/metrics`
and baked into the images via the `ACAOS_RELEASE_*` build args.

## 5. Worker startup

Deploy the worker with the same `DATABASE_URL`/`REDIS_URL` and
`EMAIL_ENCRYPTION_KEY` as the API. It exposes a health server on
`WORKER_HEALTH_PORT` (default 9090): `/live`, `/ready`, and a token-guarded
`/metrics`. Scale workers horizontally; they coordinate through Redis/BullMQ.

## 6. Rollback

1. Redeploy the previous image tag for `api`, `worker`, and `web`.
2. **Migrations are forward-only.** A new release that added a migration is not
   automatically reverted by rolling back the image. Prefer expand/contract
   (backward-compatible) migrations so the prior image still runs against the new
   schema. If a migration must be undone, apply a new corrective migration rather
   than hand-editing the database.
3. Confirm `/api/ready` is green and error rates are normal (see
   [`docs/RUNBOOKS.md`](./RUNBOOKS.md)).

## 7. Post-deploy verification

- `GET /api/ready` → 200 on every API instance.
- `post-deploy-smoke` workflow (`.github/workflows/post-deploy-smoke.yml`)
  validates readiness after a release.
- Watch the dashboards/alerts in [`ops/monitoring/`](../ops/monitoring/) and the
  SLOs in [`docs/SLO.md`](./SLO.md).
