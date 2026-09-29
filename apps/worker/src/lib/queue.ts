import 'dotenv/config'
import { Queue } from 'bullmq'
import { getRedisConnection } from '@acaos/backend-core/lib/queues.js'

// Reuse the SINGLE shared Redis connection (and its reconnect policy) that the
// enqueue helpers in backend-core already use, so the worker process holds one
// connection for both consuming and producing jobs rather than two with
// divergent reconnect behaviour.
export const connection = getRedisConnection()

const _queues = new Map<string, Queue>()

export function getQueue(name: string): Queue {
  if (!_queues.has(name)) {
    _queues.set(name, new Queue(name, { connection }))
  }
  return _queues.get(name)!
}
