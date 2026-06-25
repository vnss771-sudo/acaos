import test from 'node:test'
import assert from 'node:assert/strict'
import {
  lockoutSeconds, isLocked, lockRetryAfterSeconds, nextLockoutAfterFailure,
  CLEARED_LOCKOUT, LOCKOUT_THRESHOLD,
} from '../packages/backend-core/src/lib/accountLockout.ts'

test('lockoutSeconds: free below the threshold, then escalates and caps', () => {
  for (let n = 0; n < LOCKOUT_THRESHOLD; n++) assert.equal(lockoutSeconds(n), 0, `n=${n} should be free`)
  assert.equal(lockoutSeconds(5), 60)
  assert.equal(lockoutSeconds(6), 60)
  assert.equal(lockoutSeconds(7), 300)
  assert.equal(lockoutSeconds(9), 300)
  assert.equal(lockoutSeconds(10), 900)
  assert.equal(lockoutSeconds(14), 900)
  assert.equal(lockoutSeconds(15), 1800)
  assert.equal(lockoutSeconds(1000), 1800) // capped
})

test('nextLockoutAfterFailure bumps the counter and derives the window from the schedule', () => {
  const now = new Date('2026-06-25T00:00:00.000Z')
  // 4 prior failures → this is the 5th → first lock (60s).
  const r = nextLockoutAfterFailure(4, now)
  assert.equal(r.failedAttempts, 5)
  assert.equal(r.lockedUntil?.getTime(), now.getTime() + 60_000)
  // Below threshold → counter bumps but no lock.
  const r2 = nextLockoutAfterFailure(1, now)
  assert.equal(r2.failedAttempts, 2)
  assert.equal(r2.lockedUntil, null)
  // Negative/garbage prior count is floored at 0.
  assert.equal(nextLockoutAfterFailure(-3, now).failedAttempts, 1)
})

test('isLocked / lockRetryAfterSeconds reflect the clock', () => {
  const now = new Date('2026-06-25T00:00:00.000Z')
  const future = new Date(now.getTime() + 90_000)
  const past = new Date(now.getTime() - 1)
  assert.equal(isLocked({ lockedUntil: null }, now), false)
  assert.equal(isLocked({ lockedUntil: past }, now), false)
  assert.equal(isLocked({ lockedUntil: future }, now), true)
  assert.equal(lockRetryAfterSeconds({ lockedUntil: future }, now), 90)
  assert.equal(lockRetryAfterSeconds({ lockedUntil: null }, now), 0)
  assert.equal(lockRetryAfterSeconds({ lockedUntil: past }, now), 0)
})

test('CLEARED_LOCKOUT is a clean reset', () => {
  assert.deepEqual(CLEARED_LOCKOUT, { failedAttempts: 0, lockedUntil: null })
})
