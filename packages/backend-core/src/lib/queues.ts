import { Redis as IORedis } from 'ioredis'
import { Queue } from 'bullmq'
import { createHash } from 'node:crypto'
import { CURRENT_PAYLOAD_VERSION } from './queueSchemas.js'

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

export function getQueue(name: string): Queue {
  if (!_queues.has(name)) {
    _queues.set(name, new Queue(name, { connection: getConnection() }))
  }
  return _queues.get(name)!
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
  return getQueue('research-lead').add('research-lead', { ...opts, schemaVersion: CURRENT_PAYLOAD_VERSION }, aiJobOpts)
}

export async function enqueueGenerateOutreach(opts: { leadId: string; workspaceId: string; initiatedByUserId?: string; requestId?: string; override?: boolean }) {
  return getQueue('generate-outreach').add('generate-outreach', { ...opts, schemaVersion: CURRENT_PAYLOAD_VERSION }, aiJobOpts)
}

export async function enqueueAnalyzeReply(opts: { replyBody: string; workspaceId: string; leadId?: string; initiatedByUserId?: string; requestId?: string }) {
  return getQueue('analyze-reply').add('analyze-reply', { ...opts, schemaVersion: CURRENT_PAYLOAD_VERSION }, aiJobOpts)
}

export async function enqueueSyncMailbox(workspaceId: string, userId?: string, requestId?: string) {
  return getQueue('sync-mailbox').add(
    'sync-mailbox',
    { workspaceId, userId, requestId, schemaVersion: CURRENT_PAYLOAD_VERSION },
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
  return getQueue('score-prospects').add('score-prospects', { workspaceId, requestId, schemaVersion: CURRENT_PAYLOAD_VERSION }, defaultJobOpts)
}

// Async prospect discovery. attempts:1 — a discovery run calls a metered, paid
// provider and the route already consumed the workspace's discovery quota, so a
// failed run must not silently re-hit the provider; failures surface as a FAILED
// (or PARTIAL) DiscoveryRun for the operator instead of being auto-retried.
export async function enqueueDiscoverProspects(runId: string, workspaceId: string, requestId?: string) {
  return getQueue('discover-prospects').add('discover-prospects', { runId, workspaceId, requestId, schemaVersion: CURRENT_PAYLOAD_VERSION }, {
    attempts: 1,
    ...jobRetention,
  })
}

export async function enqueueGenerateRecommendations(prospectId: string, workspaceId: string, requestId?: string) {
  return getQueue('generate-recommendations').add('generate-recommendations', { prospectId, workspaceId, requestId, schemaVersion: CURRENT_PAYLOAD_VERSION }, defaultJobOpts)
}

export async function enqueueCalibrate(workspaceId: string, requestId?: string) {
  return getQueue('calibrate-scoring').add('calibrate-scoring', { workspaceId, requestId, schemaVersion: CURRENT_PAYLOAD_VERSION }, defaultJobOpts)
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
  return getQueue('send-campaign').add('send-campaign', { campaignId, workspaceId, leadIds, requestId, schemaVersion: CURRENT_PAYLOAD_VERSION }, {
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
  return getQueue('send-followup').add(
    'send-followup',
    { taskId, workspaceId, requestId, schemaVersion: CURRENT_PAYLOAD_VERSION },
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
  'discover-prospects', 'retention-purge', 'send-followup'
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
