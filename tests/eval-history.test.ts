// Unit tests for the pure eval score/lift tracking helpers in
// scripts/lib/evalHistory.ts (used by scripts/eval-outreach.ts and
// scripts/eval-research.ts to make model quality lift a real, visible number
// over time rather than only current-run pass/fail). No fs, no network.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeEvalScore,
  appendEvalRun,
  computeLift,
  formatLift,
  MAX_EVAL_HISTORY,
  type EvalFinding,
  type EvalRunRecord,
} from '../scripts/lib/evalHistory.ts'

function record(score: number, recordedAt = '2026-01-01T00:00:00.000Z'): EvalRunRecord {
  return { recordedAt, score, fails: 0, warns: 0, cases: 3 }
}

// ── computeEvalScore ───────────────────────────────────────────────────────

test('computeEvalScore: no findings → perfect 100', () => {
  assert.equal(computeEvalScore([]), 100)
})

test('computeEvalScore: FAILs cost more than WARNs', () => {
  const oneFail: EvalFinding[] = [{ case: 'a', severity: 'FAIL', message: 'x' }]
  const oneWarn: EvalFinding[] = [{ case: 'a', severity: 'WARN', message: 'x' }]
  const failScore = computeEvalScore(oneFail)
  const warnScore = computeEvalScore(oneWarn)
  assert.ok(failScore < warnScore, `a FAIL must cost more than a WARN (fail=${failScore}, warn=${warnScore})`)
  assert.ok(failScore < 100 && warnScore < 100)
})

test('computeEvalScore: floors at 0, never negative', () => {
  const manyFails: EvalFinding[] = Array.from({ length: 20 }, (_, i) => ({ case: `c${i}`, severity: 'FAIL' as const, message: 'x' }))
  assert.equal(computeEvalScore(manyFails), 0)
})

test('computeEvalScore: is deterministic (pure)', () => {
  const findings: EvalFinding[] = [
    { case: 'a', severity: 'FAIL', message: 'x' },
    { case: 'b', severity: 'WARN', message: 'y' },
  ]
  assert.equal(computeEvalScore(findings), computeEvalScore(findings))
})

// ── appendEvalRun ──────────────────────────────────────────────────────────

test('appendEvalRun: adds the run to the end of history', () => {
  const history = [record(80)]
  const next = appendEvalRun(history, record(90, '2026-01-02T00:00:00.000Z'))
  assert.equal(next.length, 2)
  assert.equal(next[1].score, 90)
  // Original array is untouched (pure).
  assert.equal(history.length, 1)
})

test('appendEvalRun: caps history at MAX_EVAL_HISTORY, dropping the oldest', () => {
  const history = Array.from({ length: MAX_EVAL_HISTORY }, (_, i) => record(i))
  const next = appendEvalRun(history, record(9999))
  assert.equal(next.length, MAX_EVAL_HISTORY)
  assert.equal(next[next.length - 1].score, 9999, 'newest run is kept')
  assert.equal(next[0].score, 1, 'oldest run (index 0) was dropped to make room')
})

// ── computeLift ────────────────────────────────────────────────────────────

test('computeLift: null when there is no prior run (first recorded run)', () => {
  assert.equal(computeLift([], 85), null)
})

test('computeLift: positive delta when quality improved vs. the last run', () => {
  const history = [record(70)]
  const lift = computeLift(history, 85)
  assert.ok(lift)
  assert.equal(lift!.deltaScore, 15)
  assert.equal(lift!.previous.score, 70)
})

test('computeLift: negative delta when quality regressed vs. the last run', () => {
  const history = [record(90)]
  const lift = computeLift(history, 60)
  assert.ok(lift)
  assert.equal(lift!.deltaScore, -30)
})

test('computeLift: compares against the MOST RECENT run, not an older one', () => {
  const history = [record(50, '2026-01-01T00:00:00.000Z'), record(90, '2026-01-08T00:00:00.000Z')]
  const lift = computeLift(history, 95)
  assert.ok(lift)
  assert.equal(lift!.previous.recordedAt, '2026-01-08T00:00:00.000Z')
  assert.equal(lift!.deltaScore, 5)
})

// ── formatLift ─────────────────────────────────────────────────────────────

test('formatLift: reports "first recorded run" with no prior baseline', () => {
  const msg = formatLift(null, 88)
  assert.match(msg, /88\/100/)
  assert.match(msg, /first recorded run/)
})

test('formatLift: reports a signed delta for an improvement and a regression', () => {
  const up = formatLift({ deltaScore: 10, previous: record(70) }, 80)
  const down = formatLift({ deltaScore: -10, previous: record(90) }, 80)
  assert.match(up, /\+10/)
  assert.match(down, /-10/)
})
