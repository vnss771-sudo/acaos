// Live-Redis integration tier for the DLQ auto-retry sweep: seeds real failed
// BullMQ jobs (one transient-looking, one not) against a real Redis and runs
// sweepQueueForAutoRetry against them, asserting only the transient one gets
// retried (the pure classifier itself is unit-tested in isolation in
// tests/worker-dlq-auto-retry.test.ts).

import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { Queue, Worker } from 'bullmq'
import IORedis from 'ioredis'
import { sweepQueueForAutoRetry, runAutoRetrySweep, DEFAULT_AUTO_RETRY_POLICY } from '../apps/worker/src/lib/dlqAutoRetry.ts'
import { flushRedis } from './helpers/redis.ts'

const connection = new IORedis(process.env.REDIS_URL as string, { maxRetriesPerRequest: null })
after(async () => { await connection.quit() })
beforeEach(async () => { await flushRedis() })

async function waitUntil(check: () => Promise<boolean> | boolean, timeoutMs: number, intervalMs = 20): Promise<void> {
  const start = Date.now()
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timed out')
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

/** Runs `queueName` to completion and returns once every added job has reached
 * the `failed` state — real BullMQ attempts/backoff exhaustion, not a fake. */
async function runToExhaustion(queueName: string, jobNames: Array<{ name: string; fail: string }>) {
  const queue = new Queue(queueName, { connection })
  const worker = new Worker(
    queueName,
    async (job) => { throw new Error(job.data.fail as string) },
    { connection, concurrency: 2 },
  )
  await worker.waitUntilReady()

  const added = await Promise.all(jobNames.map((j) =>
    queue.add(j.name, { fail: j.fail }, { attempts: 1, backoff: { type: 'fixed', delay: 1 } })
  ))

  await waitUntil(async () => {
    const counts = await queue.getJobCounts('failed')
    return (counts.failed ?? 0) === jobNames.length
  }, 10_000)

  await worker.close()
  return { queue, jobs: added }
}

test('sweepQueueForAutoRetry retries only the transient-looking failed job, leaves the permanent one', async () => {
  const queueName = `dlq-test-${Date.now()}`
  const { queue, jobs } = await runToExhaustion(queueName, [
    { name: 'transient-job', fail: 'connect ECONNREFUSED 127.0.0.1:443' },
    { name: 'permanent-job', fail: 'QUEUE_PAYLOAD_INVALID: bad payload' },
  ])

  try {
    const before = await queue.getJobCounts('failed', 'waiting', 'active', 'delayed')
    assert.equal(before.failed, 2, 'both jobs really are sitting in the failed set')

    const result = await sweepQueueForAutoRetry(queueName, queue, DEFAULT_AUTO_RETRY_POLICY)
    assert.equal(result.scanned, 2)
    assert.equal(result.retried, 1)
    assert.equal(result.skipped, 1)

    // The transient job left the failed set (BullMQ moved it back to waiting).
    const transientJob = await queue.getJob(jobs[0].id!)
    const transientState = await transientJob!.getState()
    assert.notEqual(transientState, 'failed', 'transient job was retried out of the failed set')

    // The permanent job is untouched, still failed, for an operator to triage.
    const permanentJob = await queue.getJob(jobs[1].id!)
    const permanentState = await permanentJob!.getState()
    assert.equal(permanentState, 'failed', 'permanent-looking failure was left alone')
  } finally {
    await queue.close()
  }
})

test('sweepQueueForAutoRetry respects the bonus-retry ceiling — stops retrying once exhausted', async () => {
  const queueName = `dlq-test-${Date.now()}`
  const queue = new Queue(queueName, { connection })
  // Kept running (unlike runToExhaustion, which closes its worker) so a retried
  // job that BullMQ moves back to `waiting` really gets reprocessed and re-fails
  // — attemptsMade climbing via real BullMQ bookkeeping, not simulated.
  const worker = new Worker(queueName, async () => { throw new Error('ETIMEDOUT') }, { connection, concurrency: 1 })
  await worker.waitUntilReady()
  const jobs = [await queue.add('transient-job', {}, { attempts: 1, backoff: { type: 'fixed', delay: 1 } })]
  await waitUntil(async () => (await queue.getJobCounts('failed')).failed === 1, 10_000)

  const policy = { ...DEFAULT_AUTO_RETRY_POLICY, maxBonusRetries: 1 }

  try {
    // 1st sweep: attemptsMade(1) - attempts(1) = 0 bonus used -> retries.
    let result = await sweepQueueForAutoRetry(queueName, queue, policy)
    assert.equal(result.retried, 1)

    // The retried job re-fails (still throws the same transient error) and lands
    // back in `failed` with attemptsMade now 2 (real BullMQ bookkeeping, not
    // simulated) — wait for it to genuinely re-fail before sweeping again.
    await waitUntil(async () => (await queue.getJobCounts('failed')).failed === 1, 10_000)

    // 2nd sweep: attemptsMade(2) - attempts(1) = 1 bonus used -> AT the ceiling -> skipped.
    result = await sweepQueueForAutoRetry(queueName, queue, policy)
    assert.equal(result.retried, 0, 'bonus-retry budget is exhausted')
    assert.equal(result.skipped, 1)

    const job = await queue.getJob(jobs[0].id!)
    assert.equal(await job!.getState(), 'failed', 'left in the failed set once the budget is spent')
  } finally {
    await worker.close()
    await queue.close()
  }
})

test('runAutoRetrySweep sweeps multiple queues in one pass', async () => {
  const nameA = `dlq-multi-a-${Date.now()}`
  const nameB = `dlq-multi-b-${Date.now()}`
  const { queue: queueA } = await runToExhaustion(nameA, [{ name: 'job', fail: 'ECONNRESET' }])
  const { queue: queueB } = await runToExhaustion(nameB, [{ name: 'job', fail: 'ECONNRESET' }])

  try {
    const queues: Record<string, Queue> = { [nameA]: queueA, [nameB]: queueB }
    const results = await runAutoRetrySweep([nameA, nameB], (name) => queues[name])
    assert.equal(results.length, 2)
    assert.ok(results.every((r) => r.retried === 1))
  } finally {
    await queueA.close()
    await queueB.close()
  }
})
