// Tests for lib/learningLoop.ts calibrate() (P6 — learning-loop calibration).
//
// Pure function: turns WON/LOST prospect outcomes into adjusted signal weights
// and an ICP update. No database involved.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { calibrate } from '../packages/backend-core/src/lib/learningLoop.ts'
import { EVENT_BASE_WEIGHTS } from '../packages/backend-core/src/lib/signalEngine.ts'

type Stage = 'WON' | 'LOST'
function outcome(stage: Stage, industry: string | null, employeeCount: number | null, types: string[]) {
  return { stage, prospect: { industry, employeeCount, signals: types.map((t) => ({ type: t })) } }
}

test('returns uncalibrated with fewer than 10 outcomes', () => {
  const res = calibrate([outcome('WON', 'tech', 50, ['FUNDING'])])
  assert.equal(res.stats.calibrated, false)
  assert.equal(res.stats.reason, 'insufficient data')
  assert.deepEqual(res.signalWeights, {})
  assert.deepEqual(res.icpUpdate, {})
})

test('computes the baseline win rate across all outcomes', () => {
  const outcomes = [
    ...Array.from({ length: 6 }, () => outcome('WON', 'tech', 40, ['FUNDING'])),
    ...Array.from({ length: 4 }, () => outcome('LOST', 'retail', 10, ['FUNDING'])),
  ]
  const res = calibrate(outcomes)
  assert.equal(res.stats.calibrated, true)
  assert.equal(res.stats.totalOutcomes, 10)
  assert.equal(res.stats.baselineWinRate, 0.6)
})

test('a signal type that always wins gets its weight boosted (multiplier capped at 2x)', () => {
  // FUNDING appears only on WON; PROCUREMENT appears on a mix → lower lift.
  const outcomes = [
    ...Array.from({ length: 5 }, () => outcome('WON', 'tech', 40, ['FUNDING'])),
    ...Array.from({ length: 5 }, () => outcome('LOST', 'retail', 10, ['PROCUREMENT'])),
  ]
  const res = calibrate(outcomes)
  // baseline win rate = 0.5; FUNDING win rate = 1.0 → lift 2.0 → multiplier clamped to 2.0
  assert.equal(res.signalWeights.FUNDING, Math.round(EVENT_BASE_WEIGHTS.FUNDING * 2.0))
  // PROCUREMENT win rate = 0 → lift 0 → multiplier clamped to floor 0.5
  assert.equal(res.signalWeights.PROCUREMENT, Math.round(EVENT_BASE_WEIGHTS.PROCUREMENT * 0.5))
})

test('signal types with fewer than 3 samples are ignored', () => {
  const outcomes = [
    ...Array.from({ length: 9 }, () => outcome('WON', 'tech', 40, ['FUNDING'])),
    outcome('LOST', 'retail', 10, ['HIRING']), // HIRING appears only twice total → skipped
    outcome('WON', 'tech', 40, ['HIRING']),
  ]
  const res = calibrate(outcomes)
  assert.ok('FUNDING' in res.signalWeights)
  assert.ok(!('HIRING' in res.signalWeights))
})

test('ICP update captures top WON industries and an employee-count band', () => {
  const outcomes = [
    ...Array.from({ length: 6 }, (_, i) => outcome('WON', 'Construction', 20 + i * 10, ['FUNDING'])),
    ...Array.from({ length: 4 }, () => outcome('LOST', 'retail', 5, ['FUNDING'])),
  ]
  const res = calibrate(outcomes)
  assert.deepEqual(res.icpUpdate.targetIndustries, ['construction'])
  assert.equal(typeof res.icpUpdate.minEmployees, 'number')
  assert.equal(typeof res.icpUpdate.maxEmployees, 'number')
  assert.ok(res.icpUpdate.minEmployees! <= res.icpUpdate.maxEmployees!)
})

test('lift uses a safe denominator when no outcome was won (no division by zero)', () => {
  const outcomes = Array.from({ length: 10 }, () => outcome('LOST', 'retail', 10, ['FUNDING']))
  const res = calibrate(outcomes)
  assert.equal(res.stats.baselineWinRate, 0)
  // FUNDING win rate 0 → multiplier floor 0.5, finite weight (no NaN/Infinity)
  assert.ok(Number.isFinite(res.signalWeights.FUNDING))
  assert.equal(res.signalWeights.FUNDING, Math.round(EVENT_BASE_WEIGHTS.FUNDING * 0.5))
})
