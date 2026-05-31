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

const defaultJobOpts = { attempts: 3, backoff: { type: 'exponential', delay: 5000 } } as const

export async function enqueueResearchLead(leadId: string, userId: string) {
  return getQueue('research-lead').add('research-lead', { leadId, userId }, defaultJobOpts)
}

export async function enqueueGenerateOutreach(leadId: string, userId: string) {
  return getQueue('generate-outreach').add('generate-outreach', { leadId, userId }, defaultJobOpts)
}

export async function enqueueAnalyzeReply(replyBody: string, leadId?: string, userId?: string) {
  return getQueue('analyze-reply').add('analyze-reply', { replyBody, leadId, userId }, defaultJobOpts)
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
