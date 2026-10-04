# Live check — 4 October 2026

A check of the running ACAOS deployment on Railway: what's broken, what's at
risk, and what's fine. Evidence comes from Railway's deploy, HTTP and build logs
and service settings for the past 7 days, checked against the code on `master`
(`dca5306`).

**Where the live stack is:** Railway project **ACAOS**, environment **`Acaos `**
(the name ends in a space). The `production` environment in the same project is
empty.

| Service | Public URL | Latest deploy |
|---|---|---|
| `@acaos/api` | `acaosapi-acaos.up.railway.app` | `dca5306`, SUCCESS, 4 Oct 05:12 UTC |
| `@acaos/web` | `acaosweb-acaos.up.railway.app` | `dca5306`, SUCCESS |
| `@acaos/worker` | (no public URL) | `dca5306`, SUCCESS |
| Postgres 18, Redis 8.2.9 | private network only | running since 12–13 Sep |

**Limits of this check.** The check could not reach the URLs above directly:
the network policy of the environment running it blocks `*.up.railway.app`. So
no signup, login or UI walkthrough was run, and the findings come from logs and
settings only. It also could not read the worker's settings or any variable
values (blocked as production secrets). Variable *names* were read for the API
and web services.

---

## Summary

| # | Severity | Problem |
|---|---|---|
| 1 | 🔴 Critical | Worker can't reach the database: every background job that touches the DB has failed for at least 6 days |
| 2 | 🔴 High | Stripe rejects the configured live secret key, so billing and checkout can't work |
| 3 | 🔴 High | "Find work" is switched off on the server; **Run now** returns 503 |
| 4 | 🟠 Medium | The repo's `railway.toml` files aren't applied: the API isn't built from `Dockerfile.api` and no service has a health check |
| 5 | 🟠 Medium | Railway deploys every `master` push without waiting for CI |
| 6 | 🟠 Medium | No alerting: no Sentry, `/metrics` off, no uptime probe, job failures logged as `info` |
| 7 | 🟠 Medium | The worker reports commit `unknown`, so release drift checks can't verify it |
| 8 | 🟡 Low | API database pool size not set |
| 9 | 🟡 Low | Redis persistence: only RDB snapshots seen; AOF not confirmed |
| 10 | 🟡 Low | Log noise tagged as errors; nginx starts 48 worker processes in a 4-vCPU container |
| 11 | 🟡 Low | **Today** uses a 403 as a normal "not opted in" answer |
| 12 | ⚪ Info | Naming: the live environment isn't `production`; launch checklist items still open |

---

## 1. 🔴 Worker can't reach the database

**What happens.** Every worker job that queries Postgres fails before it runs:

```
Error validating datasource `db`: the URL must start with the protocol
`postgresql://` or `postgres://`.
  -->  schema.prisma:12
