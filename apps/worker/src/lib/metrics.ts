// Dependency-free Prometheus metrics for the worker: background-job outcome
// counters, processing-duration histogram, BullMQ queue-depth gauges, and
// immutable build/runtime metadata.

import { getBuildInfoLabels, getProcessStartTimeSeconds } from '@acaos/backend-core/lib/release.js'
import { snapshotBreakerStates } from '@acaos/backend-core/lib/circuit.js'
import { aiActionCostCents, type AiAction } from '@acaos/backend-core/lib/aiCost.js'

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

// Reputation enforce-blocks: a discrete event (a send halted in enforce mode), so a
// counter — keyed by queue only (2 series), never by workspace, to bound cardinality.
const reputationBlocks = new Map<string, number>()
export function incReputationBlock(queue: 'send-campaign' | 'send-followup'): void {
  reputationBlocks.set(queue, (reputationBlocks.get(queue) ?? 0) + 1)
}

// Per-batch send outcomes: every lead a send job handled ends as `sent`, `failed`,
// or one of the skip reasons (cap hit, policy review, AI limit, …). The send path
// enforces these invariants but previously only logged them, so an operator couldn't
// see WHY a batch didn't send without log-diving. A counter keyed by queue + outcome
// only — the outcome set is a small fixed enum (~15 values), never keyed by
// workspace, so cardinality stays bounded.
const sendOutcomes = new Map<string, { queue: string; outcome: string; value: number }>()
export function incSendOutcome(queue: string, outcome: string, n = 1): void {
  if (n <= 0) return
  const key = `${queue}\x1f${outcome}`
  const e = sendOutcomes.get(key)
  if (e) e.value += n
  else sendOutcomes.set(key, { queue, outcome, value: n })
}

// Estimated AI spend, accumulated per metered action. A runaway prompt loop or a
// compromised key is otherwise invisible until the OpenAI invoice arrives; exporting
// it as a counter lets `AiSpendSpike` alert in minutes. Keyed by action only (3
// series) — never by workspace — so cardinality stays bounded. Cents are the rough,
// tunable per-action estimates from aiCost.ts, not invoice figures.
const aiCostCents = new Map<AiAction, number>()
const aiCalls = new Map<AiAction, number>()
export function incAiCost(action: AiAction, calls = 1): void {
  if (calls <= 0) return
  aiCalls.set(action, (aiCalls.get(action) ?? 0) + calls)
  aiCostCents.set(action, (aiCostCents.get(action) ?? 0) + aiActionCostCents(action) * calls)
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
  reputationBlocks.clear()
  sendOutcomes.clear()
  aiCostCents.clear()
  aiCalls.clear()
}

function esc(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}
function lbl(labels: Record<string, string>): string {
  const keys = Object.keys(labels)
  return keys.length ? `{${keys.map((k) => `${k}="${esc(labels[k])}"`).join(',')}}` : ''
}

export type QueueDepth = { queue: string; counts: Record<string, number> }

// Scrape-time snapshot of DB-derived deliverability state, collected on each /metrics
// scrape (mirrors the queue-depth collector). All fields optional so a collection
// failure degrades to "absent" rather than failing the scrape.
export type DomainSnapshot = {
  followupTasks?: Record<string, number> // FollowupTaskStatus -> count (platform-wide)
  followupDueUnsent?: number
  reputation?: {
    evaluated: number
    unhealthy: number
    // Bounded set (capped) of notable workspaces — never the full tenant list.
    perWorkspace?: Array<{ workspaceId: string; bounceRate: number; complaintRate: number; healthy: boolean }>
  }
  warmup?: Array<{ workspaceId: string; day: number; cap: number }> // opt-in only, naturally bounded
}

