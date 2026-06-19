# Monitoring assets

Ready-to-use Prometheus + Grafana config for the metrics ACAOS exposes
(see [`../../docs/OPERATIONS.md`](../../docs/OPERATIONS.md)). The API serves
`/metrics` on its HTTP port; the worker serves `/metrics` on `WORKER_HEALTH_PORT`
(default 9090). Both honor the optional `METRICS_TOKEN` bearer.

## Files

| File | Purpose |
|---|---|
| `prometheus.yml` | Scrape config for the API + worker targets (bearer-token auth) + blackbox uptime probes + Alertmanager wiring. |
| `alerts.yml` | Alerting rules (5xx rate, p99 latency, saturation, send-campaign backlog, job failures, target down, external uptime, TLS expiry). Referenced by `prometheus.yml` via `rule_files`. |
| `alertmanager.yml` | Alert routing: severity-based → PagerDuty (critical) + Slack, with grouping & inhibition. Secrets via env expansion. |
| `blackbox.yml` | blackbox_exporter modules for external uptime / synthetic checks of the API & web. |
| `grafana-dashboard.json` | Importable "Service Overview" dashboard (request rate/latency/5xx/in-flight, worker job rate, queue depth, memory). |

See also [`../../docs/SLO.md`](../../docs/SLO.md) (targets + error budget) and
[`../../docs/RUNBOOKS.md`](../../docs/RUNBOOKS.md) (per-alert response).

## Use

1. Set `METRICS_TOKEN` in the API and worker, and export it where Prometheus runs.
2. Point `prometheus.yml` `targets` at your API/worker hosts; start Prometheus with
   `prometheus.yml` + `alerts.yml` mounted alongside.
3. For uptime: run `blackbox_exporter --config.file=blackbox.yml` and set the
   `blackbox-*` job `targets` in `prometheus.yml` to your public URLs.
4. For routing: run Alertmanager with `alertmanager.yml` (`--config.expand-env`),
   supplying `SLACK_WEBHOOK_URL` / `PAGERDUTY_ROUTING_KEY` via env.
5. In Grafana: **Dashboards → Import → Upload JSON** → `grafana-dashboard.json`,
   then pick your Prometheus data source.

Thresholds in `alerts.yml` are starting points — tune to your traffic and SLOs.
Validate with `promtool check config prometheus.yml`, `promtool check rules
alerts.yml`, and `amtool check-config alertmanager.yml` before rolling out.
