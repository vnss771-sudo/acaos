import IORedis from 'ioredis'
import { Queue } from 'bullmq'

let _connection: IORedis | null = null

function getConnection(): IORedis {
  if (!_connection) {
    _connection = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      lazyConnect: true
    })
    _connection.on('error', (err) => {
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

const defaultJobOpts = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5_000 },
  removeOnComplete: { count: 100, age: 24 * 60 * 60 },
  removeOnFail:     { count: 200, age: 7 * 24 * 60 * 60 },
}

export async function enqueueResearchLead(leadId: string, userId: string) {
  return getQueue('research-lead').add('research-lead', { leadId, userId }, defaultJobOpts)
}

export async function enqueueGenerateOutreach(leadId: string, userId: string) {
  return getQueue('generate-outreach').add('generate-outreach', { leadId, userId }, defaultJobOpts)
}

export async function enqueueAnalyzeReply(replyBody: string, leadId?: string, userId?: string, prospectId?: string) {
  return getQueue('analyze-reply').add('analyze-reply', { replyBody, leadId, userId, prospectId }, defaultJobOpts)
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

export async function enqueueGenerateStrategyCards(workspaceId: string) {
  return getQueue('generate-strategy-cards').add(
    'generate-strategy-cards',
    { workspaceId },
    { ...defaultJobOpts, jobId: `strategy-cards:${workspaceId}` }
  )
}

export async function enqueueAdvanceCadence(enrollmentId: string) {
  return getQueue('advance-cadence').add('advance-cadence', { enrollmentId }, defaultJobOpts)
}

export async function enqueueHarvestSignals(workspaceId: string) {
  return getQueue('harvest-signals').add(
    'harvest-signals',
    { workspaceId },
    { ...defaultJobOpts, jobId: `harvest-signals:${workspaceId}` }
  )
}

export async function enqueueReEngage(workspaceId: string) {
  return getQueue('re-engage').add(
    're-engage',
    { workspaceId },
    { ...defaultJobOpts, jobId: `re-engage:${workspaceId}` }
  )
}

export async function enqueueGenerateOpportunityBrief(prospectId: string, workspaceId: string) {
  return getQueue('generate-opportunity-brief').add(
    'generate-opportunity-brief',
    { prospectId, workspaceId },
    { ...defaultJobOpts, jobId: `opportunity-brief:${prospectId}` }
  )
}