12 |   url = env("DATABASE_URL")
```

This appears in every retained worker log, from 28 Sep (the oldest available) to
now. Scheduled jobs seen failing:

| Job | Schedule | Effect |
|---|---|---|
| `auto-imap-sync` (`sync-mailbox`) | every 10 min (~144 failures a day) | No replies are pulled in, so **Inbox** never fills and reply classification never runs |
| `daily-retention-purge` | daily | Retention deletes (`processedEmail`, `outreachSent`, `processedStripeEvent`) never run, so the [data retention policy](DATA_RETENTION.md) isn't enforced |
| `domain-health-sweep` | periodic | Sending-domain health is never refreshed |

Any job a user triggers that reads the database (research, scoring, outreach
drafts, campaign sends, work discovery) will hit the same error.

**Cause.** The worker's own `DATABASE_URL` variable is malformed: empty, quoted,
or an unresolved reference. The API's copy is fine: its logs show
`postgres.railway.internal:5432` and migrations applying. The value couldn't be
read to confirm which.

**Fix.** On the worker service, set `DATABASE_URL` to `${{Postgres.DATABASE_URL}}`
(the same reference the API uses), redeploy, and check the next `auto-imap-sync`
run completes.

**Why nobody noticed.** The worker's `/ready` only checks Redis
(`apps/worker/src/worker.ts:737`). The worker never calls `validateConfig()`, job
failures are logged at `info` (`worker.ts:84,521`), and there's no Sentry (see
#6). So every deploy shows SUCCESS and the service looks healthy.

## 2. 🔴 Stripe rejects the live secret key

Every API boot (41 in the past week) logs:

```
Stripe price check failed: STRIPE_PRICE_STARTER … does not resolve against the
configured STRIPE_SECRET_KEY
err: "Invalid API Key provided: sk_live_…"
```

The same error appears for `STRIPE_PRICE_GROWTH`. The message blames the price
IDs, but the underlying error is that **Stripe doesn't accept the key itself**:
it's been revoked, rolled, or mistyped. So checkout, the billing portal, and any
webhook handler that calls back into Stripe will fail.

**Fix.** Create or restore a valid secret key in the Stripe dashboard and set
`STRIPE_SECRET_KEY` on the API. If the app isn't taking payments yet, use the
test-mode key. Either way, the `STRIPE_PRICE_*` IDs (on the API, and the
`VITE_STRIPE_PRICE_*` on web) must come from the same mode as the key. After
redeploying, the boot log should no longer show the price-check error.

## 3. 🔴 "Find work" is switched off

`POST /api/opportunities/run` returned **503** both times a user pressed it (28 Sep
23:28 and 3 Oct 23:41 UTC). These are the only 5xx responses the API served all
week. The route throws 503 unless `OPPORTUNITY_DISCOVERY_ENABLED=true`
(`apps/api/src/routes/opportunities.ts:282`), and the API has no such variable.
The worker's scheduled sweep is gated by the same flag (`worker.ts:484`). So the
main contractor-loop feature (tenders and development applications every
morning) is off in the live app.

**Fix.** Set `OPPORTUNITY_DISCOVERY_ENABLED=true` on both API and worker, after
fixing #1, since discovery runs in the worker. Also add the flag to
[GO_LIVE_CHECKLIST](GO_LIVE_CHECKLIST.md) §1. It's listed only in
[CONFIGURATION](CONFIGURATION.md), so it's easy to miss.

## 4. 🟠 The repo's `railway.toml` files aren't applied

`apps/api/railway.toml`, `apps/web/railway.toml` and `apps/worker/railway.toml`
set a Dockerfile build, a health-check path and a restart policy. Railway
only reads a `railway.toml` at the service's root directory (here the repo root,
which has none) unless a config-file path is set. The live API service shows:

- **Builder: Railpack**, not `Dockerfile.api`. So the API isn't running the
  CI-built image: the one that's Trivy-scanned, pinned to a Node digest and run as
  a non-root `node` user.
- **No health-check path.** Railway marks a deploy live without `/api/ready`
  passing.

The web service uses `Dockerfile.web` (set in the dashboard) but also has no
health check. The worker's settings couldn't be read.

**Fix.** In each service's settings, set the config-as-code path to
`apps/<service>/railway.toml`, or copy the builder and health-check settings into
the dashboard by hand. On its own this wouldn't have caught #1: see the
`/ready` note there.

## 5. 🟠 Deploys don't wait for CI

"Wait for CI" (`checkSuites`) is off on the API and web services, so every push
to `master` deploys straight away. On 4 Oct, commit `7a90117` (#347) was deployed
and **failed to build** on the API and worker (TypeScript `TS2550`). The fix
followed 15 minutes later. No outage this time, because the previous containers
kept running. But a commit that builds and still fails tests would go live.

**Fix.** Turn on "Wait for CI" for the API, worker and web services.

## 6. 🟠 No alerting

- `SENTRY_DSN` isn't set on the API, so `captureError` does nothing.
- `METRICS_TOKEN` isn't set, so `/metrics` is disabled. This is logged on every
  boot.
- Nothing external checks the app. A week of API HTTP logs has no requests to
  `/api/live`, `/api/ready` or `/api/ready/strict`, so the probes in
  `ops/monitoring/` aren't pointed at this deployment.
- Worker job failures are logged at `info`. A severity-based alert would never
  fire on them (`apps/worker/src/worker.ts:84-85`).

Together, these are why #1 has gone unnoticed for at least six days.

**Fix.** Set `SENTRY_DSN` and `METRICS_TOKEN` on the API and worker, and point an
uptime check at `https://acaosapi-acaos.up.railway.app/api/ready/strict`. In code,
log `worker.on('failed')` at `warn`/`error`.

## 7. 🟠 The worker reports commit `unknown`

| Service | `releaseId` reported | Source |
|---|---|---|
| api | `0.0.0-dev+dca5306cc891`, `buildTime: null` | Railpack build; commit picked up from `RAILWAY_GIT_COMMIT_SHA` |
| worker | `0.0.0-dev+unknown`, `commit: "unknown"` | `Dockerfile.worker` |

`Dockerfile.worker` (and `Dockerfile.api`) default `ACAOS_RELEASE_SHA=unknown`.
`getRuntimeMetadata` (`packages/backend-core/src/lib/release.ts:29-32`) treats
`"unknown"` as a real value, so it never falls back to Railway's
`RAILWAY_GIT_COMMIT_SHA`. As a result, `npm run smoke:deploy` with
`expected_commit`/`expected_release_id` can't verify the worker, and logs can't
tell which code it's running.

