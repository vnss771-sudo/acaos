# Incident Runbooks

First-response procedures for each alert in
[`ops/monitoring/alerts.yml`](../ops/monitoring/alerts.yml). Each alert's
`description` links to its section here by anchor. Targets/SLOs:
[`SLO.md`](SLO.md). Operational background: [`OPERATIONS.md`](OPERATIONS.md).

**General triage order:** confirm scope (one target or all?) → check the Grafana
"Service Overview" dashboard → check recent deploys → check dependencies (DB,
Redis, providers) → mitigate (rollback / scale / restart) → write it up if it
burned error budget.

Health endpoints: `GET /api/live` (process), `GET /api/ready` (DB+Redis),
`GET /api/health`. Metrics: API `/metrics`, worker `/metrics` (bearer
`METRICS_TOKEN`).

---

## EndpointDown
External uptime probe to a target has failed for >2m. **User-facing outage.**
1. Hit the URL yourself; check `GET /api/live` vs `GET /api/ready` to split a
   crash (live fails) from a dependency outage (ready fails, live ok).
2. Check the platform/host status and recent deploys; **roll back** the last
   deploy if it correlates.
3. If `live` is ok but `ready` is failing → see **DependencyDown** below.
4. If the process is down, restart it; confirm it stays up (no crash loop in
   logs / `uncaughtException`).

## ApiTargetDown / WorkerTargetDown
Prometheus cannot scrape the target for >2m. May be the service OR the metrics
path. Distinguish from `EndpointDown` (which proves user impact):
1. Curl the target's `/metrics` with the bearer; if it answers, the issue is the
   scrape network/credentials, not the app.
2. If unreachable, treat as a process-down (restart, check logs). Worker down →
   jobs queue but don't drain (watch `SendCampaignBacklog`).

## ApiHigh5xxRate
>5% of responses are 5xx for 5m. **Burning the success-rate budget.**
1. Grafana → 5xx-by-route panel to find the offending route.
2. Check logs for the request-id correlated stack traces and Sentry (if
   `SENTRY_DSN` set).
3. Common causes: DB pool exhaustion (`ready` flaky), a bad deploy, a provider
   outage cascading. Roll back if deploy-correlated; otherwise mitigate the
   dependency.


## ApiSuccessBudgetBurn / ApiAvailabilityBudgetBurn / WebAvailabilityBudgetBurn
Formal multi-window burn-rate alert. Error budget is being consumed much faster
than linear, so treat this as an incident even if the service is not fully down.
1. Confirm whether the burn is **API 5xx**, **API uptime**, or **web uptime**.
2. Check recent deploys first; if correlated, roll back immediately.
3. Use the release metadata (`X-Acaos-Release-Id`, `/api/ready`, `/ready`) to
   confirm every target is on the intended release and there is no mixed rollout.
4. Mitigate the immediate cause (dependency, capacity, edge/network), then keep
   non-critical deploys frozen until the burn returns to baseline.

## ApiHighLatencyP99 / ProbeSlow
p99 > 1.5s for 10m (or external probe > 2s). 
1. Grafana → p99-by-route; isolate the slow route. `/api/stats` is cached
   (single-flight + TTL) — if it regresses, check `STATS_CACHE_TTL_MS`.
2. Check DB load / slow queries and `ApiSaturation` (in-flight). Scale out or
   raise the DB pool if saturated; investigate N+1s / missing indexes otherwise.

## ApiSaturation
In-flight requests averaged >100 for 10m — a latency leading indicator.
1. Confirm it tracks real traffic vs. a slow dependency holding connections open.
2. Scale API replicas and/or raise the DB connection pool. If driven by one slow
   route, fix that first.

## SendCampaignBacklog
>100 waiting `send-campaign` jobs for 10m — **outreach is delayed.**
1. Confirm the worker is up and scraping (`WorkerTargetDown`?).
2. Check SMTP health and per-workspace send limits; a provider/credential failure
   stalls sends. Check `WorkerJobFailures` for the same queue.
3. Once the cause is cleared, the backlog drains on its own; consider raising
   send-campaign worker concurrency if this is chronic.

## WorkerJobFailures / QueueDeadLetterGrowing
Jobs failing after exhausting retries (or >50 entering `failed` in 1h).
1. Identify the queue from `{{ $labels.queue }}`; read worker logs and Sentry for
   the final-attempt error.
2. AI queues (`research-lead`, `generate-outreach`, `analyze-reply`) failing in a
   burst usually means OpenAI degraded / rate-limited or the circuit breaker is
   OPEN — back-off + retry is automatic; verify provider status.
3. A `QUEUE_PAYLOAD_INVALID` (UnrecoverableError) means a producer/schema drift —
   fix the producer; these never retry by design.

## DependencyDown (Postgres / Redis)
Symptom: `GET /api/ready` 503 while `/api/live` is 200; jobs stall.
1. Postgres: check connectivity/credentials, disk, max-connections, failover
   status. Redis: BullMQ + rate-limit + cache + breaker share it; an outage
   degrades gracefully (in-process fallbacks) but jobs won't run.
2. Restore the dependency; the app reconnects automatically.

## TlsCertExpiringSoon
Probe reports the serving cert expires in <14 days. Renew/rotate the certificate
at the edge (the app emits HSTS in production). Not user-impacting yet — handle in
business hours, but before expiry.
