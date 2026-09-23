import { Redis as IORedis } from 'ioredis'
import { Queue, type Job, type JobsOptions } from 'bullmq'
import { createHash } from 'node:crypto'
import { CURRENT_PAYLOAD_VERSION } from './queueSchemas.js'
import { withEnqueueSpan } from './tracing.js'
import { ApiError } from './errors.js'

let _connection: IORedis | null = null

// The single Redis connection shared by both producers (API/worker enqueue) and,
// since the worker reuses this factory, the worker's BullMQ consumers too — so a
// process holds ONE connection with ONE reconnect policy instead of two divergent
// ones. maxRetriesPerRequest:null is required by BullMQ; retryStrategy keeps a
// long-running worker reconnecting through Redis flaps (capped backoff).
export function getRedisConnection(): IORedis {
  if (!_connection) {
    _connection = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      lazyConnect: true,
      retryStrategy: (times: number) => Math.min(times * 1000, 10_000),
    })
    _connection.on('error', (err: Error) => {
      console.warn('[redis] Connection error:', err.message)
    })
  }
  return _connection
}

// Back-compat internal alias.
const getConnection = getRedisConnection

const _queues = new Map<string, Queue>()

// Test-only: close every cached Queue (BullMQ opens its own duplicated
// connections per Queue — closing the Queue is what tears those down, a raw
// disconnect() on the shared connection leaves them retrying with no
// listener) and drop the shared connection so the next getRedisConnection()
// call builds a fresh instance. Without this, a `node --test` runner that
// ever exercised a queue against an unreachable Redis never exits.
export async function resetRedisConnectionForTests(): Promise<void> {
  await Promise.all([..._queues.values()].map(q => q.close().catch(() => {})))
  _queues.clear()
  _connection?.disconnect()
  _connection = null
}

export function getQueue(name: string): Queue {
  if (!_queues.has(name)) {
    _queues.set(name, new Queue(name, { connection: getConnection() }))
  }
  return _queues.get(name)!
}

// Every enqueue below routes through this: it stamps schemaVersion (as every
// producer already did) AND wraps the .add() in a tracing span whose W3C
// traceparent is injected onto the payload as `traceparent` — see
// lib/tracing.ts. Centralized here so the ~11 enqueue functions below don't
// each hand-roll the same span/attribute wiring.
async function addTraced(queueName: string, jobName: string, data: Record<string, unknown>, jobOpts: JobsOptions): Promise<Job> {
  // maxRetriesPerRequest: null with a never-giving-up retryStrategy (required by
  // BullMQ, set above in getRedisConnection) means ioredis QUEUES commands issued
  // while disconnected/reconnecting rather than rejecting them — so a plain
  // `.add()` during a Redis outage would hang for the outage's duration instead
  // of failing fast. Same reasoning as providerQuota.ts's checkProviderQuota, but
  // this connection is lazyConnect with no eager .connect() anywhere (unlike
  // providerQuota's store), so its status starts at 'wait' on every cold start —
  // a bare `!== 'ready'` check would wrongly reject every process's first enqueue
  // before the lazy connection ever gets a chance to establish. Only 'reconnecting'
  // (ioredis is actively retrying after a failure) or 'close'/'end' (connection
  // down, not merely not-yet-started) are the states that actually mean "an
  // .add() right now would hang" — 'wait'/'connecting'/'connect' all still resolve
  // on the command itself. `status` is undefined for a test fake with no real
  // ioredis connection.
  const status = getConnection().status
  if (status === 'reconnecting' || status === 'close' || status === 'end') {
    throw new ApiError(503, 'Job queue temporarily unavailable — try again shortly')
  }
  return withEnqueueSpan(
    queueName,
    jobName,
    {
      'acaos.request_id': typeof data.requestId === 'string' ? data.requestId : undefined,
      'acaos.workspace_id': typeof data.workspaceId === 'string' ? data.workspaceId : undefined,
    },
    (traceparent) => getQueue(queueName).add(jobName, { ...data, schemaVersion: CURRENT_PAYLOAD_VERSION, traceparent }, jobOpts),
  )
}

