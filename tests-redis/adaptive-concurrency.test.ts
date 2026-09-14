// Live-Redis integration tier for queue-depth-adaptive concurrency: a real
// BullMQ Queue + Worker against a real Redis, driven by createAdaptiveScaler
// with an artificially fast poll interval (the pure decision logic itself is
// unit-tested in isolation in tests/worker-adaptive-concurrency.test.ts).

import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { Queue, Worker } from 'bullmq'
import IORedis from 'ioredis'
import { createAdaptiveScaler, type AdaptiveScalerEvent } from '../apps/worker/src/lib/adaptiveConcurrency.ts'
import { flushRedis } from './helpers/redis.ts'

const connection = new IORedis(process.env.REDIS_URL as string, { maxRetriesPerRequest: null })
after(async () => { await connection.quit() })
beforeEach(async () => { await flushRedis() })

function deferred<T = void>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

async function waitUntil(check: () => boolean, timeoutMs: number, intervalMs = 20): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timed out')
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

test('scales concurrency up toward max while the queue is backed up, then back down toward min once idle', async () => {
  const queueName = `adaptive-test-${Date.now()}`
  const queue = new Queue(queueName, { connection })

  // Every job blocks on this shared gate, so the queue stays visibly "backed up"
  // (waiting jobs pile up behind the currently-claimed ones) until the test
  // explicitly releases it — giving the scaler a real, sustained high-depth
  // signal to react to instead of a race against fast-completing jobs.
  const gate = deferred<void>()
  let started = 0
  const worker = new Worker(queueName, async () => { started += 1; await gate.promise }, { connection, concurrency: 1 })
  await worker.waitUntilReady()

  for (let i = 0; i < 6; i++) await queue.add('job', { i })

  const events: AdaptiveScalerEvent[] = []
  const scaler = createAdaptiveScaler(queueName, queue, worker, {
    pollIntervalMs: 50,
    config: { min: 1, max: 3, scaleUpAt: 2, scaleDownAt: 0, step: 1, confirmTicks: 1 },
    onChange: (e) => events.push(e),
  })

  try {
    await waitUntil(() => worker.concurrency === 3, 5_000)
    assert.equal(worker.concurrency, 3, 'scaled up to max while jobs kept queueing behind the blocked ones')
    assert.ok(events.some((e) => e.action === 'scale-up'))

    // Release every in-flight/queued job so the queue drains to empty.
    gate.resolve()
    await waitUntil(() => started >= 6, 5_000)
    await waitUntil(async () => {
      const counts = await queue.getJobCounts('waiting', 'active')
      return (counts.waiting ?? 0) === 0 && (counts.active ?? 0) === 0
    }, 5_000)

    await waitUntil(() => worker.concurrency === 1, 5_000)
    assert.equal(worker.concurrency, 1, 'scaled back down to min once the queue emptied out')
    assert.ok(events.some((e) => e.action === 'scale-down'))
  } finally {
    scaler.stop()
    await worker.close()
    await queue.close()
  }
})

test('a scale-down never abandons an in-flight job — it always completes', async () => {
  const queueName = `adaptive-test-${Date.now()}`
  const queue = new Queue(queueName, { connection })

  const gate = deferred<void>()
  const completedIds: string[] = []
  const worker = new Worker(queueName, async () => { await gate.promise; return { ok: true } }, { connection, concurrency: 3 })
  worker.on('completed', (job) => completedIds.push(job.id!))
  await worker.waitUntilReady()

  const jobs = await Promise.all([queue.add('job', {}), queue.add('job', {}), queue.add('job', {})])
  await waitUntil(async () => {
    const counts = await queue.getJobCounts('active')
    return (counts.active ?? 0) === 3
  }, 5_000)

  // Force an immediate scale-down to 1 while 3 jobs are already claimed/active —
  // exactly the scenario the adaptive scaler produces mid-flight.
  worker.concurrency = 1
  assert.equal(worker.concurrency, 1)

  gate.resolve()
  await waitUntil(() => completedIds.length === 3, 5_000)

  for (const j of jobs) {
    const state = await j.getState()
    assert.equal(state, 'completed', `job ${j.id} completed despite the concurrency drop while it was active`)
  }

  await worker.close()
  await queue.close()
})
