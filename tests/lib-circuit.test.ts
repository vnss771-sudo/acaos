// Unit tests for lib/circuit — the circuit breaker guarding external calls
// (OpenAI / Stripe / Apollo). Pure state machine, no I/O: we drive it with a
// controllable fake clock so the OPEN→HALF_OPEN→CLOSED transitions and the
// reset window are deterministic.

import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { CircuitBreaker, CircuitOpenError } from '../apps/api/src/lib/circuit.ts'

// Swap Date.now for a fake clock we can advance by hand.
const realNow = Date.now
let clock = 0
function setClock(ms: number) { clock = ms; Date.now = () => clock }
afterEach(() => { Date.now = realNow; clock = 0 })

const fail = () => Promise.reject(new Error('boom'))
const ok = () => Promise.resolve('ok')

async function expectReject(fn: () => Promise<unknown>): Promise<unknown> {
  try { await fn(); assert.fail('expected rejection') } catch (e) { return e }
}

test('passes through results and stays CLOSED while calls succeed', async () => {
  setClock(0)
  const cb = new CircuitBreaker('t', 3, 1000)
  assert.equal(await cb.call(ok), 'ok')
  assert.equal(cb.status, 'CLOSED')
  assert.equal(cb.isOpen, false)
})

test('trips OPEN only after `threshold` consecutive failures', async () => {
  setClock(0)
  const cb = new CircuitBreaker('t', 3, 1000)
  await expectReject(() => cb.call(fail))
  await expectReject(() => cb.call(fail))
  assert.equal(cb.status, 'CLOSED', 'still closed at threshold-1')
  await expectReject(() => cb.call(fail))
  assert.equal(cb.status, 'OPEN', 'open at threshold')
  assert.equal(cb.isOpen, true)
})

test('while OPEN it short-circuits with CircuitOpenError without invoking fn', async () => {
  setClock(0)
  const cb = new CircuitBreaker('t', 1, 1000)
  await expectReject(() => cb.call(fail)) // trips immediately (threshold 1)
  let invoked = false
  const err = await expectReject(() => cb.call(async () => { invoked = true; return 'x' }))
  assert.ok(err instanceof CircuitOpenError)
  assert.equal((err as CircuitOpenError).retryAfterMs, 1000)
  assert.equal(invoked, false, 'underlying fn must not run while open')
})

test('after the reset window it probes (HALF_OPEN) and a success closes it', async () => {
  setClock(0)
  const cb = new CircuitBreaker('t', 1, 1000)
  await expectReject(() => cb.call(fail)) // OPEN at t=0
  setClock(1000)                          // reset window elapsed
  assert.equal(await cb.call(ok), 'ok')   // probe succeeds
  assert.equal(cb.status, 'CLOSED')
  assert.equal(cb.isOpen, false)
})

test('a failed probe re-opens the breaker', async () => {
  setClock(0)
  const cb = new CircuitBreaker('t', 1, 1000)
  await expectReject(() => cb.call(fail)) // OPEN
  setClock(1000)
  await expectReject(() => cb.call(fail)) // probe fails → OPEN again
  assert.equal(cb.status, 'OPEN')
  // Still inside the new reset window → short-circuits again.
  const err = await expectReject(() => cb.call(ok))
  assert.ok(err instanceof CircuitOpenError)
})

test('before the reset window elapses it stays OPEN and short-circuits', async () => {
  setClock(0)
  const cb = new CircuitBreaker('t', 1, 1000)
  await expectReject(() => cb.call(fail))
  setClock(999) // one ms short of the window
  const err = await expectReject(() => cb.call(ok))
  assert.ok(err instanceof CircuitOpenError)
})

// NOTE: documents ACTUAL behavior, which diverges from the class header
// comment ("After `threshold` consecutive failures, trips OPEN"). While the
// breaker is CLOSED, a successful call does NOT reset the failure counter — the
// reset only happens when recovering from OPEN/HALF_OPEN. So failures are
// effectively cumulative, not consecutive, and an interleaved success does not
// rescue the breaker. Flagged to the maintainers as a likely bug; this test
// pins the current contract so the fix is a deliberate, visible change.
test('a success while CLOSED does NOT reset the failure counter (failures accumulate)', async () => {
  setClock(0)
  const cb = new CircuitBreaker('t', 3, 1000)
  await expectReject(() => cb.call(fail))
  await expectReject(() => cb.call(fail)) // 2 failures, still closed
  await cb.call(ok)                       // success — counter is NOT reset while CLOSED
  assert.equal(cb.status, 'CLOSED')
  await expectReject(() => cb.call(fail)) // 3rd cumulative failure → trips OPEN
  assert.equal(cb.status, 'OPEN')
})

test('CircuitOpenError carries a descriptive message and the retry hint', () => {
  const err = new CircuitOpenError('openai', 30_000)
  assert.equal(err.name, 'CircuitOpenError')
  assert.match(err.message, /openai/)
  assert.match(err.message, /circuit open/)
  assert.equal(err.retryAfterMs, 30_000)
})