// Cap retained job records so completed/failed jobs don't accumulate unbounded in
// Redis. The AI queues run one job per lead, so without these the high-volume
// queues grow forever. Keep the last 1000 completed (or anything older than a day)
// and the last 5000 failed for post-mortem inspection.
const jobRetention = {
  removeOnComplete: { count: 1000, age: 86_400 },
  removeOnFail: { count: 5000 },
} as const

const defaultJobOpts = { attempts: 3, backoff: { type: 'exponential', delay: 5000 }, ...jobRetention } as const
// AI jobs use a longer backoff so retries always wait past the OpenAI circuit
// breaker's resetAfterMs (30s) — prevents burning all attempts while OPEN.
const aiJobOpts = { attempts: 3, backoff: { type: 'exponential', delay: 35_000 }, ...jobRetention } as const

// Job payloads are scoped by workspaceId (authoritative for polling/auth) plus an
// optional initiatedByUserId. Object params prevent the positional confusion that
// previously let ingest pass a workspaceId into a `userId` field.
export async function enqueueResearchLead(opts: { leadId: string; workspaceId: string; initiatedByUserId?: string; requestId?: string }) {
  return addTraced('research-lead', 'research-lead', opts, aiJobOpts)
}

export async function enqueueGenerateOutreach(opts: { leadId: string; workspaceId: string; initiatedByUserId?: string; requestId?: string; override?: boolean }) {
  return addTraced('generate-outreach', 'generate-outreach', opts, aiJobOpts)
}

export async function enqueueAnalyzeReply(opts: { replyBody: string; workspaceId: string; leadId?: string; initiatedByUserId?: string; requestId?: string }) {
  return addTraced('analyze-reply', 'analyze-reply', opts, aiJobOpts)
}

export async function enqueueSyncMailbox(workspaceId: string, userId?: string, requestId?: string) {
  return addTraced(
    'sync-mailbox',
    'sync-mailbox',
    { workspaceId, userId, requestId },
    // Bounded retention like every other queue — the auto-sync scheduler enqueues
    // these continuously, so without it completed/failed sync jobs grow unbounded
    // in Redis.
    { attempts: 2, backoff: { type: 'exponential', delay: 10000 }, ...jobRetention }
  )
}

export async function getJobById(queueName: string, jobId: string) {
  const { Job } = await import('bullmq')
  return Job.fromId(getQueue(queueName), jobId)
}

export async function enqueueScoreProspects(workspaceId: string, requestId?: string) {
  return addTraced('score-prospects', 'score-prospects', { workspaceId, requestId }, defaultJobOpts)
}

// Async prospect discovery. attempts:1 — a discovery run calls a metered, paid
// provider and the route already consumed the workspace's discovery quota, so a
// failed run must not silently re-hit the provider; failures surface as a FAILED
// (or PARTIAL) DiscoveryRun for the operator instead of being auto-retried.
export async function enqueueDiscoverProspects(runId: string, workspaceId: string, requestId?: string) {
  return addTraced('discover-prospects', 'discover-prospects', { runId, workspaceId, requestId }, {
    attempts: 1,
    ...jobRetention,
  })
}

export async function enqueueGenerateRecommendations(prospectId: string, workspaceId: string, requestId?: string) {
  return addTraced('generate-recommendations', 'generate-recommendations', { prospectId, workspaceId, requestId }, defaultJobOpts)
}

export async function enqueueCalibrate(workspaceId: string, requestId?: string) {
  return addTraced('calibrate-scoring', 'calibrate-scoring', { workspaceId, requestId }, defaultJobOpts)
}

