// Dependency-free Prometheus metrics for the worker: background-job outcome
// counters, processing-duration histogram, BullMQ queue-depth gauges, and
// immutable build/runtime metadata.

import { getBuildInfoLabels, getProcessStartTimeSeconds } from '@acaos/backend-core/lib/release.js'

type JobResult = 'completed' | 'failed'

const SERVICE = 'acaos-worker'
const DURATION_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60]
const jobTotals = new Map<string, { queue: string; result: JobResult; value: number }>()
type Hist = { queue: string; buckets: number[]; sum: number; count: number }
const jobDurations = new Map<string, Hist>()

export function incJob(queue: string, result: JobResult): void {
  const key = `${queue}\x1f${result}`
  const e = jobTotals.get(key)
  if (e) e.value += 1
  else jobTotals.set(key, { queue, result, value: 1 })
}

export function observeJobDuration(queue: string, seconds: number): void {
  let h = jobDurations.get(queue)
  if (!h) {
    h = { queue, buckets: new Array(DURATION_BUCKETS.length).fill(0), sum: 0, count: 0 }
    jobDurations.set(queue, h)
  }
  h.sum += seconds
  h.count += 1
  for (let i = 0; i < DURATION_BUCKETS.length; i++) {
    if (seconds <= DURATION_BUCKETS[i]) h.buckets[i] += 1
  }
}

export function resetWorkerMetrics(): void {
  jobTotals.clear()
  jobDurations.clear()
}

function esc(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}
function lbl(labels: Record<string, string>): string {
  const keys = Object.keys(labels)
  return keys.length ? `{${keys.map((k) => `${k}="${esc(labels[k])}"`).join(',')}}` : ''
}

export type QueueDepth = { queue: string; counts: Record<string, number> }

export function renderWorkerMetrics(depths: QueueDepth[] = []): string {
  const lines: string[] = []

  lines.push('# HELP worker_jobs_total Background jobs processed by queue and result.')
  lines.push('# TYPE worker_jobs_total counter')
  for (const { queue, result, value } of jobTotals.values()) {
    lines.push(`worker_jobs_total${lbl({ queue, result })} ${value}`)
  }

  lines.push('# HELP worker_job_duration_seconds Job processing latency in seconds.')
  lines.push('# TYPE worker_job_duration_seconds histogram')
  for (const h of jobDurations.values()) {
    for (let i = 0; i < DURATION_BUCKETS.length; i++) {
      lines.push(`worker_job_duration_seconds_bucket${lbl({ queue: h.queue, le: String(DURATION_BUCKETS[i]) })} ${h.buckets[i]}`)
    }
    lines.push(`worker_job_duration_seconds_bucket${lbl({ queue: h.queue, le: '+Inf' })} ${h.count}`)
    lines.push(`worker_job_duration_seconds_sum${lbl({ queue: h.queue })} ${h.sum}`)
    lines.push(`worker_job_duration_seconds_count${lbl({ queue: h.queue })} ${h.count}`)
  }

  lines.push('# HELP bullmq_queue_jobs Current job count per queue and state.')
  lines.push('# TYPE bullmq_queue_jobs gauge')
  for (const d of depths) {
    for (const [state, n] of Object.entries(d.counts)) {
      lines.push(`bullmq_queue_jobs${lbl({ queue: d.queue, state })} ${n}`)
    }
  }

  lines.push('# HELP acaos_build_info Immutable build and release metadata.')
  lines.push('# TYPE acaos_build_info gauge')
  lines.push(`acaos_build_info${lbl(getBuildInfoLabels(SERVICE))} 1`)

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
