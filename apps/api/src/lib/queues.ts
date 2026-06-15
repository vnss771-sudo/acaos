import { Redis as IORedis } from 'ioredis'
import { Queue } from 'bullmq'

let _connection: IORedis | null = null

function getConnection(): IORedis {
  if (!_connection) {
    _connection = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      lazyConnect: true
    })
    _connection.on('error', (err: Error) => {
      console.warn('[redis] Connection error:', err.message)
    })
  }
  return _connection
}

const _queues = new Map<string, Queue>()

export function getQueue(name: string): Queue {
  if (!_queues.has(name)) {
    _queues.set(name, new Queue(name, { connection: getConnection() }))
  }
  return _queues.get(name)!
}

const defaultJobOpts = { attempts: 3, backoff: { type: 'exponential', delay: 5000 } } as const
// AI jobs use a longer backoff so retries always wait past the OpenAI circuit
// breaker's resetAfterMs (30s) — prevents burning all attempts while OPEN.
const aiJobOpts = { attempts: 3, backoff: { type: 'exponential', delay: 35_000 } } as const

// Job payloads are scoped by workspaceId (authoritative for polling/auth) plus an
// optional initiatedByUserId. Object params prevent the positional confusion that
// previously let ingest pass a workspaceId into a `userId` field.
export async function enqueueResearchLead(opts: { leadId: string; workspaceId: string; initiatedByUserId?: string }) {
  return getQueue('research-lead').add('research-lead', opts, aiJobOpts)
}

export async function enqueueGenerateOutreach(opts: { leadId: string; workspaceId: string; initiatedByUserId?: string }) {
  return getQueue('generate-outreach').add('generate-outreach', opts, aiJobOpts)
}

export async function enqueueAnalyzeReply(opts: { replyBody: string; workspaceId: string; leadId?: string; initiatedByUserId?: string }) {
  return getQueue('analyze-reply').add('analyze-reply', opts, aiJobOpts)
}

export async function enqueueSyncMailbox(workspaceId: string, userId?: string) {
  return getQueue('sync-mailbox').add(
    'sync-mailbox',
    { workspaceId, userId },
    { attempts: 2, backoff: { type: 'exponential', delay: 10000 } }
  )
}

export async function getJobById(queueName: string, jobId: string) {
  const { Job } = await import('bullmq')
  return Job.fromId(getQueue(queueName), jobId)
}

export async function enqueueScoreProspects(workspaceId: string) {
  return getQueue('score-prospects').add('score-prospects', { workspaceId }, defaultJobOpts)
}

export async function enqueueGenerateRecommendations(prospectId: string, workspaceId: string) {
  return getQueue('generate-recommendations').add('generate-recommendations', { prospectId, workspaceId }, defaultJobOpts)
}

export async function enqueueCalibrate(workspaceId: string) {
  return getQueue('calibrate-scoring').add('calibrate-scoring', { workspaceId }, defaultJobOpts)
}

export async function enqueueSendCampaign(campaignId: string, workspaceId: string, leadIds?: string[]) {
  return getQueue('send-campaign').add('send-campaign', { campaignId, workspaceId, leadIds }, {
    attempts: 2,
    backoff: { type: 'exponential', delay: 10_000 }
  })
}

const ALL_QUEUES = [
  'research-lead', 'generate-outreach', 'analyze-reply', 'sync-mailbox',
  'send-campaign', 'score-prospects', 'calibrate-scoring', 'generate-recommendations'
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
