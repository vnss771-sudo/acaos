import test from 'node:test'
import assert from 'node:assert/strict'
import { seatLimitForPlan, assertSeatAvailable } from '../packages/backend-core/src/lib/limits.ts'
import { ApiError } from '../packages/backend-core/src/lib/errors.ts'

test('seatLimitForPlan returns the plan cap and defaults unknown/lapsed to free', () => {
  assert.equal(seatLimitForPlan('free'), 2)
  assert.equal(seatLimitForPlan('starter'), 5)
  assert.equal(seatLimitForPlan('growth'), 25)
  assert.equal(seatLimitForPlan('bogus'), 2)
  assert.equal(seatLimitForPlan(null), 2)
})

// Minimal fake client: a workspace on `plan`/`status` with `members` current seats.
function fakeClient(plan: string, members: number, subscriptionStatus: string | null = 'active') {
  return {
    workspace: { findUnique: async () => ({ plan, subscriptionStatus }) },
    membership: { count: async () => members },
  } as any
}

test('assertSeatAvailable allows a seat below the cap', async () => {
  await assert.doesNotReject(() => assertSeatAvailable('w1', fakeClient('starter', 4))) // 4 < 5
})

test('assertSeatAvailable rejects at the cap with a 403 + upgrade hint', async () => {
  await assert.rejects(() => assertSeatAvailable('w1', fakeClient('free', 2)), (err: unknown) => {
    assert.ok(err instanceof ApiError)
    assert.equal((err as ApiError).statusCode, 403)
    assert.match((err as ApiError).message, /Seat limit reached.*free/)
    return true
  })
})

test('assertSeatAvailable treats a lapsed subscription as the free cap', async () => {
  // Paid plan but subscription not active → free cap (2); 2 seats used → rejected.
  await assert.rejects(() => assertSeatAvailable('w1', fakeClient('growth', 2, 'past_due')), ApiError)
})