**Fix (code).** Treat `unknown` as unset in `readEnv`, or drop the `unknown`
defaults from the Dockerfiles.

## 8. 🟡 API database pool size not set

Every boot logs `DATABASE_URL has no connection_limit set in production`. The
API falls back to its built-in `DB_POOL_SIZE`. That's fine at today's traffic of
about 85 requests a day, but size it deliberately per
[OPERATIONS](OPERATIONS.md) before launch.

## 9. 🟡 Redis persistence

Redis logs show an RDB snapshot every minute ("1 changes in 60 seconds.
Saving…"). [RECOVERY](RECOVERY.md) recommends AOF (`appendonly yes`) so a
restart doesn't drop queued jobs. Couldn't confirm whether AOF is on; check the
Redis service's start command or config.

## 10. 🟡 Log noise tagged as errors

- `npm warn config production Use --omit=dev instead.`: 237 lines a week at
  `error` severity, from the API start script running `npm`.
- nginx `[notice]` start-up lines go to stderr and show as errors. nginx also
  starts **48 worker processes** in a container capped at 4 vCPUs, because
  `worker_processes auto` counts the host's CPUs. That wastes memory; set
  `worker_processes 4;` or similar.
- Postgres logs `SSL error: unexpected eof while reading` in bursts of 4–5 at
  each API boot, from the Prisma CLI processes in the start script exiting
  without a TLS close. Harmless, but it hides real errors when filtering.

## 11. 🟡 **Today** uses a 403 as a normal answer

**Today** probes `GET /api/commercial-opportunities/network-benchmarks` for admins
and reads a 403 as "not opted in" (`apps/web/src/views/Today.tsx:109`). That's by
design, but every admin page load adds 4xx warnings to the logs and metrics. A
`200 { optedIn: false }` answer would keep the error rate meaningful.

## 12. ⚪ Housekeeping

- The live environment is named `Acaos ` with a trailing space, and the
  `production` environment is empty. Tools that default to `production` (the
  Railway CLI, MCP and API) find nothing. Rename the environment, or move the
  stack.
- Launch checklist items still open (expected pre-launch): no custom domain
  (the app runs on `*.up.railway.app`); Google/Microsoft mailbox sign-in not
  configured; `COMPLIANCE_GATE_ENABLED`, `SAFE_LAUNCH_MODE` and
  `REPUTATION_GUARD_MODE` left at their defaults.

---

## What's working

- **API is up and responsive.** 589 requests in 7 days: 348 2xx, 226 304
  (cache hits), 13 4xx, and 2 5xx (both #3). In the 301 requests sampled from the
  HTTP log, the slowest took 169 ms (`/api/auth/refresh`) and most took under 100 ms.
- **Database schema is current.** 101 migrations and "No pending migrations to
  apply" on the latest boot. Raw-SQL indexes verified. A one-off `P3005` on 28 Sep
  was handled by the start script's baseline step, which then applied every
  migration.
- **Web is healthy.** 226 requests, no 4xx or 5xx.
- **Real sessions run cleanly.** Signed-in browser sessions loaded **Today**,
  opportunities, campaigns, stats, delivery quotes, signals and missions without
  errors. The `401`s on `/api/auth/refresh` are expired sessions, as
  expected.
- **Postgres and Redis are running.** Both services have been up since 12–13 Sep,
  each on a 50 GB volume.

## Fix order

1. Worker `DATABASE_URL` → `${{Postgres.DATABASE_URL}}` (#1). Confirm
   `auto-imap-sync` succeeds.
2. Valid `STRIPE_SECRET_KEY`, with price IDs from the same mode (#2).
3. `OPPORTUNITY_DISCOVERY_ENABLED=true` on API and worker (#3).
4. Health checks and the Dockerfile builder via the `railway.toml` config paths,
   plus "Wait for CI" (#4, #5).
5. `SENTRY_DSN`, `METRICS_TOKEN`, and an uptime probe on `/api/ready/strict` (#6).
6. Code changes, which can go in one PR: worker DB check at boot and in
   `/ready`, failed jobs logged at `warn`/`error`, the `unknown` release-SHA
   fallback, and nginx `worker_processes` (#1, #6, #7, #10).

To re-run with live HTTP smoke tests (`npm run smoke:deploy`, the Playwright
`e2e` suite against the live URLs), allow `acaosapi-acaos.up.railway.app` and
`acaosweb-acaos.up.railway.app` in the cloud environment's network settings.
