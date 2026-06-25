import test from 'node:test'
import assert from 'node:assert/strict'
import { createRejectionTracker } from '../packages/backend-core/src/lib/rejectionTracker.ts'

function fakeClock(start = 0) {
  let t = start
  return { now: () => t, advance: (ms: number) => { t += ms } }
}

test('a single (or sub-threshold) rejection does not trip the guard', () => {
  const clock = fakeClock()
  const tr = createRejectionTracker({ threshold: 5, windowMs: 60_000, now: clock.now })
  for (let i = 0; i < 4; i++) assert.equal(tr.record(), false, `rejection ${i + 1} within threshold`)
  assert.equal(tr.count(), 4)
})

test('threshold rejections within the window trip the guard', () => {
  const clock = fakeClock()
  const tr = createRejectionTracker({ threshold: 5, windowMs: 60_000, now: clock.now })
  assert.equal(tr.record(), false) // 1
  assert.equal(tr.record(), false) // 2
  assert.equal(tr.record(), false) // 3
  assert.equal(tr.record(), false) // 4
  assert.equal(tr.record(), true)  // 5 → breached
})

test('old rejections age out of the window so a slow trickle never trips it', () => {
  const clock = fakeClock()
  const tr = createRejectionTracker({ threshold: 3, windowMs: 10_000, now: clock.now })
  tr.record() // t=0
  clock.advance(6_000); tr.record() // t=6000 (2 in window)
  clock.advance(6_000) // t=12000 → the t=0 entry is now >10s old
  assert.equal(tr.record(), false, 'only 2 in the trailing window')
  assert.equal(tr.count(), 2)
  // A genuine burst still trips it.
  assert.equal(tr.record(), true) // 3 within the window
})

test('threshold is floored at 1', () => {
  const clock = fakeClock()
  const tr = createRejectionTracker({ threshold: 0, now: clock.now })
  assert.equal(tr.record(), true, 'a zero/negative threshold behaves as 1')
})
