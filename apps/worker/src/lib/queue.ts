import 'dotenv/config'
import { Redis } from 'ioredis'
import { Queue } from 'bullmq'

export const connection = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  retryStrategy: (times: number) => Math.min(times * 1000, 10_000)
})

connection.on('error', (err: Error) => console.error('[redis] Error:', err.message))
connection.on('connect', () => console.log('[redis] Connected'))

export const defaultJobOptions = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5_000 },
  removeOnComplete: { count: 100, age: 24 * 60 * 60 },
  removeOnFail: { count: 200, age: 7 * 24 * 60 * 60 }
}

// Named queue registry — all 7 queues the worker listens on
export const QUEUE_NAMES = [
  'research-lead',
  'generate-outreach',
  'analyze-reply',
  'sync-mailbox',
  'score-prospects',
  'generate-recommendations',
  'calibrate-scoring',
] as const

export type QueueName = typeof QUEUE_NAMES[number]

const _queues = new Map<string, Queue>()

export function getQueue(name: string): Queue {
  if (!_queues.has(name)) {
    _queues.set(name, new Queue(name, { connection }))
  }
  return _queues.get(name)!
}

// Legacy named exports kept for back-compat
export const queues = {
  research:        getQueue('research-lead'),
  outreach:        getQueue('generate-outreach'),
  reply:           getQueue('analyze-reply'),
  mailbox:         getQueue('sync-mailbox'),
  scoreProspects:  getQueue('score-prospects'),
  recommendations: getQueue('generate-recommendations'),
  calibrate:       getQueue('calibrate-scoring'),
}
