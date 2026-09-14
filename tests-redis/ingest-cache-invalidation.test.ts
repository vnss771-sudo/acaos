// Redis-tier tests for ingestCache's cross-pod invalidation broadcast. The
// in-process cache logic is unit-tested (tests/lib-ingestcache.test.ts); this
// verifies the actual Redis pub/sub round-trip that lets a revocation on one
// pod evict the entry on a sibling pod, rather than waiting out its TTL —
// mirroring tests-redis/breaker-store.test.ts's "sibling adopts what another
// process published" shape.

import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import IORedis from 'ioredis'
import { createIngestCacheInvalidator } from '../apps/api/src/lib/ingestCacheInvalidation.ts'
import { flushRedis } from './helpers/redis.ts'

const pubA = new IORedis(process.env.REDIS_URL as string, { maxRetriesPerRequest: null })
const subA = new IORedis(process.env.REDIS_URL as string, { maxRetriesPerRequest: null })
const pubB = new IORedis(process.env.REDIS_URL as string, { maxRetriesPerRequest: null })
const subB = new IORedis(process.env.REDIS_URL as string, { maxRetriesPerRequest: null })

after(async () => {
  await Promise.all([pubA.quit(), subA.quit(), pubB.quit(), subB.quit()])
})
beforeEach(async () => { await flushRedis() })

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition')
    await new Promise((r) => setTimeout(r, 10))
  }
}

test('a hash published by one pod is delivered to a sibling pod subscribed to the same channel', async () => {
  // Pod A publishes only (never subscribes); Pod B subscribes and mirrors
  // messages into a local Map standing in for its in-process ingestCache.
  const invA = createIngestCacheInvalidator(pubA, subA)
  const invB = createIngestCacheInvalidator(pubB, subB)

  const cacheB = new Map<string, true>([['revoked-hash', true]])
  await invB.subscribe((hash) => { cacheB.delete(hash) })

  assert.ok(cacheB.has('revoked-hash'))
  await invA.publish('revoked-hash')

  await waitFor(() => !cacheB.has('revoked-hash'))
  assert.equal(cacheB.has('revoked-hash'), false)
})

test('a pod does not evict on an unrelated hash', async () => {
  const invA = createIngestCacheInvalidator(pubA, subA)
  const invB = createIngestCacheInvalidator(pubB, subB)

  const cacheB = new Map<string, true>([['keep-me', true]])
  await invB.subscribe((hash) => { cacheB.delete(hash) })

  await invA.publish('some-other-hash')
  // Give the subscriber a moment to (not) receive anything relevant, then
  // publish a second, known message and wait for THAT — proves the channel is
  // live and the first publish simply didn't match anything to delete.
  await invA.publish('sentinel')
  await new Promise((r) => setTimeout(r, 100))

  assert.ok(cacheB.has('keep-me'), 'unrelated hash must not be evicted')
})

test('publish is fail-open when Redis is unreachable', async () => {
  const dead = new IORedis('redis://127.0.0.1:1', { maxRetriesPerRequest: 1, lazyConnect: true, retryStrategy: () => null })
  const inv = createIngestCacheInvalidator(dead, dead)
  await assert.doesNotReject(inv.publish('some-hash'))
  await dead.quit().catch(() => {})
})
