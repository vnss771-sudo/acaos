# Operations & Observability

How to run ACAOS in production: health gating, metrics, error reporting, load
testing, and the performance knobs. Pairs with [`LAUNCH_RUNBOOK.md`](./LAUNCH_RUNBOOK.md)
(deploy steps) and [`PRODUCTION_ENV_VARS.md`](./PRODUCTION_ENV_VARS.md) (full env list).

## Health & readiness probes (API)

Four endpoints, by purpose:

| Endpoint | Checks | Use for |
|---|---|---|
| `GET /api/live` | process is up (no I/O) | liveness probe / frequent polling |
| `GET /api/ready` | required config **+ DB**; Redis gates in production | deployment gate (readinessProbe, LB) |
| `GET /api/ready/strict` | required config **+ DB + Redis**, in every environment | LB gate for deployments where serving traffic with Redis down is worse than briefly shedding it |
| `GET /api/health` | DB reachable; reports Redis | general health/status page |

`/api/ready` returns `{ ok, db, redis, config }` and **200/503**. **Redis is
non-fatal outside production only** — in `development`/`test` the rate limiter's
in-process fallback is judged good enough and a Redis blip doesn't affect
readiness. **In production, Redis DOES gate `/api/ready`**: the queue-backed
flows (outreach, campaign send, mailbox sync) can't run without it, so a Redis
outage there fails the probe (503) and pulls the pod out of rotation — the same
config+DB-only leniency does not apply (`server.ts`'s `/api/ready` handler). Use
`/api/ready/strict` (below) when you want that same Redis-required behavior
outside production too. All probes time out at 3s so a hung dependency can't
stall the probe.

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

### Worker metrics

The worker serves its own `/metrics` on `WORKER_HEALTH_PORT` (default 9090), gated
by the same optional `METRICS_TOKEN`:

- `worker_jobs_total{queue,result}` — jobs completed/failed (failures counted after
  retries are exhausted)
- `worker_job_duration_seconds{queue}` — processing-time histogram
- `bullmq_queue_jobs{queue,state}` — live queue depth per state (waiting, active,
  delayed, failed, …), pulled on scrape

Suggested alert: sustained `bullmq_queue_jobs{state="waiting"}` on `send-campaign`
(a stuck send queue = unsent outreach), and any growth in `{state="failed"}`.

### Multi-replica metric aggregation

Every counter/gauge above is computed **in-process** — there is no shared
Prometheus registry (`renderMetrics()`/`renderWorkerMetrics()` in
`lib/metrics.ts` read from plain in-memory maps). Running more than one API
or worker replica means a single `/metrics` scrape only ever sees that one
replica's numbers. Getting a correct fleet-wide dashboard/alert needs two
things:

1. **Scrape every replica as its own target.** `prometheus.yml`'s
   `static_configs` must list each replica (or use `dns_sd_configs`/your
   platform's service discovery) — never a single load-balanced hostname. A
   scrape that round-robins across replicas makes every counter look like it
   resets/jumps at random, which breaks `rate()`/`increase()` regardless of
   the query used downstream. See the comment block at the top of
   `ops/monitoring/prometheus.yml`.
2. **Aggregate with the right function**, because not every series means the
   same thing across replicas:
   - **Per-process counters** (`http_requests_total`, `worker_jobs_total`,
     `acaos_send_outcomes_total`, `acaos_ai_cost_cents_total`, …) — each
     replica only counts what it personally handled, so `sum(rate(...))`
     across replicas gives the true fleet rate. This is what `alerts.yml`
     and the Grafana dashboard already do for these.
   - **Gauges sourced from state every replica sees identically** —
     `bullmq_queue_jobs` (read from the shared Redis queue) and the worker's
     DB-derived deliverability snapshot (`acaos_followup_*`,
     `acaos_sender_*`, `acaos_warmup_*`) are recomputed by *every* worker
     replica on its own scrape and come out the same. **`sum()` here
     multiplies the true value by the replica count** — use `max()` (or
     `min()`/`avg()`; they're equivalent up to scrape-timing jitter) instead.
   - **Genuinely per-replica in-memory state** — `acaos_circuit_open` (each
     process's own provider circuit breaker) — use `max()` to mean "open on
     at least one replica," the actionable signal for that alert.

`ops/monitoring/recording_rules.yml` pre-computes the correct form of every
series above as `job:*` rules — prefer those in new dashboards/alerts over
re-deriving the aggregation function each time. `alerts.yml`'s rules already
use the right function per series (`max()` on the Redis/DB-shared gauges,
`sum(rate())` on the per-process counters).

A **push-gateway pattern was considered and rejected** for the worker: the
worker runs as a long-lived process with a continuously-scraped `/metrics`
(`WORKER_HEALTH_PORT`), not a short-lived batch job that could vanish between
scrapes — the scrape-and-aggregate approach above is the right fit, not
push-gateway's "push before exit."

### Ready-to-use monitoring assets

[`ops/monitoring/`](../ops/monitoring/) ships an importable Grafana dashboard,
Prometheus alert rules (5xx rate, p99 latency, saturation, send-campaign backlog,
job failures, target down), replica-aggregation recording rules
(`recording_rules.yml`), and a scrape config wired to these exact series — see
[`ops/monitoring/README.md`](../ops/monitoring/README.md).

## Error reporting (Sentry — optional)

Unhandled errors flow through a single `captureError` seam, wired in both the API
(Express error handler + `unhandledRejection`/`uncaughtException`) and the worker
(failed-after-retries + `error` + process handlers). Every error is logged via the
structured logger regardless of Sentry — this section is about *aggregation*, not
whether errors are visible at all.

To deliver them to Sentry, just **set `SENTRY_DSN`**. `initErrorReporting()`
(`lib/errorReporting.ts`) posts directly to Sentry's HTTP ingest API via a minimal
built-in transport (`lib/sentryTransport.ts`, rate-limited + deduped so an error
storm can't become a fetch storm) — there is no `@sentry/node` SDK to install. It
was deliberately built this way instead of depending on the real SDK: `@sentry/node`
pulls in a heavy, recurringly-vulnerable OpenTelemetry dependency tree that would
otherwise sit in `dependency-review` on every PR for a capability most deployments
only turn on in production.

With no DSN, error reporting is a **no-op** and the app behaves exactly as in
dev/CI — telemetry never crashes startup. Any transport can be substituted by
calling `setErrorReporter()` directly instead of `initErrorReporting()`.

## Distributed tracing (OpenTelemetry — optional)

The core outreach flow crosses three processes: an API route enqueues a BullMQ
job, a worker picks it up, and the worker calls out to an AI provider / SMTP /
Postgres. Correlating "why was this campaign send slow" across those three
previously meant grep-ing three log streams by `requestId` (still true — see
below). `lib/tracing.ts` adds real distributed tracing on top of that: a span
is created where a route enqueues a job (`withEnqueueSpan`, wired into every
`enqueue*` in `lib/queues.ts`), its W3C `traceparent` is stamped onto the job
payload (`queueSchemas.ts`'s envelope), and the worker continues the SAME
trace as a child span when it processes the job (`withConsumerSpan`, wired
into every `Worker` in `worker.ts`) — so a tracing backend shows one trace per
request across the whole API → queue → worker journey instead of three
separate spans an operator has to stitch together by hand.

This **complements, not replaces**, the existing `requestId` log correlation:
both are stamped as attributes on every span (`acaos.request_id`,
`acaos.workspace_id`), so an operator can jump from a log line to a trace and
back. A worker-internal job with no originating API request (the daily
retention sweep, the periodic follow-up scan) still gets its own root span
instead of being skipped.

Built on the real `@opentelemetry/api`, but with **manual spans only — no
auto-instrumentation package** (`@opentelemetry/sdk-node`'s per-library
auto-instrumentation meta-package is not a dependency). That mirrors why this
app hand-rolls its own Prometheus metrics and its own minimal Sentry HTTP
transport instead of `@sentry/node` (see above): spans are created by hand at
exactly the two points that matter, so the heavier auto-instrumentation
surface would only add dependency-review weight for nothing this app uses.

**Set `OTEL_EXPORTER_OTLP_ENDPOINT`** to a collector's base URL to export real
spans via OTLP/HTTP. With no endpoint set, every span is a genuine no-op (the
OpenTelemetry API's global tracer is a no-op until a provider is registered)
and no `traceparent` is added to job payloads — tracing never changes
behavior in dev/CI. `OTEL_CONSOLE_EXPORTER=true` prints spans to stdout
instead, for local debugging only (never set it in production).

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
  `DATABASE_URL`, or set `DB_POOL_SIZE` to size it without touching the
  connection string (see `.env.example`). Prisma's own default is
  `num_cpus*2+1` per process, which is unbounded across replicas; if the
  operator sets neither, the app pins `connection_limit` itself (`DB_POOL_SIZE`
  or a built-in default of 10 — `packages/backend-core/src/lib/databaseUrl.ts`)
  instead of opening an unbounded pool. Size it so
  `pods × connection_limit` stays under Postgres `max_connections` (and the
  pgbouncer limit if used). Under high concurrency this is the usual cause of
  tail latency; raise it (and `max_connections`) together.

  **Sizing formula** — every replica of every DB-touching process counts
  against one shared `max_connections` ceiling:

  ```
  total_connections = (api_replicas × api_connection_limit)
                     + (worker_replicas × worker_connection_limit)
                     + migration/admin headroom (2-3)
  ```

  `worker_connection_limit` should cover the worker's actual concurrent DB
  callers, not just "1 per replica": `apps/worker/src/worker.ts` runs several
  BullMQ processors per process, each with its own `concurrency`, and they all
  share the worker's single Prisma pool — sum the per-queue `concurrency`
  values (currently ~24 across all queues) to get the worker's realistic
  ceiling, though most jobs are I/O-bound elsewhere (AI/provider calls) and
  don't hold a DB connection the whole time, so `connection_limit` can safely
  sit well under that sum.

  With PgBouncer in front (`?pgbouncer=true` on `DATABASE_URL`, transaction
  mode), Postgres itself only needs one PgBouncer connection per pooler
  backend, not one per app connection — set PgBouncer's `default_pool_size` to
  the same `total_connections` figure above (that's what actually talks to
  Postgres), and `max_client_conn` generously above it (every app-side
  `connection_limit` connection is a *client* to PgBouncer, cheap to accept and
  queued rather than rejected when the pool is busy). Example for 3 API
  replicas at `connection_limit=10`, 2 worker replicas at `connection_limit=15`,
  and `max_connections=100`: `total_connections = 3×10 + 2×15 + 3 = 63` — leaves
  headroom under 100; set PgBouncer `default_pool_size=63`.
- **`DIRECT_URL`** — set when `DATABASE_URL` points at PgBouncer, so migrations
  bypass the pooler.
- **Indexing** — list endpoints are indexed for their default ordering
  (e.g. leads by `(workspaceId, score, createdAt)`). Add a composite index before
  introducing a new hot sort/filter; verify with `EXPLAIN ANALYZE` that the plan
  is an index scan, not a Seq Scan + Sort.
- **Rate limiting** — Redis-backed (`generalRateLimit`, `authRateLimit`) with an
  in-process fallback. `RATE_LIMIT_DISABLED=true` is for tests/load runs only;
  never in production.

## Incident controls (blast-radius)

- **Global send/AI kill-switches** — `FEATURE_SEND`, `FEATURE_AI` (and the other
  `isFeatureEnabled` flags) stop a capability platform-wide with no deploy. Use when
  the problem is system-wide.
- **Drain a single tenant (isolated)** — set `Workspace.sendSuppressed = true`
  (optionally `sendSuppressedReason`) to halt **all sends for that one workspace**
  without affecting any other tenant. The worker checks it at the top of every send
  batch and returns immediately (counted as `acaos_send_outcomes_total{outcome="WORKSPACE_SUPPRESSED"}`).
  Reverse by setting it back to `false`. Use for an abusive/compromised/over-spending
  tenant when the global kill-switch would be too broad.
  ```sql
  UPDATE "Workspace" SET "sendSuppressed" = true, "sendSuppressedReason" = 'abuse review' WHERE id = '<workspaceId>';
  ```
- **Send-readiness enforcement** — `ENFORCE_SEND_READINESS` (default: on for every
  env except local `development`/`test`) gates sends on SMTP + CAN-SPAM sender
  identity. Leave on; it fails closed so a misconfigured staging deploy can't send
  non-compliant mail.

## Ops module: geofenced clock-in/out

`POST /api/ops/clock/in` and `/out` check the caller's coordinates against the
job site's `radiusMeters` geofence (`ops/utils.ts`'s `geofenceViolationMeters`).
This is **enforced, not merely logged**, whenever both sides have the data to
check it: a clock-in/out outside the radius is rejected with **400** and never
reaches the database.

It is **advisory-only (a silent no-op) when either side lacks GPS data** — the
job site has no `lat`/`lng`/`radiusMeters` configured, or the request carries no
`lat`/`lng`. This is deliberate, not a gap to close: many job sites will never
have GPS configured, and a crew member on a device/browser that can't or won't
share location must still be able to clock in. Do not read "clock-in succeeded
with no coordinates" as the geofence failing to work — it means one side had
nothing to check against.

## Quick reference

| Concern | Where |
|---|---|
| Liveness / readiness | `GET /api/live` · `/api/ready` · `/api/health` |
| Metrics (API) | `GET /metrics` (+ `METRICS_TOKEN`) |
| Metrics (worker) | `GET :WORKER_HEALTH_PORT/metrics` |
| Security policy | [`SECURITY.md`](../SECURITY.md) |
| Error transport | `SENTRY_DSN` (built-in HTTP transport, no SDK install) |
| Distributed tracing | `OTEL_EXPORTER_OTLP_ENDPOINT` (no-op unset) — `lib/tracing.ts` |
| Load test | `npm run loadtest` |
| Pool sizing | `DATABASE_URL?connection_limit=…` |
| Deploy steps | [`LAUNCH_RUNBOOK.md`](./LAUNCH_RUNBOOK.md) |
| All env vars | [`PRODUCTION_ENV_VARS.md`](./PRODUCTION_ENV_VARS.md) |
