# ACAOS Service Level Objectives (operations view)

> A top-level [`docs/SLO.md`](../SLO.md) already defines the formal 28-day SLO
> table and error-budget burn alerts that back
> [`ops/monitoring/alerts.yml`](../../ops/monitoring/alerts.yml). This document
> is the **operations-facing companion** for the runbooks in this directory: it
> breaks the same reliability goals down per ACAOS subsystem (send, mailbox sync,
> discovery, Stripe, queues) with the exact metric/endpoint and alert threshold
> an on-call engineer needs. Where the two disagree on a number, the top-level
> `docs/SLO.md` is authoritative.

Beta-stage targets — intentionally modest; tighten as traffic grows.

Two services emit Prometheus metrics at `GET /metrics` (Bearer `METRICS_TOKEN`):

- **API** (`acaos-api`, default `PORT=4000`) — HTTP + dependency metrics.
- **Worker** (`acaos-worker`, `WORKER_HEALTH_PORT=9090` or platform `PORT`) — job
  + queue-depth metrics.

Health / readiness probes:

| Endpoint | Service | Gated on |
|---|---|---|
| `GET /api/live` | API | process only (never dependencies) |
| `GET /api/ready` | API | config + Postgres; **Redis only in production** |
| `GET /api/ready/strict` | API | config + Postgres + Redis |
| `GET /api/health` | API | Postgres (reports Redis too) |
| `GET /live`, `GET /ready` | Worker | ready iff not shutting down AND Redis `ready` |

Useful operator signals:
`acaos_dependency_up{dependency="postgres"|"redis"}` (1/0, refreshed by the
readiness/health probes), and `getQueueStats()` in `packages/backend-core`
(`active/waiting/completed/failed` per queue) for an ad-hoc backlog read.

---

## 1. API availability
- **Target:** 99.5% of `/api/ready` probes 200 (rolling 28d).
- **Measured by:** blackbox probe on `/api/live`/`/api/ready`;
  `acaos_dependency_up{dependency="postgres"}`; `http_requests_total`.
- **Alert:** SEV1 page when `/api/ready` fails ≥3 consecutive probes (~3 min) or
  `acaos_dependency_up{dependency="postgres"} == 0` ≥2 min.

## 2. Non-AI API latency (p95)
- **Target:** p95 < 500ms for non-AI routes (exclude `/api/ai/*` and the
  discovery trigger — they depend on external providers).
- **Measured by:** `histogram_quantile(0.95,
  sum(rate(http_request_duration_seconds_bucket[5m])) by (le, route))`, filtered
  by `route`.
- **Alert:** SEV3 warn at p95 > 1s for 10 min; SEV2 page at p95 > 2.5s for 10 min.

## 3. Campaign-send job success rate
- **Target:** ≥ 99% of `send-campaign` jobs reach `completed` (rolling 7d). A job
  completing ≠ a lead sending — leads skipped for `SUPPRESSED` / `DAILY_CAP` /
  `NO_APPROVED_DRAFT` / `POLICY_REVIEW` etc. are expected, not failures.
- **Measured by:** `worker_jobs_total{queue="send-campaign",result="failed"}` vs
  `result="completed"`. Per-lead delivery from `OutreachSent.status`
  (`SENDING`/`SENT`/`FAILED`/`BOUNCED`/`REPLIED`).
- **Alert:** SEV2 page when failed/total > 5% over 1h, OR any `OutreachSent` row
  stuck `SENDING` > 15 min (fail-closed — never auto-resent; see
  `stuck-campaign-send.md`).

## 4. Mailbox-sync success rate
- **Target:** ≥ 95% of `sync-mailbox` jobs `completed` (rolling 7d). Auto-sync
  scheduler fires every 10 min.
- **Measured by:** `worker_jobs_total{queue="sync-mailbox",result=...}`; per-run
  log `inspected/matched/queued/bounced`.
- **Alert:** SEV3 warn when failed/total > 10% over 1h (usually one workspace's
  IMAP creds — `imap-auth-failure.md`); SEV2 page when ALL syncs fail.

## 5. Prospect-discovery success rate
- **Target:** ≥ 90% of `discover-prospects` jobs end `SUCCEEDED` or `PARTIAL`.
  Discovery is `attempts:1` (paid metered provider — never auto-retried); the
  terminal state is on the `DiscoveryRun` row.
- **Measured by:** `DiscoveryRun.status` distribution;
  `provider_calls_total{provider="apollo-search"|"google-places"|"hunter",
  outcome="error"}`; the matching circuit breaker.
- **Alert:** SEV3 warn when `FAILED` ratio > 20% over 1h.

## 6. Stripe webhook success
- **Target:** ≥ 99.9% of delivered webhooks acknowledged 2xx (verified +
  processed, or a deduped replay).
- **Measured by:** `http_requests_total{route="/api/billing/webhook"}` by status;
  `AuditEvent` `billing.webhook.verification_failed` /
  `billing.webhook.processing_failed`; Stripe Dashboard → Webhooks.
- **Alert:** SEV2 page on ≥3 `billing.webhook.processing_failed` in 10 min or
  Stripe-reported failure rate > 5% — see `stripe-webhook-failure.md`.

## 7. Queue wait time (p95)
- **Target:** p95 time-in-`waiting` < 60s for interactive queues
  (`generate-outreach`, `analyze-reply`, `research-lead`); best-effort for batch
  queues (`score-prospects`, `calibrate-scoring`, `retention-purge`).
- **Measured by:** `bullmq_queue_jobs{queue,state="waiting"}` depth gauge +
  `worker_job_duration_seconds`. Rising `waiting` with flat `active` = worker
  down/wedged.
- **Alert:** SEV3 warn when any `waiting` > 500 for 10 min; SEV2 page when
  `waiting` climbs while `worker_jobs_total` is flat.

---

## Error-budget policy (beta)
- Burning > 50% of a 28d budget in a week → freeze risky deploys; prioritize the
  relevant runbook's "Prevention follow-up".
- Budget exhausted → only reliability/rollback changes ship until recovered.
</content>
