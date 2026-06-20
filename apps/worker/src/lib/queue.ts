import 'dotenv/config'
import { Queue } from 'bullmq'
import { getRedisConnection } from '@acaos/backend-core/lib/queues.js'

// Reuse the SINGLE shared Redis connection (and its reconnect policy) that the
// enqueue helpers in backend-core already use, so the worker process holds one
// connection for both consuming and producing jobs rather than two with
// divergent reconnect behaviour.
export const connection = getRedisConnection()

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
