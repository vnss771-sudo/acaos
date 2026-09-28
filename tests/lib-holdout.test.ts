// Held-back comparison group (lib/holdout.ts): share resolution and assignment.
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { holdoutPercent, holdoutBucket, isHeldOut, MAX_HOLDOUT_PERCENT, DEFAULT_LIVE_HOLDOUT_PERCENT } from '../packages/backend-core/src/lib/holdout.ts'

const saved = { h: process.env.LEARNING_HOLDOUT_PERCENT, m: process.env.LEARNING_ADAPTATION_MODE }
afterEach(() => {
  for (const [k, v] of [['LEARNING_HOLDOUT_PERCENT', saved.h], ['LEARNING_ADAPTATION_MODE', saved.m]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v
  }
})

test('share: off by default, 5% once learning is live, explicit value wins and is clamped', () => {
  delete process.env.LEARNING_HOLDOUT_PERCENT
  delete process.env.LEARNING_ADAPTATION_MODE
  assert.equal(holdoutPercent(), 0, 'shadow (default) holds nothing back')
  process.env.LEARNING_ADAPTATION_MODE = 'live'
  assert.equal(holdoutPercent(), DEFAULT_LIVE_HOLDOUT_PERCENT)
  process.env.LEARNING_HOLDOUT_PERCENT = '0'
  assert.equal(holdoutPercent(), 0, 'explicit 0 turns it off even when live')
  process.env.LEARNING_HOLDOUT_PERCENT = '2.5'
  assert.equal(holdoutPercent(), 2.5)
  process.env.LEARNING_HOLDOUT_PERCENT = '90'
  assert.equal(holdoutPercent(), MAX_HOLDOUT_PERCENT, 'never more than the ceiling')
  process.env.LEARNING_HOLDOUT_PERCENT = 'lots'
  assert.equal(holdoutPercent(), 0, 'garbage fails safe (no holdout)')
})

test('assignment is stable, per-workspace, and hits the requested share', () => {
  assert.equal(holdoutBucket('w1', 'lead-1'), holdoutBucket('w1', 'lead-1'))
  assert.notEqual(holdoutBucket('w1', 'lead-1'), holdoutBucket('w2', 'lead-1'))
  assert.equal(isHeldOut('w1', 'lead-1', 0), false)
  let held = 0
  const N = 20_000
  for (let i = 0; i < N; i++) if (isHeldOut('w1', `lead-${i}`, 5)) held++
  assert.ok(Math.abs(held / N - 0.05) < 0.006, `~5% held out, got ${(held / N * 100).toFixed(2)}%`)
})
