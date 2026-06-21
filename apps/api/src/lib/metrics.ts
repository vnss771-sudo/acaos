// Dependency-free Prometheus metrics. Exposes HTTP request counts, a latency
// histogram, provider-call counters, in-flight gauge, and build/runtime metadata
// in the text exposition format (v0.0.4) so Prometheus can scrape /metrics.

import { getBuildInfoLabels, getProcessStartTimeSeconds } from '@acaos/backend-core/lib/release.js'

type Labels = Record<string, string>

const SERVICE = 'acaos-api'
const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]

const requestTotals = new Map<string, { labels: Labels; value: number }>()
const providerTotals = new Map<string, { labels: Labels; value: number }>()
type Hist = { labels: Labels; buckets: number[]; sum: number; count: number }
const durations = new Map<string, Hist>()
let inFlight = 0
// Backing-dependency reachability (1=up, 0=down), refreshed by the readiness/
// health probes (see server.ts). Lets alerting distinguish a Redis outage
// (degrades gracefully) from a Postgres outage without parsing /api/ready JSON.
const dependencyUp = new Map<string, number>()

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

export function setDependencyUp(dependency: string, up: boolean): void {
  dependencyUp.set(dependency, up ? 1 : 0)
}

export function resetMetrics(): void {
  requestTotals.clear()
  durations.clear()
  providerTotals.clear()
  dependencyUp.clear()
  inFlight = 0
}

function esc(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}

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

  lines.push('# HELP acaos_dependency_up Backing dependency reachability (1=up, 0=down), refreshed by readiness/health probes.')
  lines.push('# TYPE acaos_dependency_up gauge')
  for (const [dependency, value] of dependencyUp) {
    lines.push(`acaos_dependency_up${fmtLabels({ dependency })} ${value}`)
  }

  lines.push('# HELP acaos_build_info Immutable build and release metadata.')
  lines.push('# TYPE acaos_build_info gauge')
  lines.push(`acaos_build_info${fmtLabels(getBuildInfoLabels(SERVICE))} 1`)

  lines.push('# HELP process_resident_memory_bytes Resident memory size in bytes.')
  lines.push('# TYPE process_resident_memory_bytes gauge')
  lines.push(`process_resident_memory_bytes ${process.memoryUsage().rss}`)

  lines.push('# HELP nodejs_process_start_time_seconds Process start time in unix seconds.')
  lines.push('# TYPE nodejs_process_start_time_seconds gauge')
  lines.push(`nodejs_process_start_time_seconds ${getProcessStartTimeSeconds()}`)

  lines.push('# HELP nodejs_process_uptime_seconds Process uptime in seconds.')
  lines.push('# TYPE nodejs_process_uptime_seconds gauge')
  lines.push(`nodejs_process_uptime_seconds ${process.uptime()}`)

  return lines.join('\n') + '\n'
}

export const METRICS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8'
