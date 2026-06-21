// Unit tests for the single-flight TTL cache behind read-hot endpoints.
// Covers the two guarantees that matter for the /api/stats load-test fix:
// concurrent coalescing (one loader call per burst) and bounded staleness.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTtlCache, clearAllTtlCaches } from '../apps/api/src/lib/ttlCache.ts'

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('single-flight: concurrent gets for one key invoke the loader once', async () => {
  const cache = createTtlCache<number>(0)
  let calls = 0
  const loader = async () => { calls++; await tick(10); return 42 }

  const results = await Promise.all(
    Array.from({ length: 50 }, () => cache.get('k', loader)),
  )

  assert.equal(calls, 1, 'loader should run exactly once for a concurrent burst')
  assert.deepEqual(new Set(results), new Set([42]))
})

test('ttl=0 is pure single-flight: sequential (awaited) gets recompute', async () => {
  const cache = createTtlCache<number>(0)
  let calls = 0
  const loader = async () => { calls++; return calls }

  assert.equal(await cache.get('k', loader), 1)
  assert.equal(await cache.get('k', loader), 2, 'no stale read once the load settled')
  assert.equal(calls, 2)
})

test('ttl>0 serves the cached value within the window, then recomputes', async () => {
  // Injected clock keeps this deterministic — a real 30ms TTL flaked under
  // concurrent test files when the event loop stalled >30ms between gets.
  let nowMs = 1_000
  const cache = createTtlCache<number>(30, () => nowMs)
  let calls = 0
  const loader = async () => { calls++; return calls }

  assert.equal(await cache.get('k', loader), 1)
  nowMs += 20 // still within the 30ms window
  assert.equal(await cache.get('k', loader), 1, 'served from cache within TTL')
  assert.equal(calls, 1)

  nowMs += 25 // now 45ms after the store — past the 30ms TTL
  assert.equal(await cache.get('k', loader), 2, 'recomputes after TTL expiry')
  assert.equal(calls, 2)
})

test('keys are isolated', async () => {
  const cache = createTtlCache<string>(1_000)
  assert.equal(await cache.get('a', async () => 'A'), 'A')
  assert.equal(await cache.get('b', async () => 'B'), 'B')
  assert.equal(await cache.get('a', async () => 'A2'), 'A', 'a is still cached')
})

test('a failed load is not cached and does not wedge the key', async () => {
  const cache = createTtlCache<number>(1_000)
  let attempt = 0
  const loader = async () => { attempt++; if (attempt === 1) throw new Error('boom'); return 7 }

  await assert.rejects(() => cache.get('k', loader), /boom/)
  // The next caller retries from scratch (in-flight marker was cleared).
  assert.equal(await cache.get('k', loader), 7)
  assert.equal(attempt, 2)
})

test('delete() and clearAllTtlCaches() drop cached values', async () => {
  const cache = createTtlCache<number>(1_000)
  let calls = 0
  const loader = async () => { calls++; return calls }

  assert.equal(await cache.get('k', loader), 1)
  cache.delete('k')
  assert.equal(await cache.get('k', loader), 2, 'recomputes after delete')

  clearAllTtlCaches()
  assert.equal(await cache.get('k', loader), 3, 'recomputes after global clear')
})
