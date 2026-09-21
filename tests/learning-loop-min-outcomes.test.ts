// Unit tests for the configurable cold-start gate (LEARNING_LOOP_MIN_OUTCOMES)
// in lib/learningLoop.ts. Pure — no database involved.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { calibrate, learningLoopMinOutcomes } from '../packages/backend-core/src/lib/learningLoop.ts'

type Stage = 'WON' | 'LOST'
function outcome(stage: Stage, types: string[] = ['FUNDING']) {
  return { stage, prospect: { industry: 'tech', employeeCount: 50, signals: types.map((t) => ({ type: t })) } }
}

function withEnv(value: string | undefined, fn: () => void) {
  const saved = process.env.LEARNING_LOOP_MIN_OUTCOMES
  try {
    if (value === undefined) delete process.env.LEARNING_LOOP_MIN_OUTCOMES
    else process.env.LEARNING_LOOP_MIN_OUTCOMES = value
    fn()
  } finally {
    if (saved === undefined) delete process.env.LEARNING_LOOP_MIN_OUTCOMES
    else process.env.LEARNING_LOOP_MIN_OUTCOMES = saved
  }
}

test('learningLoopMinOutcomes defaults to 10 and falls back on invalid env', () => {
  withEnv(undefined, () => {
    assert.equal(learningLoopMinOutcomes(), 10)
  })
  withEnv('0', () => {
    // 0 is below the >=1 floor — falls back to the default rather than
    // disabling the gate entirely via env.
    assert.equal(learningLoopMinOutcomes(), 10)
  })
  withEnv('-5', () => {
    assert.equal(learningLoopMinOutcomes(), 10)
  })
  withEnv('not-a-number', () => {
    assert.equal(learningLoopMinOutcomes(), 10)
  })
})

test('learningLoopMinOutcomes reads a valid env override', () => {
  withEnv('3', () => {
    assert.equal(learningLoopMinOutcomes(), 3)
  })
  withEnv('25.9', () => {
    // Floored to an integer sample count.
    assert.equal(learningLoopMinOutcomes(), 25)
  })
})

test('calibrate() honors a lowered LEARNING_LOOP_MIN_OUTCOMES', () => {
  const outcomes = [outcome('WON'), outcome('WON'), outcome('LOST')]
  // Below the default of 10 — uncalibrated without the override.
  assert.equal(calibrate(outcomes).stats.calibrated, false)

  withEnv('3', () => {
    const res = calibrate(outcomes)
    assert.equal(res.stats.calibrated, true)
    assert.equal(res.stats.totalOutcomes, 3)
  })

  // Restored to the documented default after the env var is cleared.
  assert.equal(calibrate(outcomes).stats.calibrated, false)
})

test('calibrate() still gates on a raised LEARNING_LOOP_MIN_OUTCOMES', () => {
  const outcomes = Array.from({ length: 10 }, (_, i) => outcome(i % 2 === 0 ? 'WON' : 'LOST'))
  assert.equal(calibrate(outcomes).stats.calibrated, true)

  withEnv('20', () => {
    const res = calibrate(outcomes)
    assert.equal(res.stats.calibrated, false)
    assert.equal(res.stats.reason, 'insufficient data')
  })
})
