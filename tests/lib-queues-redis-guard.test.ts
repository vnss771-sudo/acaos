// Unit test for the enqueue fail-fast guard in queues.ts: BullMQ's shared Redis
// connection queues commands (rather than rejecting them) while disconnected or
// reconnecting, so an unguarded .add() during a Redis outage hangs instead of
// failing. addTraced() checks connection.status first and throws a fast 503
// instead. This never issues a real Redis command (lazyConnect + no command
// triggered), so it needs no live Redis, unlike tests-redis/jobs.test.ts.

import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  getRedisConnection, resetRedisConnectionForTests, enqueueScoreProspects,
} from '../packages/backend-core/src/lib/queues.ts'
import { ApiError } from '../packages/backend-core/src/lib/errors.ts'

afterEach(async () => { await resetRedisConnectionForTests() })

test('enqueue fails fast (not a hang) when the connection is reconnecting', async () => {
  const conn = getRedisConnection()
  ;(conn as unknown as { status: string }).status = 'reconnecting'

  await assert.rejects(
    () => enqueueScoreProspects('ws1'),
    (err: unknown) => err instanceof ApiError && err.statusCode === 503,
  )
})

test('enqueue fails fast when the connection is closed', async () => {
  const conn = getRedisConnection()
  ;(conn as unknown as { status: string }).status = 'close'

  await assert.rejects(
    () => enqueueScoreProspects('ws1'),
    (err: unknown) => err instanceof ApiError && err.statusCode === 503,
  )
})

test('a never-yet-connected (lazyConnect) status does NOT trip the guard', () => {
  // 'wait' is ioredis's initial status before any command has ever been issued —
  // this must stay allowed through, or every process's first-ever enqueue would
  // incorrectly 503 before the lazy connection gets a chance to establish.
  const conn = getRedisConnection()
  assert.equal(conn.status, 'wait')
})
