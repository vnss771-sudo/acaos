import test from 'node:test'
import assert from 'node:assert/strict'
import { createCachedValue } from '../packages/backend-core/src/lib/cachedValue.ts'

// A controllable clock for deterministic TTL assertions.
function fakeClock(start = 1000) {
  let t = start
  return { now: () => t, advance: (ms: number) => { t += ms } }
}

test('serves a cached value within the TTL and recomputes after it elapses', async () => {
  const clock = fakeClock()
  let calls = 0
  const cache = createCachedValue(async () => { calls++; return calls }, 100, clock.now)

  assert.equal(await cache.get(), 1)
  assert.equal(await cache.get(), 1) // cached
  clock.advance(50)
  assert.equal(await cache.get(), 1) // still fresh
  assert.equal(calls, 1)

  clock.advance(60) // total 110 > ttl 100 → stale
  assert.equal(await cache.get(), 2) // recomputed
  assert.equal(calls, 2)
})

test('coalesces concurrent callers onto a single in-flight computation', async () => {
  const clock = fakeClock()
  let calls = 0
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  const cache = createCachedValue(async () => { calls++; await gate; return calls }, 1000, clock.now)

  const [a, b, c] = [cache.get(), cache.get(), cache.get()]
  release()
  assert.deepEqual(await Promise.all([a, b, c]), [1, 1, 1])
  assert.equal(calls, 1, 'three racing gets triggered exactly one compute')
})

test('does not cache failures — the next call retries', async () => {
  const clock = fakeClock()
  let calls = 0
  const cache = createCachedValue(async () => { calls++; if (calls === 1) throw new Error('boom'); return calls }, 1000, clock.now)

  await assert.rejects(() => cache.get(), /boom/)
  assert.equal(await cache.get(), 2) // retried, not stuck on the failure
  assert.equal(calls, 2)
})

test('invalidate() forces the next get to recompute', async () => {
  const clock = fakeClock()
  let calls = 0
  const cache = createCachedValue(async () => { calls++; return calls }, 10_000, clock.now)
  assert.equal(await cache.get(), 1)
  cache.invalidate()
  assert.equal(await cache.get(), 2)
})
