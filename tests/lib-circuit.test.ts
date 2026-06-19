// Circuit breaker — per-process behaviour plus the opt-in shared-store layer
// that lets sibling processes adopt an OPEN circuit a peer has tripped.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CircuitBreaker, CircuitOpenError, type BreakerStore } from '../packages/backend-core/src/lib/circuit.ts'

function fakeStore(initial: Record<string, number> = {}) {
  const state: Record<string, number> = { ...initial }
  const calls = { get: 0, set: 0 }
  const store: BreakerStore = {
    async getOpenUntil(label) { calls.get++; return state[label] ?? 0 },
    async setOpenUntil(label, untilMs) { calls.set++; state[label] = untilMs },
  }
  return { store, state, calls }
}

test('without a store, behaviour is purely per-process (fn runs, no sharing)', async () => {
  const cb = new CircuitBreaker('t', 2, 1000)
  const r = await cb.call(async () => 'ok')
  assert.equal(r, 'ok')
  assert.equal(cb.status, 'CLOSED')
})

test('trips OPEN after threshold consecutive failures', async () => {
  const cb = new CircuitBreaker('t', 2, 10_000)
  await assert.rejects(cb.call(async () => { throw new Error('boom') }))
  await assert.rejects(cb.call(async () => { throw new Error('boom') }))
  assert.equal(cb.isOpen, true)
  // Further calls short-circuit without invoking fn.
  let invoked = false
  await assert.rejects(
    cb.call(async () => { invoked = true; return 'x' }),
    (e) => e instanceof CircuitOpenError
  )
  assert.equal(invoked, false)
})

test('a CLOSED breaker adopts OPEN from the shared store without calling fn', async () => {
  const future = Date.now() + 30_000
  const { store, calls } = fakeStore({ 'shared-label': future })
  const cb = new CircuitBreaker('shared-label', 5, 30_000, { store })

  let invoked = false
  await assert.rejects(
    cb.call(async () => { invoked = true; return 'x' }),
    (e) => e instanceof CircuitOpenError
  )
  assert.equal(invoked, false, 'fn must not run when a sibling has the circuit open')
  assert.equal(cb.status, 'OPEN')
  assert.equal(calls.get, 1)
})

test('tripping OPEN broadcasts to the shared store', async () => {
  const { store, state, calls } = fakeStore()
  const cb = new CircuitBreaker('pub', 2, 5_000, { store })
  await assert.rejects(cb.call(async () => { throw new Error('boom') }))
  await assert.rejects(cb.call(async () => { throw new Error('boom') }))
  assert.equal(cb.isOpen, true)
  assert.equal(calls.set, 1, 'should publish exactly once on the trip')
  assert.ok(state['pub'] > Date.now(), 'published open-until must be in the future')
})

test('shared reads are throttled to at most one per syncInterval', async () => {
  const { store, calls } = fakeStore() // not open
  const cb = new CircuitBreaker('throttle', 5, 30_000, { store, syncIntervalMs: 10_000 })
  await cb.call(async () => 'a')
  await cb.call(async () => 'b')
  await cb.call(async () => 'c')
  assert.equal(calls.get, 1, 'subsequent calls within the interval must not re-read the store')
})

test('store read errors fail open — the call still runs', async () => {
  const store: BreakerStore = {
    async getOpenUntil() { throw new Error('redis down') },
    async setOpenUntil() { /* noop */ },
  }
  const cb = new CircuitBreaker('failopen', 5, 30_000, { store })
  let invoked = false
  const r = await cb.call(async () => { invoked = true; return 'ok' })
  assert.equal(invoked, true, 'a store error must never block the real call')
  assert.equal(r, 'ok')
})
