# Operations & Observability

How to run ACAOS in production: health gating, metrics, error reporting, load
testing, and the performance knobs. Pairs with [`LAUNCH_RUNBOOK.md`](./LAUNCH_RUNBOOK.md)
(deploy steps) and [`PRODUCTION_ENV_VARS.md`](./PRODUCTION_ENV_VARS.md) (full env list).

## Health & readiness probes (API)

Three endpoints, by purpose:

| Endpoint | Checks | Use for |
|---|---|---|
| `GET /api/live` | process is up (no I/O) | liveness probe / frequent polling |
| `GET /api/ready` | required config **+ DB**; reports Redis | deployment gate (readinessProbe, LB) |
| `GET /api/health` | DB reachable; reports Redis | general health/status page |

`/api/ready` returns `{ ok, db, redis, config }` and **200/503**. **Redis is
reported but non-fatal**: the rate limiter degrades to an in-process fallback, so
a Redis blip must not pull a serving pod out of rotation — only config + DB gate
readiness. All probes time out at 3s so a hung dependency can't stall the probe.

**Worker** exposes its own liveness server on `WORKER_HEALTH_PORT` (default 9090).

### Kubernetes example

```yaml
livenessProbe:  { httpGet: { path: /api/live,  port: 4000 }, periodSeconds: 10 }
readinessProbe: { httpGet: { path: /api/ready, port: 4000 }, periodSeconds: 10, failureThreshold: 3 }
```

## Metrics (Prometheus)

`GET /metrics` serves the Prometheus text exposition (v0.0.4) — no `prom-client`
dependency. Exposed series:

- `http_requests_total{method,route,status}` — counter
- `http_request_duration_seconds{method,route}` — histogram (`_bucket`/`_sum`/`_count`)
- `http_requests_in_flight` — gauge
- `process_resident_memory_bytes`, `nodejs_process_uptime_seconds` — gauges

Labels use the **matched route pattern** (e.g. `/api/leads/:id`), never raw URLs,
so cardinality stays bounded. The endpoint is registered before the rate limiter
(scrapes aren't throttled).

**Auth:** set `METRICS_TOKEN` to require `Authorization: Bearer <token>` on
`/metrics`. Leave unset only on a private network / in dev.

```yaml
# prometheus scrape_config
- job_name: acaos-api
  authorization: { credentials: "${METRICS_TOKEN}" }
  static_configs: [{ targets: ["acaos-api:4000"] }]
```

Suggested alerts: 5xx rate (`http_requests_total{status=~"5.."}`), p99 latency
(histogram quantile), and sustained `http_requests_in_flight` (saturation).

## Error reporting (Sentry — optional)

Unhandled errors flow through a single `captureError` seam, wired in both the API
(Express error handler + `unhandledRejection`/`uncaughtException`) and the worker
(failed-after-retries + `error` + process handlers).

To deliver them to Sentry:

1. `npm i @sentry/node` in `apps/api` (it's an **optional** dependency — the build
   never requires it).
2. Set `SENTRY_DSN`.

With no DSN (or the SDK absent) error reporting is a **no-op** and the app behaves
exactly as in dev/CI — telemetry never crashes startup. Any transport can be
substituted by calling `setErrorReporter()` instead of `initErrorReporting()`.

## Load testing

A dependency-free harness boots the real API against live Postgres + Redis and
drives the hot endpoints, reporting RPS + p50/p95/p99 + error rate:

```bash
JWT_SECRET=<32+ chars> DATABASE_URL=... REDIS_URL=... npm run loadtest
```

Tunables: `LOADTEST_CONCURRENCY` (default `10,50,100`), `LOADTEST_DURATION_MS`
(4000), `LOADTEST_PORT` (4100), `LOADTEST_REQUEST_TIMEOUT_MS` (10000).

> Numbers are **relative** (find slow endpoints / error cliffs / lock contention),
> not deployment-accurate SLOs — a single host is not production hardware. Run it
> against production-sized infra for capacity numbers.

## Performance knobs

- **DB connection pool** — append `?connection_limit=N&pool_timeout=20` to
  `DATABASE_URL`. Default is `num_cpus*2+1` per process; size it so
  `pods × connection_limit` stays under Postgres `max_connections` (and the
  pgbouncer limit if used). Under high concurrency this is the usual cause of
  tail latency; raise it (and `max_connections`) together.
- **`DIRECT_URL`** — set when `DATABASE_URL` points at PgBouncer, so migrations
  bypass the pooler.
- **Indexing** — list endpoints are indexed for their default ordering
  (e.g. leads by `(workspaceId, score, createdAt)`). Add a composite index before
  introducing a new hot sort/filter; verify with `EXPLAIN ANALYZE` that the plan
  is an index scan, not a Seq Scan + Sort.
- **Rate limiting** — Redis-backed (`generalRateLimit`, `authRateLimit`) with an
  in-process fallback. `RATE_LIMIT_DISABLED=true` is for tests/load runs only;
  never in production.

## Quick reference

| Concern | Where |
|---|---|
| Liveness / readiness | `GET /api/live` · `/api/ready` · `/api/health` |
| Metrics | `GET /metrics` (+ `METRICS_TOKEN`) |
| Error transport | `SENTRY_DSN` + `npm i @sentry/node` |
| Load test | `npm run loadtest` |
| Pool sizing | `DATABASE_URL?connection_limit=…` |
| Deploy steps | [`LAUNCH_RUNBOOK.md`](./LAUNCH_RUNBOOK.md) |
| All env vars | [`PRODUCTION_ENV_VARS.md`](./PRODUCTION_ENV_VARS.md) |