// Deterministic jobId so repeated "launch" clicks within the same minute collapse
// to a single send job (BullMQ ignores an add with an existing jobId). The minute
// bucket still allows a legitimate re-launch later; the lead set is part of the
// key so "send all" and "send subset" are distinct operations. Pure (clock
// injectable) so the dedup contract can be unit-tested without Redis.
// NOTE: BullMQ forbids ':' in custom job IDs (it's the internal Redis key
// separator), so use '-'. cuids/hex/number segments contain no '-'.
export function sendCampaignJobId(
  campaignId: string,
  workspaceId: string,
  leadIds?: string[],
  now: number = Date.now(),
): string {
  const leadKey = leadIds?.length ? [...leadIds].sort().join(',') : 'all'
  const leadHash = createHash('sha256').update(leadKey).digest('hex').slice(0, 16)
  const minuteBucket = Math.floor(now / 60_000)
  return `send-campaign-${workspaceId}-${campaignId}-${leadHash}-${minuteBucket}`
}

export async function enqueueSendCampaign(campaignId: string, workspaceId: string, leadIds?: string[], requestId?: string) {
  return addTraced('send-campaign', 'send-campaign', { campaignId, workspaceId, leadIds, requestId }, {
    jobId: sendCampaignJobId(campaignId, workspaceId, leadIds),
    attempts: 2,
    backoff: { type: 'exponential', delay: 10_000 },
    removeOnComplete: { count: 1000, age: 86_400 },
    removeOnFail: { count: 5000, age: 30 * 86_400 }
  })
}

// Enqueue one due follow-up step. The jobId is per (task, minute) so two
// overlapping scans in the same minute can't double-enqueue the same task, while a
// cap-deferred task (parked back at SCHEDULED) is re-picked on the next minute's
// scan. The real double-send guard is the processor's atomic SCHEDULED→PROCESSING
// claim — this is just flood control. attempts:2 with a long backoff (past the AI
// circuit breaker) but follow-ups never burn quota on retry since send is idempotent
// per (campaign, lead, step).
export function sendFollowupJobId(taskId: string, now: number = Date.now()): string {
  return `send-followup-${taskId}-${Math.floor(now / 60_000)}`
}

export async function enqueueSendFollowup(taskId: string, workspaceId?: string, requestId?: string) {
  return addTraced(
    'send-followup',
    'send-followup',
    { taskId, workspaceId, requestId },
    { jobId: sendFollowupJobId(taskId), attempts: 2, backoff: { type: 'exponential', delay: 30_000 }, ...jobRetention },
  )
}

// Scan for due, SCHEDULED follow-up tasks and enqueue a per-task send job for each.
// The worker's scheduler calls this on an interval ONLY when FOLLOWUPS_ENABLED, so
// when the global flag is off no follow-up ever leaves the queue. Bounded per scan
// so a backlog drains steadily rather than flooding the queue in one tick.
export async function enqueueDueFollowups(now: Date = new Date(), limit = 500): Promise<number> {
  const { prisma } = await import('./prisma.js')
  const due = await prisma.followupTask.findMany({
    where: { status: 'SCHEDULED', scheduledFor: { lte: now } },
    select: { id: true, workspaceId: true },
    orderBy: { scheduledFor: 'asc' },
    take: limit,
  })
  for (const t of due) await enqueueSendFollowup(t.id, t.workspaceId)
  return due.length
}

// On-demand trigger for the retention sweep (the worker also runs it daily). The
// fixed jobId collapses concurrent manual triggers within the same minute.
export async function enqueueRetentionPurge() {
  return getQueue('retention-purge').add('retention-purge', {}, {
    jobId: `retention-purge-${Math.floor(Date.now() / 60_000)}`,
    attempts: 1,
    removeOnComplete: { count: 10 },
    removeOnFail: { count: 20 },
  })
}

const ALL_QUEUES = [
  'research-lead', 'generate-outreach', 'analyze-reply', 'sync-mailbox',
  'send-campaign', 'score-prospects', 'calibrate-scoring', 'generate-recommendations',
  'discover-prospects', 'retention-purge', 'send-followup', 'dlq-auto-retry', 'domain-health'
]

export async function getQueueStats() {
  return Promise.all(
    ALL_QUEUES.map(async name => {
      const q = getQueue(name)
      const counts = await q.getJobCounts('active', 'waiting', 'completed', 'failed')
      return { name, ...counts }
    })
  )
}
