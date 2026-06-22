# Runbook: Postgres connection exhaustion

**Severity:** SEV1 if `/api/ready` is failing platform-wide; SEV2 if degraded.

Postgres is a hard dependency. It gates API readiness everywhere
(`/api/ready` requires `pingDatabase()`), and every queue processor and route
goes through Prisma. Running out of connections looks like a partial outage:
some requests/jobs succeed, others time out waiting for a pool slot.

## Symptoms
- `/api/ready` and `/api/health` return 503;
  `acaos_dependency_up{dependency="postgres"} == 0` (intermittently).
- API 5xx spike; p99 latency climbs (requests blocked waiting on a pool slot);
  `http_requests_in_flight` high.
- Prisma errors in logs: `Timed out fetching a new connection from the
  connection pool`, or Postgres `FATAL: sorry, too many clients already` /
  `remaining connection slots are reserved`.
- Worker jobs failing/retrying on DB calls; `worker_jobs_total{result="failed"}`
  rising across multiple queues.

## Impact
- Broad: any DB-backed route or job degrades. Sends can stall mid-batch (the
  claim-first outbox transaction can't get a connection).

## Immediate mitigation
1. **Find the leak vs. the load.** In `psql`:
   `SELECT count(*), state FROM pg_stat_activity GROUP BY state;` — many `idle in
   transaction` rows point at a leaked/long transaction; many `active` points at
   genuine load or a slow query.
2. Kill obvious offenders (long `idle in transaction`):
   `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
    WHERE state='idle in transaction' AND state_change < now() - interval '5 min';`
3. **Reduce demand.** If a deploy raised pod count, the pooled connections
   multiply. Set/lower Prisma's pool via `DATABASE_URL` query params
   (`?connection_limit=3&pool_timeout=20`, per `.env.example`) and redeploy, or
   scale API replicas down temporarily.
4. If the worker is hammering the DB (e.g. a large `score-prospects` or
   `send-campaign` batch), you can pause the noisy flow with a feature flag
   (`FEATURE_SEND=false` / `FEATURE_AI=false`) to shed load while you stabilize.

## Diagnosis steps
- `SHOW max_connections;` vs. observed clients. Account for: API replicas ×
  pool, worker pool, migrations, PgBouncer.
- Slow queries: `SELECT pid, now()-query_start AS dur, query FROM pg_stat_activity
  WHERE state='active' ORDER BY dur DESC;`
- Confirm whether PgBouncer is in front. If so, Prisma should use `?pgbouncer=true`
  and migrations must use `DIRECT_URL` (see `.env.example`, `MIGRATIONS.md`).
- Check for a recently merged N+1 or an unbatched loop (the send/score processors
  deliberately page and cap parallelism — a regression there can spike usage).

## Rollback steps
- If a deploy changed pool size, replica count, or introduced a hot query, roll
  back that deploy.
- Revert any change to `DATABASE_URL` / `DIRECT_URL` / PgBouncer mode that
  preceded the incident.

## Customer communication
- During: "Intermittent errors and slowness; we're restoring database capacity."
- After: confirm no data loss (transactions either committed or rolled back — the
  send outbox is atomic, so no half-sent rows).

## Prevention follow-up
- Right-size `connection_limit` per pod against `max_connections`; adopt
  PgBouncer (transaction mode) if replica count grows.
- Alert on `pg_stat_activity` saturation and on `/api/ready` Postgres failures.
- Add slow-query logging; review any processor that loops over DB writes.
</content>
