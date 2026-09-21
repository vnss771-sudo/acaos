// Tests for lib/learningLoop.ts diffCalibration() — the calibration "why" trace.
//
// Pure function: compares the previously-persisted calibration against a fresh
// result to report which signal weights moved and whether the win rate improved.
// No database involved.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { diffCalibration, type CalibrateResult } from '../packages/backend-core/src/lib/learningLoop.ts'

// Minimal calibrated result builder — only the fields diffCalibration reads.
function result(baselineWinRate: number, signalWeights: Record<string, number>): CalibrateResult {
  return {
    stats: { calibrated: true, totalOutcomes: 20, baselineWinRate },
    signalWeights,
    icpUpdate: {},
  }
}

test('first calibration (no prior) reports null deltas and introductions', () => {
  const diff = diffCalibration(null, result(0.5, { FUNDING: 90, HIRING: 70 }))
  assert.equal(diff.previousWinRate, null)
  assert.equal(diff.newWinRate, 0.5)
  assert.equal(diff.winRateDelta, null)
  assert.equal(diff.improved, null)
  assert.equal(diff.changedCount, 2)
  // Every weight is a from:null introduction.
  assert.ok(diff.weightChanges.every((c) => c.from === null))
})

test('empty prior object behaves like a first calibration for weights', () => {
  const diff = diffCalibration({ signalWeights: {}, winRate: null }, result(0.4, { FUNDING: 80 }))
  assert.equal(diff.changedCount, 1)
  assert.deepEqual(diff.weightChanges[0], { type: 'FUNDING', from: null, to: 80, delta: 80 })
})

test('unchanged weights are not reported', () => {
  const diff = diffCalibration(
    { signalWeights: { FUNDING: 90, HIRING: 70 }, winRate: 0.5 },
    result(0.5, { FUNDING: 90, HIRING: 70 }),
  )
  assert.equal(diff.changedCount, 0)
  assert.deepEqual(diff.weightChanges, [])
})

test('reports raised, lowered, added and removed weights with signed deltas', () => {
  const diff = diffCalibration(
    { signalWeights: { FUNDING: 80, HIRING: 70, NEWS_MENTION: 50 }, winRate: 0.5 },
    result(0.5, { FUNDING: 95, HIRING: 60, PROCUREMENT: 90 }), // FUNDING up, HIRING down, NEWS removed, PROCUREMENT added
  )
  const byType = Object.fromEntries(diff.weightChanges.map((c) => [c.type, c]))
  assert.deepEqual(byType.FUNDING, { type: 'FUNDING', from: 80, to: 95, delta: 15 })
  assert.deepEqual(byType.HIRING, { type: 'HIRING', from: 70, to: 60, delta: -10 })
  assert.deepEqual(byType.NEWS_MENTION, { type: 'NEWS_MENTION', from: 50, to: null, delta: -50 })
  assert.deepEqual(byType.PROCUREMENT, { type: 'PROCUREMENT', from: null, to: 90, delta: 90 })
  assert.equal(diff.changedCount, 4)
})

test('weightChanges are sorted by absolute magnitude, largest first', () => {
  const diff = diffCalibration(
    { signalWeights: { FUNDING: 80, HIRING: 70 }, winRate: 0.5 },
    result(0.5, { FUNDING: 85, HIRING: 20 }), // FUNDING +5, HIRING -50
  )
  assert.deepEqual(diff.weightChanges.map((c) => c.type), ['HIRING', 'FUNDING'])
})

test('improved is true when win rate rises or holds, false when it falls', () => {
  const up = diffCalibration({ signalWeights: {}, winRate: 0.4 }, result(0.6, {}))
  assert.ok(Math.abs(up.winRateDelta! - 0.2) < 1e-9)
  assert.equal(up.improved, true)

  const down = diffCalibration({ signalWeights: {}, winRate: 0.6 }, result(0.4, {}))
  // floating point: assert on the rounded delta to avoid 0.1999999 noise
  assert.ok(Math.abs(down.winRateDelta! - -0.2) < 1e-9)
  assert.equal(down.improved, false)

  const flat = diffCalibration({ signalWeights: {}, winRate: 0.5 }, result(0.5, {}))
  assert.equal(flat.winRateDelta, 0)
  assert.equal(flat.improved, true) // holding steady counts as not-worse
})
