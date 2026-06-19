// Dependency-free Prometheus metrics. Exposes HTTP request counts, a latency
// histogram, and in-flight gauge in the text exposition format (v0.0.4) so a
// standard Prometheus/Grafana stack can scrape /metrics — no prom-client needed.

type Labels = Record<string, string>

const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]

// counter: http_requests_total{method,route,status}
const requestTotals = new Map<string, { labels: Labels; value: number }>()
// counter: provider_calls_total{provider,operation,outcome} — every outbound
// third-party HTTP call, labelled by its typed outcome, so a provider fault is
// distinguishable from a legitimate empty result on a dashboard.
const providerTotals = new Map<string, { labels: Labels; value: number }>()
// histogram: per method+route → { labels, buckets[], sum, count }
type Hist = { labels: Labels; buckets: number[]; sum: number; count: number }
const durations = new Map<string, Hist>()
let inFlight = 0

// Stable identity for a label set (order-independent), used only for map keys.
const idOf = (labels: Labels) =>
  Object.keys(labels).sort().map((k) => `${k}=${labels[k]}`).join('\x1f')

export function incRequest(method: string, route: string, status: number): void {
  const labels = { method, route, status: String(status) }
  const id = idOf(labels)
  const entry = requestTotals.get(id)
  if (entry) entry.value += 1
  else requestTotals.set(id, { labels, value: 1 })
}

export function observeDuration(method: string, route: string, seconds: number): void {
  const labels = { method, route }
  const id = idOf(labels)
  let h = durations.get(id)
  if (!h) {
    h = { labels, buckets: new Array(DURATION_BUCKETS.length).fill(0), sum: 0, count: 0 }
    durations.set(id, h)
  }
  h.sum += seconds
  h.count += 1
  // Each bucket holds the cumulative count of observations <= its upper bound.
  for (let i = 0; i < DURATION_BUCKETS.length; i++) {
    if (seconds <= DURATION_BUCKETS[i]) h.buckets[i] += 1
  }
}

export function incProviderCall(provider: string, operation: string, outcome: string): void {
  const labels = { provider, operation, outcome }
  const id = idOf(labels)
  const entry = providerTotals.get(id)
  if (entry) entry.value += 1
  else providerTotals.set(id, { labels, value: 1 })
}

export function setInFlight(n: number): void { inFlight = n }
export function incInFlight(): void { inFlight++ }
export function decInFlight(): void { inFlight = Math.max(0, inFlight - 1) }

/** Test-only: clear all accumulated metrics. */
export function resetMetrics(): void {
  requestTotals.clear()
  durations.clear()
  providerTotals.clear()
  inFlight = 0
}

// Escape a Prometheus label value (backslash, double-quote, newline).
function esc(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}

// Render labels in the given insertion order (Prometheus is order-independent,
// but a stable, conventional order keeps output readable — e.g. le last).
function fmtLabels(labels: Labels): string {
  const keys = Object.keys(labels)
  if (keys.length === 0) return ''
  return `{${keys.map((k) => `${k}="${esc(labels[k])}"`).join(',')}}`
}

export function renderMetrics(): string {
  const lines: string[] = []

  lines.push('# HELP http_requests_total Total HTTP requests by method, route and status.')
  lines.push('# TYPE http_requests_total counter')
  for (const { labels, value } of requestTotals.values()) {
    lines.push(`http_requests_total${fmtLabels(labels)} ${value}`)
  }

  lines.push('# HELP http_request_duration_seconds HTTP request latency in seconds.')
  lines.push('# TYPE http_request_duration_seconds histogram')
  for (const h of durations.values()) {
    for (let i = 0; i < DURATION_BUCKETS.length; i++) {
      lines.push(`http_request_duration_seconds_bucket${fmtLabels({ ...h.labels, le: String(DURATION_BUCKETS[i]) })} ${h.buckets[i]}`)
    }
    lines.push(`http_request_duration_seconds_bucket${fmtLabels({ ...h.labels, le: '+Inf' })} ${h.count}`)
    lines.push(`http_request_duration_seconds_sum${fmtLabels(h.labels)} ${h.sum}`)
    lines.push(`http_request_duration_seconds_count${fmtLabels(h.labels)} ${h.count}`)
  }

  lines.push('# HELP provider_calls_total External provider calls by provider, operation and outcome.')
  lines.push('# TYPE provider_calls_total counter')
  for (const { labels, value } of providerTotals.values()) {
    lines.push(`provider_calls_total${fmtLabels(labels)} ${value}`)
  }

  lines.push('# HELP http_requests_in_flight In-flight HTTP requests.')
  lines.push('# TYPE http_requests_in_flight gauge')
  lines.push(`http_requests_in_flight ${inFlight}`)

  lines.push('# HELP process_resident_memory_bytes Resident memory size in bytes.')
  lines.push('# TYPE process_resident_memory_bytes gauge')
  lines.push(`process_resident_memory_bytes ${process.memoryUsage().rss}`)

  lines.push('# HELP nodejs_process_uptime_seconds Process uptime in seconds.')
  lines.push('# TYPE nodejs_process_uptime_seconds gauge')
  lines.push(`nodejs_process_uptime_seconds ${process.uptime()}`)

  return lines.join('\n') + '\n'
}

export const METRICS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8'
