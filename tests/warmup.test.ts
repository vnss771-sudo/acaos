// Unit tests for the domain-warmup ramp (pure, clock-injectable). The DB-backed
// integration (a warming workspace's effective send cap) is covered in the DB tier.

import test from 'node:test'
import assert from 'node:assert/strict'
import { warmupDailyCap, warmupSchedule, applyWarmupCap } from '../packages/backend-core/src/lib/warmup.ts'

const DAY = 24 * 60 * 60 * 1000
const SCHED = [20, 40, 80, 150]

test('warmup: day 1 uses the first schedule entry', () => {
  const start = new Date('2026-06-01T09:00:00Z')
  assert.equal(warmupDailyCap(start, new Date('2026-06-01T10:00:00Z'), SCHED), 20)
})

test('warmup: the cap steps up one entry per elapsed day', () => {
  const start = new Date('2026-06-01T09:00:00Z')
  assert.equal(warmupDailyCap(start, new Date(start.getTime() + 1 * DAY), SCHED), 40)
  assert.equal(warmupDailyCap(start, new Date(start.getTime() + 2 * DAY), SCHED), 80)
  assert.equal(warmupDailyCap(start, new Date(start.getTime() + 3 * DAY), SCHED), 150)
})

test('warmup: once the ramp is complete it no longer constrains (null)', () => {
  const start = new Date('2026-06-01T09:00:00Z')
  assert.equal(warmupDailyCap(start, new Date(start.getTime() + 4 * DAY), SCHED), null)
  assert.equal(warmupDailyCap(start, new Date(start.getTime() + 100 * DAY), SCHED), null)
})

test('warmup: a future start gets the most conservative first-day cap', () => {
  const start = new Date('2026-06-10T00:00:00Z')
  assert.equal(warmupDailyCap(start, new Date('2026-06-01T00:00:00Z'), SCHED), 20)
})

test('schedule: defaults are used and an env override is parsed; malformed falls back', () => {
  const saved = process.env.WARMUP_SCHEDULE
  try {
    delete process.env.WARMUP_SCHEDULE
    assert.deepEqual(warmupSchedule(), [20, 40, 80, 150, 300, 500, 750, 1000])
    process.env.WARMUP_SCHEDULE = '5, 25, 100'
    assert.deepEqual(warmupSchedule(), [5, 25, 100])
    process.env.WARMUP_SCHEDULE = 'garbage,,-3'
    assert.deepEqual(warmupSchedule(), [20, 40, 80, 150, 300, 500, 750, 1000], 'malformed → default')
  } finally {
    if (saved === undefined) delete process.env.WARMUP_SCHEDULE
    else process.env.WARMUP_SCHEDULE = saved
  }
})

test('applyWarmupCap: no warmup start → base limit unchanged', () => {
  assert.equal(applyWarmupCap(50, null), 50)
  assert.equal(applyWarmupCap(null, null), null)
})

test('applyWarmupCap: returns the more restrictive of base vs warmup', () => {
  const start = new Date('2026-06-01T00:00:00Z')
  const day1 = new Date('2026-06-01T06:00:00Z')
  // base 50, warmup day-1 20 → 20 wins.
  assert.equal(applyWarmupCap(50, start, day1), 20)
  // base unlimited (null), warmup active → warmup governs.
  assert.equal(applyWarmupCap(null, start, day1), 20)
})

test('applyWarmupCap: a completed ramp defers to the base limit', () => {
  const start = new Date('2026-05-01T00:00:00Z') // long ago → ramp complete
  assert.equal(applyWarmupCap(50, start, new Date('2026-06-22T00:00:00Z')), 50)
})
