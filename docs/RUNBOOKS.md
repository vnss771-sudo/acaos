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

## AiSpendSpike
Estimated AI spend (`acaos_ai_cost_cents_total`) exceeded $20/hour.
1. Check `sum by (action) (increase(acaos_ai_cost_cents_total[1h]))` to see which
   action (`AI_OUTREACH`/`AI_RESEARCH`/`AI_REPLY`) is driving it, and `acaos_ai_calls_total`
   for call volume — a spike in calls, not cost-per-call, means a loop or abuse.
2. Correlate with `worker_jobs_total` / `acaos_send_outcomes_total` to find the
   workspace/campaign generating the volume; a single tenant retrying or a large
   import can drive it legitimately — confirm before throttling.
3. If runaway or abusive: flip `FEATURE_SEND` / `FEATURE_AI` kill-switch (or the
   per-workspace send-suppression flag) to stop the bleed, then root-cause. Rotate
   the provider key if a leak is suspected.

## ProviderCircuitOpen
A provider circuit breaker (`acaos_circuit_open{provider}`) has been OPEN for >5m.
1. Identify the provider from `{{ $labels.provider }}` (openai / apollo-* /
   google-places / hunter / stripe). OPEN means ≥5 consecutive failures; calls are
   being shed and will auto-probe (HALF_OPEN) after the reset window.
2. Check that upstream's status page and recent worker logs for the failure mode
   (auth, rate-limit, timeout). The breaker recovers itself once the provider does.
3. If the provider is down for an extended period, expect elevated skip/failure
   counts; no action restores it but the breaker prevents hammering the upstream.

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

## FollowupBacklogGrowing
>200 follow-up tasks are due but unsent for 15m (`acaos_followup_due_unsent`).
1. Confirm follow-ups are meant to be on: `FOLLOWUPS_ENABLED=true` and the campaign's
   `autoFollowupsEnabled`. If off by design, this is expected — silence the alert.
2. Check the `send-followup` queue depth and the `followup-due-scan` scheduler; a
   stuck scan or `FEATURE_SEND=false` stops dispatch.
3. Check `FollowupTasksStuck` (claimed-but-not-completing) and worker health.
   Deep dive: `runbooks/followups-not-sending.md`.

## FollowupTasksStuck
>50 follow-up tasks stuck in PROCESSING for 15m — claimed by a worker that then
crashed mid-dispatch.
1. These hold no further sends; the per-step outbox unique prevents double-send.
2. Relate to stale-SENDING recovery (`STALE_SENDING_RECOVERY_MINUTES`) — the daily
   maintenance sweep reclaims abandoned SENDING rows; PROCESSING tasks may need a
   manual reset to SCHEDULED if a deploy interrupted them.

## ReputationEnforceBlocking
Sends are being halted by the sender-reputation guard in enforce mode
(`acaos_reputation_enforce_blocks_total` rising). **Customer sends are stopping.**
1. Identify the workspace: `GET /api/stats/reputation?workspaceId=…` returns
   `bounceRate`, `complaintRate`, `totalSends`, `reason`, `thresholds`.
2. If the block is correct (genuinely high bounces), fix deliverability first —
   see `runbooks/high-bounce-rate.md`.
3. To stop blocking while investigating: `REPUTATION_GUARD_MODE=observe` (still logs,
   doesn't block). Tune thresholds via `REPUTATION_MAX_BOUNCE_RATE` etc.
   Deep dive: `runbooks/reputation-guard-enforcement.md`.

## SenderReputationDegraded
A workspace is over a bounce/complaint threshold (`acaos_sender_workspaces_unhealthy>0`).
Fires in observe mode too — an early warning before enforce would block. Diagnose
via `/api/stats/reputation`; see `runbooks/high-bounce-rate.md`.

## BounceRateSpike
A workspace's trailing bounce rate exceeds 5%. Pause/curb that workspace's sends,
investigate the list source and recent campaigns. See `runbooks/high-bounce-rate.md`.

## ComplaintRateSpike
A workspace's complaint rate exceeds 0.3%. Treat as urgent — complaints damage the
sending domain fastest. Review content/targeting; see `runbooks/high-bounce-rate.md`.

## WarmupStuck
A workspace's warmup day index hasn't advanced in 24h while warmup is active.
1. Confirm `WorkspaceICP.warmupStartedAt` is set and in the past.
2. Compare expected day vs `WARMUP_SCHEDULE`; the effective cap is
   `min(dailySendLimit, warmupDailyCap)` — `SAFE_LAUNCH_DAILY_SEND_CAP` may be the
   binding constraint instead. Deep dive: `runbooks/warmup-not-progressing.md`.
