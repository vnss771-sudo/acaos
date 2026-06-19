# Service Level Objectives (SLOs)

The reliability targets ACAOS holds itself to, the metrics that measure them, and
the error budgets that turn "is it healthy?" into a number. These back the alert
thresholds in [`ops/monitoring/alerts.yml`](../ops/monitoring/alerts.yml) and the
response procedures in [`RUNBOOKS.md`](RUNBOOKS.md).

> Scope: the multi-tenant SaaS (API + worker + web). Targets are starting points
> for the controlled beta — tighten as traffic and expectations grow.

## SLOs

| # | SLO | Target (28-day) | SLI (PromQL series) |
|---|---|---|---|
| 1 | **API availability** — externally-observed | 99.5% | `avg_over_time(probe_success{job="blackbox-api-live"}[28d])` |
| 2 | **API success rate** — non-5xx of all requests | 99.5% | `1 - (sum(rate(http_requests_total{status=~"5.."}[28d])) / sum(rate(http_requests_total[28d])))` |
| 3 | **API latency** — p99 of request duration | < 1.5s | `histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket[5m])) by (le))` |
| 4 | **Web app availability** — externally-observed | 99.5% | `avg_over_time(probe_success{job="blackbox-web"}[28d])` |
| 5 | **Outreach freshness** — send-campaign backlog drains | < 100 waiting for <10m | `bullmq_queue_jobs{queue="send-campaign",state="waiting"}` |
| 6 | **Background job success** — jobs succeed (post-retry) | 99% | `1 - (sum(rate(worker_jobs_total{result="failed"}[28d])) / sum(rate(worker_jobs_total[28d])))` |

## Error budget

A 99.5% availability/success target over 28 days allows **~3h 22m** of downtime or
**0.5%** of requests to fail. Budget policy:

- **Budget healthy (> 25% remaining):** ship normally.
- **Budget low (< 25%):** prioritise reliability work; require extra review on
  risky changes.
- **Budget exhausted (≤ 0):** freeze non-critical deploys until the burn stops
  and budget recovers; every incident gets a written follow-up.

Fast-burn alerting (consuming budget far faster than linear) is what the
`critical` rules (`ApiHigh5xxRate`, `EndpointDown`) approximate today; a formal
multi-window burn-rate rule is a future refinement.

## How the alerts map to SLOs

| Alert | Defends SLO | Severity |
|---|---|---|
| `EndpointDown`, `ApiTargetDown`, `WorkerTargetDown` | 1, 4 (availability) | critical |
| `ApiHigh5xxRate` | 2 (success rate) | critical |
| `ApiHighLatencyP99`, `ProbeSlow` | 3 (latency) | warning |
| `ApiSaturation` | 3 (latency, leading indicator) | warning |
| `SendCampaignBacklog` | 5 (freshness) | critical |
| `WorkerJobFailures`, `QueueDeadLetterGrowing` | 6 (job success) | warning |
| `TlsCertExpiringSoon` | 1, 4 (prevents an availability cliff) | warning |

## Review cadence

Review SLO attainment and budget burn monthly; adjust targets/thresholds when the
service or its traffic profile changes materially.
