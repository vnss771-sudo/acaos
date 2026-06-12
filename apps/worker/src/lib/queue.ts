import 'dotenv/config'
import IORedis from 'ioredis'
import { Queue } from 'bullmq'

export const connection = new IORedis(process.env.REDIS_URL!, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  retryStrategy: (times) => Math.min(times * 1000, 10_000)
})

connection.on('error', (err) => console.error('[redis] Error:', err.message))
connection.on('connect', () => console.log('[redis] Connected'))

export const defaultJobOptions = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5_000 },
  removeOnComplete: { count: 100, age: 24 * 60 * 60 },
  removeOnFail: { count: 200, age: 7 * 24 * 60 * 60 }
}

// Named queue registry — all 15 queues the worker listens on
export const QUEUE_NAMES = [
  'research-lead',
  'generate-outreach',
  'analyze-reply',
  'sync-mailbox',
  'score-prospects',
  'generate-recommendations',
  'calibrate-scoring',
  'generate-strategy-cards',
  'advance-cadence',
  'harvest-signals',
  're-engage',
  'generate-opportunity-brief',
  'retrain-signal-weights',
  'maintenance',
  'daily-brief',
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
  strategyCards:   getQueue('generate-strategy-cards'),
}
