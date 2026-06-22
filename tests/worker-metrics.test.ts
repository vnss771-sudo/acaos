import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  incJob, observeJobDuration, resetWorkerMetrics, renderWorkerMetrics, incReputationBlock,
} from '../apps/worker/src/lib/metrics.ts'

beforeEach(() => resetWorkerMetrics())

test('reputation enforce-block counter renders per queue', () => {
  incReputationBlock('send-campaign')
  incReputationBlock('send-campaign')
  incReputationBlock('send-followup')
  const out = renderWorkerMetrics()
  assert.match(out, /acaos_reputation_enforce_blocks_total\{queue="send-campaign"\} 2/)
  assert.match(out, /acaos_reputation_enforce_blocks_total\{queue="send-followup"\} 1/)
})

test('domain snapshot renders follow-up backlog, reputation, and warmup gauges', () => {
  const out = renderWorkerMetrics([], {
    followupTasks: { SCHEDULED: 12, PROCESSING: 1, BLOCKED: 3 },
    followupDueUnsent: 7,
    reputation: { evaluated: 2, unhealthy: 1, perWorkspace: [
      { workspaceId: 'ws1', bounceRate: 0.08, complaintRate: 0.001, healthy: false },
    ] },
    warmup: [{ workspaceId: 'ws2', day: 3, cap: 80 }],
  })
  assert.match(out, /acaos_followup_tasks\{status="SCHEDULED"\} 12/)
  assert.match(out, /acaos_followup_due_unsent 7/)
  assert.match(out, /acaos_sender_workspaces_unhealthy 1/)
  assert.match(out, /acaos_sender_bounce_rate\{workspace="ws1"\} 0\.08/)
  assert.match(out, /acaos_sender_reputation_healthy\{workspace="ws1"\} 0/)
  assert.match(out, /acaos_warmup_day\{workspace="ws2"\} 3/)
  assert.match(out, /acaos_warmup_cap\{workspace="ws2"\} 80/)
})

test('domain snapshot is omitted when not provided (no empty gauges)', () => {
  const out = renderWorkerMetrics()
  assert.doesNotMatch(out, /acaos_followup_tasks/)
  assert.doesNotMatch(out, /acaos_warmup_day/)
})

test('incJob counts per queue and result', () => {
  incJob('send-campaign', 'completed')
  incJob('send-campaign', 'completed')
  incJob('send-campaign', 'failed')
  const out = renderWorkerMetrics()
  assert.match(out, /worker_jobs_total\{queue="send-campaign",result="completed"\} 2/)
  assert.match(out, /worker_jobs_total\{queue="send-campaign",result="failed"\} 1/)
})

test('duration histogram is cumulative with sum and count', () => {
  observeJobDuration('research-lead', 0.2)
  observeJobDuration('research-lead', 3)
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

test('includes HELP/TYPE headers, build info, and process gauges', () => {
  const out = renderWorkerMetrics()
  assert.match(out, /# TYPE worker_jobs_total counter/)
  assert.match(out, /# TYPE worker_job_duration_seconds histogram/)
  assert.match(out, /# TYPE bullmq_queue_jobs gauge/)
  assert.match(out, /acaos_build_info\{service="acaos-worker"/)
  assert.match(out, /process_resident_memory_bytes \d+/)
  assert.match(out, /nodejs_process_start_time_seconds \d+/)
  assert.match(out, /nodejs_process_uptime_seconds /)
})
