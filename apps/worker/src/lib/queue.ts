import 'dotenv/config'
import IORedis from 'ioredis'
import { Queue } from 'bullmq'

export const connection = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', { maxRetriesPerRequest: null })

export const queues = {
  research: new Queue('research-lead', { connection }),
  outreach: new Queue('generate-outreach', { connection }),
  reply: new Queue('analyze-reply', { connection }),
  mailbox: new Queue('sync-mailbox', { connection })
}
