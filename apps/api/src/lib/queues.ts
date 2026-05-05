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

export function getQueue(name: string) {
  return new Queue(name, { connection: getConnection() })
}

export async function enqueueResearchLead(leadId: string) {
  const q = getQueue('research-lead')
  return q.add('research-lead', { leadId }, { attempts: 3, backoff: { type: 'exponential', delay: 5000 } })
}

export async function enqueueGenerateOutreach(leadId: string) {
  const q = getQueue('generate-outreach')
  return q.add('generate-outreach', { leadId }, { attempts: 3, backoff: { type: 'exponential', delay: 5000 } })
}

export async function enqueueAnalyzeReply(replyBody: string, leadId?: string) {
  const q = getQueue('analyze-reply')
  return q.add('analyze-reply', { replyBody, leadId }, { attempts: 3, backoff: { type: 'exponential', delay: 5000 } })
}

export async function enqueueSyncMailbox(workspaceId: string) {
  const q = getQueue('sync-mailbox')
  return q.add('sync-mailbox', { workspaceId }, { attempts: 2, backoff: { type: 'exponential', delay: 10000 } })
}

export async function getJobById(queueName: string, jobId: string) {
  const { Job } = await import('bullmq')
  const q = getQueue(queueName)
  return Job.fromId(q, jobId)
}
