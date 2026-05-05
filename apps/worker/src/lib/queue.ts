import 'dotenv/config'
import IORedis from 'ioredis'
import { Queue } from 'bullmq'

export const connection = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  retryStrategy: (times) => Math.min(times * 1000, 10_000)
})

connection.on('error', (err) => console.error('[redis] Error:', err.message))
connection.on('connect', () => console.log('[redis] Connected'))

export const queues = {
  research: new Queue('research-lead', { connection }),
  outreach: new Queue('generate-outreach', { connection }),
  reply: new Queue('analyze-reply', { connection }),
  mailbox: new Queue('sync-mailbox', { connection })
}

export const defaultJobOptions = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5_000 },
  removeOnComplete: { count: 100, age: 24 * 60 * 60 },
  removeOnFail: { count: 200, age: 7 * 24 * 60 * 60 }
}
