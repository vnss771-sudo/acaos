// Unit tests for the sender-reputation circuit breaker's pure verdict logic
// (verdictFor) and the env-driven mode/threshold parsing. The DB-backed
// evaluateSenderReputation (ledger counts) and the send-path gates are covered in
// the DB tier; here we pin the threshold/min-sample math without a database.

import test from 'node:test'
import assert from 'node:assert/strict'
import { verdictFor, reputationThresholds, type ReputationThresholds } from '../packages/backend-core/src/lib/senderReputation.ts'
import { reputationGuardMode } from '../packages/backend-core/src/lib/launchControls.ts'

const T: ReputationThresholds = { windowDays: 7, minSends: 50, maxBounceRate: 0.05, maxComplaintRate: 0.003 }

test('verdict: below the minimum sample is always healthy, however bad the rate', () => {
  // 49 sends, 49 bounces (100%) — but under minSends, so no signal yet.
  const v = verdictFor({ totalSends: 49, bounces: 49, complaints: 0 }, T)
  assert.equal(v.healthy, true)
  assert.equal(v.reason, null)
  assert.equal(v.bounceRate, 1)
})

test('verdict: zero sends is healthy (no division by zero)', () => {
  const v = verdictFor({ totalSends: 0, bounces: 0, complaints: 0 }, T)
  assert.equal(v.healthy, true)
  assert.equal(v.bounceRate, 0)
  assert.equal(v.complaintRate, 0)
})

test('verdict: bounce rate over the threshold with enough sample trips BOUNCE_RATE_HIGH', () => {
  // 100 sends, 6 bounces = 6% > 5%.
  const v = verdictFor({ totalSends: 100, bounces: 6, complaints: 0 }, T)
  assert.equal(v.healthy, false)
  assert.equal(v.reason, 'BOUNCE_RATE_HIGH')
  assert.equal(v.bounceRate, 0.06)
})

test('verdict: a rate exactly at the threshold is still healthy (strict >)', () => {
  // 100 sends, 5 bounces = exactly 5%.
  const v = verdictFor({ totalSends: 100, bounces: 5, complaints: 0 }, T)
  assert.equal(v.healthy, true)
  assert.equal(v.reason, null)
})

test('verdict: complaint rate over the threshold trips COMPLAINT_RATE_HIGH', () => {
  // 1000 sends, 0 bounces, 4 complaints = 0.4% > 0.3%.
  const v = verdictFor({ totalSends: 1000, bounces: 0, complaints: 4 }, T)
  assert.equal(v.healthy, false)
  assert.equal(v.reason, 'COMPLAINT_RATE_HIGH')
})

test('verdict: bounce takes priority over complaint when both breach', () => {
  const v = verdictFor({ totalSends: 1000, bounces: 60, complaints: 40 }, T)
  assert.equal(v.reason, 'BOUNCE_RATE_HIGH')
})

test('thresholds: env overrides are parsed; invalid values fall back to defaults', () => {
  const saved = { ...process.env }
  try {
    process.env.REPUTATION_MIN_SENDS = '10'
    process.env.REPUTATION_MAX_BOUNCE_RATE = '0.02'
    process.env.REPUTATION_WINDOW_DAYS = 'not-a-number'
    const t = reputationThresholds()
    assert.equal(t.minSends, 10)
    assert.equal(t.maxBounceRate, 0.02)
    assert.equal(t.windowDays, 7, 'invalid value falls back to the default')
  } finally {
    process.env = saved
  }
})

test('guard mode: defaults to observe; only off/enforce are honored', () => {
  const saved = process.env.REPUTATION_GUARD_MODE
  try {
    delete process.env.REPUTATION_GUARD_MODE
    assert.equal(reputationGuardMode(), 'observe')
    process.env.REPUTATION_GUARD_MODE = 'ENFORCE'
    assert.equal(reputationGuardMode(), 'enforce', 'case-insensitive')
    process.env.REPUTATION_GUARD_MODE = 'off'
    assert.equal(reputationGuardMode(), 'off')
    process.env.REPUTATION_GUARD_MODE = 'garbage'
    assert.equal(reputationGuardMode(), 'observe', 'unknown value falls back to observe')
  } finally {
    if (saved === undefined) delete process.env.REPUTATION_GUARD_MODE
    else process.env.REPUTATION_GUARD_MODE = saved
  }
})
