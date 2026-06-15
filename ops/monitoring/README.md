# Monitoring assets

Ready-to-use Prometheus + Grafana config for the metrics ACAOS exposes
(see [`../../docs/OPERATIONS.md`](../../docs/OPERATIONS.md)). The API serves
`/metrics` on its HTTP port; the worker serves `/metrics` on `WORKER_HEALTH_PORT`
(default 9090). Both honor the optional `METRICS_TOKEN` bearer.

## Files

| File | Purpose |
|---|---|
| `prometheus.yml` | Scrape config for the API + worker targets (bearer-token auth). |
| `alerts.yml` | Alerting rules (5xx rate, p99 latency, saturation, send-campaign backlog, job failures, target down). Referenced by `prometheus.yml` via `rule_files`. |
| `grafana-dashboard.json` | Importable "Service Overview" dashboard (request rate/latency/5xx/in-flight, worker job rate, queue depth, memory). |

## Use

1. Set `METRICS_TOKEN` in the API and worker, and export it where Prometheus runs.
2. Point `prometheus.yml` `targets` at your API/worker hosts; start Prometheus with
   `prometheus.yml` + `alerts.yml` mounted alongside.
3. In Grafana: **Dashboards → Import → Upload JSON** → `grafana-dashboard.json`,
   then pick your Prometheus data source.

Thresholds in `alerts.yml` are starting points — tune to your traffic and SLOs.
Validate rules with `promtool check rules alerts.yml` and the config with
`promtool check config prometheus.yml` before rolling out.
