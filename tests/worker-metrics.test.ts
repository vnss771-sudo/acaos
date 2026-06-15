// Pure-logic tests for the worker's Prometheus metrics: job outcome counters, the
// processing-duration histogram, and injected BullMQ queue-depth gauges.

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  incJob, observeJobDuration, resetWorkerMetrics, renderWorkerMetrics,
} from '../apps/worker/src/lib/metrics.ts'

beforeEach(() => resetWorkerMetrics())

test('incJob counts per queue and result', () => {
  incJob('send-campaign', 'completed')
  incJob('send-campaign', 'completed')
  incJob('send-campaign', 'failed')
  const out = renderWorkerMetrics()
  assert.match(out, /worker_jobs_total\{queue="send-campaign",result="completed"\} 2/)
  assert.match(out, /worker_jobs_total\{queue="send-campaign",result="failed"\} 1/)
})

test('duration histogram is cumulative with sum and count', () => {
  observeJobDuration('research-lead', 0.2)  // <= 0.25
  observeJobDuration('research-lead', 3)    // <= 5
  const out = renderWorkerMetrics()
  assert.match(out, /worker_job_duration_seconds_bucket\{queue="research-lead",le="0.25"\} 1/)
  assert.match(out, /worker_job_duration_seconds_bucket\{queue="research-lead",le="5"\} 2/)
  assert.match(out, /worker_job_duration_seconds_bucket\{queue="research-lead",le="\+Inf"\} 2/)
  assert.match(out, /worker_job_duration_seconds_count\{queue="research-lead"\} 2/)
  assert.match(out, /worker_job_duration_seconds_sum\{queue="research-lead"\} 3\.2/)
})

test('renders injected queue-depth gauges per state', () => {
  const out = renderWorkerMetrics([
    { queue: 'send-campaign', counts: { waiting: 5, active: 2, failed: 1 } },
  ])
  assert.match(out, /bullmq_queue_jobs\{queue="send-campaign",state="waiting"\} 5/)
  assert.match(out, /bullmq_queue_jobs\{queue="send-campaign",state="active"\} 2/)
  assert.match(out, /bullmq_queue_jobs\{queue="send-campaign",state="failed"\} 1/)
})

test('includes HELP/TYPE headers and process gauges', () => {
  const out = renderWorkerMetrics()
  assert.match(out, /# TYPE worker_jobs_total counter/)
  assert.match(out, /# TYPE worker_job_duration_seconds histogram/)
  assert.match(out, /# TYPE bullmq_queue_jobs gauge/)
  assert.match(out, /process_resident_memory_bytes \d+/)
  assert.match(out, /nodejs_process_uptime_seconds /)
})
