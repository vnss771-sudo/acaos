// Redis-tier tests for the shared circuit-breaker store. The in-process breaker
// logic is unit-tested (tests/lib-circuit.test.ts); this verifies the Redis
// round-trip that lets one process broadcast an OPEN circuit so siblings
// (api <-> worker, replicas) adopt it — and that every op is fail-open.

import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import IORedis from 'ioredis'
import { createRedisBreakerStore } from '../packages/backend-core/src/lib/breakerStore.ts'
import { CircuitBreaker } from '../packages/backend-core/src/lib/circuit.ts'
import { flushRedis } from './helpers/redis.ts'

const redis = new IORedis(process.env.REDIS_URL as string, { maxRetriesPerRequest: null })
after(async () => { await redis.quit() })
beforeEach(async () => { await flushRedis() })

test('setOpenUntil/getOpenUntil round-trips the open window through Redis', async () => {
  const store = createRedisBreakerStore(redis)
  assert.equal(await store.getOpenUntil('openai'), 0, 'no key yet → not shared-open')

  const until = Date.now() + 30_000
  await store.setOpenUntil('openai', until)
  assert.equal(await store.getOpenUntil('openai'), until)
  // Scoped per label.
  assert.equal(await store.getOpenUntil('stripe'), 0)
})

test('the open key carries a TTL so it self-heals if no process clears it', async () => {
  const store = createRedisBreakerStore(redis)
  await store.setOpenUntil('apollo', Date.now() + 5_000)
  const ttl = await redis.ttl('cb:open:apollo')
  assert.ok(ttl > 0 && ttl <= 6, `expected a short TTL, got ${ttl}`)
})

test('a sibling breaker adopts OPEN that another process published', async () => {
  // Process A trips its circuit and broadcasts it.
  const storeA = createRedisBreakerStore(redis)
  const breakerA = new CircuitBreaker('provider-x', 1, 30_000, { store: storeA })
  await assert.rejects(breakerA.call(async () => { throw new Error('boom') }))
  assert.equal(breakerA.status, 'OPEN', 'A trips after threshold and publishes')

  // Process B (fresh breaker, shared store) must adopt OPEN and reject without
  // calling the provider.
  const storeB = createRedisBreakerStore(redis)
  const breakerB = new CircuitBreaker('provider-x', 5, 30_000, { store: storeB, syncIntervalMs: 0 })
  let called = false
  await assert.rejects(breakerB.call(async () => { called = true; return 'ok' }))
  assert.equal(called, false, 'B short-circuits on the shared-open state — provider never hit')
})

test('reads are fail-open when Redis is unavailable', async () => {
  const dead = new IORedis('redis://127.0.0.1:1', { maxRetriesPerRequest: 1, lazyConnect: true, retryStrategy: () => null })
  const store = createRedisBreakerStore(dead)
  // A store error must resolve to "not shared-open", never throw.
  assert.equal(await store.getOpenUntil('openai'), 0)
  await store.setOpenUntil('openai', Date.now() + 1000) // must not throw
  await dead.quit().catch(() => {})
})