export function renderWorkerMetrics(depths: QueueDepth[] = [], domain: DomainSnapshot = {}): string {
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

  lines.push('# HELP acaos_reputation_enforce_blocks_total Sends blocked by the reputation guard in enforce mode.')
  lines.push('# TYPE acaos_reputation_enforce_blocks_total counter')
  for (const [queue, n] of reputationBlocks.entries()) {
    lines.push(`acaos_reputation_enforce_blocks_total${lbl({ queue })} ${n}`)
  }

  lines.push('# HELP acaos_send_outcomes_total Per-lead send outcomes by queue and outcome (sent, failed, or skip reason).')
  lines.push('# TYPE acaos_send_outcomes_total counter')
  for (const { queue, outcome, value } of sendOutcomes.values()) {
    lines.push(`acaos_send_outcomes_total${lbl({ queue, outcome })} ${value}`)
  }

  if (domain.followupTasks) {
    lines.push('# HELP acaos_followup_tasks Follow-up tasks by status (platform-wide).')
    lines.push('# TYPE acaos_followup_tasks gauge')
    for (const [status, n] of Object.entries(domain.followupTasks)) {
      lines.push(`acaos_followup_tasks${lbl({ status })} ${n}`)
    }
  }
  if (domain.followupDueUnsent != null) {
    lines.push('# HELP acaos_followup_due_unsent Scheduled follow-up tasks that are due but not yet sent.')
    lines.push('# TYPE acaos_followup_due_unsent gauge')
    lines.push(`acaos_followup_due_unsent ${domain.followupDueUnsent}`)
  }
  if (domain.reputation) {
    lines.push('# HELP acaos_sender_workspaces_evaluated Workspaces evaluated by the reputation guard this scrape.')
    lines.push('# TYPE acaos_sender_workspaces_evaluated gauge')
    lines.push(`acaos_sender_workspaces_evaluated ${domain.reputation.evaluated}`)
    lines.push('# HELP acaos_sender_workspaces_unhealthy Workspaces currently over a bounce/complaint threshold.')
    lines.push('# TYPE acaos_sender_workspaces_unhealthy gauge')
    lines.push(`acaos_sender_workspaces_unhealthy ${domain.reputation.unhealthy}`)
    if (domain.reputation.perWorkspace?.length) {
      lines.push('# HELP acaos_sender_bounce_rate Trailing bounce rate per notable workspace.')
      lines.push('# TYPE acaos_sender_bounce_rate gauge')
      for (const w of domain.reputation.perWorkspace) {
        lines.push(`acaos_sender_bounce_rate${lbl({ workspace: w.workspaceId })} ${w.bounceRate}`)
      }
      lines.push('# HELP acaos_sender_complaint_rate Trailing complaint rate per notable workspace.')
      lines.push('# TYPE acaos_sender_complaint_rate gauge')
      for (const w of domain.reputation.perWorkspace) {
        lines.push(`acaos_sender_complaint_rate${lbl({ workspace: w.workspaceId })} ${w.complaintRate}`)
      }
      lines.push('# HELP acaos_sender_reputation_healthy 1 if the workspace is under thresholds, else 0.')
      lines.push('# TYPE acaos_sender_reputation_healthy gauge')
      for (const w of domain.reputation.perWorkspace) {
        lines.push(`acaos_sender_reputation_healthy${lbl({ workspace: w.workspaceId })} ${w.healthy ? 1 : 0}`)
      }
    }
  }
  if (domain.warmup?.length) {
    lines.push('# HELP acaos_warmup_day Current warmup day per warming workspace (0 = ramp complete).')
    lines.push('# TYPE acaos_warmup_day gauge')
    for (const w of domain.warmup) lines.push(`acaos_warmup_day${lbl({ workspace: w.workspaceId })} ${w.day}`)
    lines.push('# HELP acaos_warmup_cap Current warmup daily cap per warming workspace.')
    lines.push('# TYPE acaos_warmup_cap gauge')
    for (const w of domain.warmup) lines.push(`acaos_warmup_cap${lbl({ workspace: w.workspaceId })} ${w.cap}`)
  }

  lines.push('# HELP acaos_ai_cost_cents_total Estimated AI spend in cents, by metered action.')
  lines.push('# TYPE acaos_ai_cost_cents_total counter')
  for (const [action, cents] of aiCostCents.entries()) {
    lines.push(`acaos_ai_cost_cents_total${lbl({ action })} ${Math.round(cents * 100) / 100}`)
  }
  lines.push('# HELP acaos_ai_calls_total Metered AI calls, by action.')
  lines.push('# TYPE acaos_ai_calls_total counter')
  for (const [action, n] of aiCalls.entries()) {
    lines.push(`acaos_ai_calls_total${lbl({ action })} ${n}`)
  }

  // Provider circuit-breaker state — 1 while OPEN (provider degraded / shedding load).
  lines.push('# HELP acaos_circuit_open 1 if the provider circuit breaker is OPEN, else 0.')
  lines.push('# TYPE acaos_circuit_open gauge')
  for (const { provider, open } of snapshotBreakerStates()) {
    lines.push(`acaos_circuit_open${lbl({ provider })} ${open ? 1 : 0}`)
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
