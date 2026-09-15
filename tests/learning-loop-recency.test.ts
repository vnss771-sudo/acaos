// Unit tests for recency weighting in lib/learningLoop.ts: outcomeRecencyWeight()
// (pure decay function) and its effect on calibrate()'s signal-weight output.
// No database involved.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  calibrate,
  outcomeRecencyWeight,
  learningLoopRecencyHalfLifeDays,
} from '../packages/backend-core/src/lib/learningLoop.ts'
import { EVENT_BASE_WEIGHTS } from '../packages/backend-core/src/lib/signalEngine.ts'

const DAY = 86_400_000

function withEnv(name: string, value: string | undefined, fn: () => void) {
  const saved = process.env[name]
  try {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
    fn()
  } finally {
    if (saved === undefined) delete process.env[name]
    else process.env[name] = saved
  }
}

// ── outcomeRecencyWeight (pure decay function) ────────────────────────────────

test('outcomeRecencyWeight is 1.0 at age zero', () => {
  const now = new Date('2026-01-01T00:00:00Z')
  assert.equal(outcomeRecencyWeight(now, now, 90), 1)
})

test('outcomeRecencyWeight halves at exactly one half-life', () => {
  const now = new Date('2026-01-01T00:00:00Z')
  const recordedAt = new Date(now.getTime() - 90 * DAY)
  assert.ok(Math.abs(outcomeRecencyWeight(recordedAt, now, 90) - 0.5) < 1e-9)
})

test('outcomeRecencyWeight quarters at two half-lives and keeps decaying', () => {
  const now = new Date('2026-01-01T00:00:00Z')
  const twoHalfLives = new Date(now.getTime() - 180 * DAY)
  const tenHalfLives = new Date(now.getTime() - 900 * DAY)
  assert.ok(Math.abs(outcomeRecencyWeight(twoHalfLives, now, 90) - 0.25) < 1e-9)
  assert.ok(outcomeRecencyWeight(tenHalfLives, now, 90) < 0.001, 'very old outcomes decay toward zero')
})

test('outcomeRecencyWeight clamps a future-dated recordedAt to full weight (no boost)', () => {
  const now = new Date('2026-01-01T00:00:00Z')
  const future = new Date(now.getTime() + 30 * DAY)
  assert.equal(outcomeRecencyWeight(future, now, 90), 1)
})

test('outcomeRecencyWeight is monotonically decreasing with age', () => {
  const now = new Date('2026-01-01T00:00:00Z')
  const ages = [0, 10, 30, 90, 180, 365]
  const weights = ages.map((a) => outcomeRecencyWeight(new Date(now.getTime() - a * DAY), now, 90))
  for (let i = 1; i < weights.length; i++) {
    assert.ok(weights[i] < weights[i - 1], `weight must strictly decrease with age (${ages[i]}d vs ${ages[i - 1]}d)`)
  }
})

test('learningLoopRecencyHalfLifeDays defaults to 180 and falls back on invalid env', () => {
  withEnv('LEARNING_LOOP_RECENCY_HALF_LIFE_DAYS', undefined, () => {
    assert.equal(learningLoopRecencyHalfLifeDays(), 180)
  })
  withEnv('LEARNING_LOOP_RECENCY_HALF_LIFE_DAYS', '0', () => {
    assert.equal(learningLoopRecencyHalfLifeDays(), 180)
  })
  withEnv('LEARNING_LOOP_RECENCY_HALF_LIFE_DAYS', '-30', () => {
    assert.equal(learningLoopRecencyHalfLifeDays(), 180)
  })
  withEnv('LEARNING_LOOP_RECENCY_HALF_LIFE_DAYS', 'nope', () => {
    assert.equal(learningLoopRecencyHalfLifeDays(), 180)
  })
  withEnv('LEARNING_LOOP_RECENCY_HALF_LIFE_DAYS', '45', () => {
    assert.equal(learningLoopRecencyHalfLifeDays(), 45)
  })
})

// ── calibrate(): recency weighting moves the result ───────────────────────────

type Stage = 'WON' | 'LOST'
function outcome(stage: Stage, types: string[], recordedAt: Date) {
  return { stage, recordedAt, prospect: { industry: 'tech', employeeCount: 50, signals: types.map((t) => ({ type: t })) } }
}

test('a recent outcome moves signalWeights more than an old, otherwise-identical one', () => {
  const now = new Date('2026-09-15T00:00:00Z')
  const veryOld = new Date(now.getTime() - 100 * 365 * DAY) // ~100 years — decays to ~0 weight

  // Shared base: 5 WON + 5 LOST on FUNDING (baseline win rate 0.5), plus HIRING
  // appearing once on WON and once on LOST — 2 samples, below MIN_TYPE_SAMPLES(3)
  // on its own. A third HIRING/WON outcome (the one under test) pushes it to 3
  // samples and should lift its weight — but only if it actually counts.
  function scenario(extraRecordedAt: Date) {
    return [
      ...Array.from({ length: 5 }, () => outcome('WON', ['FUNDING'], now)),
      ...Array.from({ length: 5 }, () => outcome('LOST', ['FUNDING'], now)),
      outcome('WON', ['HIRING'], now),
      outcome('LOST', ['HIRING'], now),
      outcome('WON', ['HIRING'], extraRecordedAt), // the variable: recent vs ancient
    ]
  }

  const recentResult = calibrate(scenario(now), now)
  const oldResult = calibrate(scenario(veryOld), now)

  const hiringBase = EVENT_BASE_WEIGHTS.HIRING
  assert.ok('HIRING' in recentResult.signalWeights, 'HIRING has 3 raw samples in both scenarios')
  assert.ok('HIRING' in oldResult.signalWeights)

  // The ancient extra WON barely counts, so HIRING's weighted win rate stays
  // near the baseline (0.5) → little to no lift above the base weight.
  assert.ok(
    oldResult.signalWeights.HIRING <= hiringBase + 1,
    `an outcome ~100 years old should not meaningfully lift the weight (got ${oldResult.signalWeights.HIRING}, base ${hiringBase})`
  )
  // The recent extra WON counts fully, pushing HIRING's weighted win rate (and
  // the baseline it's compared against) up, producing a measurable lift.
  assert.ok(
    recentResult.signalWeights.HIRING > oldResult.signalWeights.HIRING,
    `a recent outcome must move the weight more than an old one (recent=${recentResult.signalWeights.HIRING}, old=${oldResult.signalWeights.HIRING})`
  )
})

test('recency weighting does not let a stale outcome unlock MIN_TYPE_SAMPLES early', () => {
  // Only 2 raw occurrences of PROCUREMENT — recency weighting must not bypass
  // the raw sample-count gate (it only reweights types that already qualify).
  const now = new Date('2026-09-15T00:00:00Z')
  const outcomes = [
    ...Array.from({ length: 5 }, () => outcome('WON', ['FUNDING'], now)),
    ...Array.from({ length: 5 }, () => outcome('LOST', ['FUNDING'], now)),
    outcome('WON', ['PROCUREMENT'], now),
    outcome('WON', ['PROCUREMENT'], now),
  ]
  const res = calibrate(outcomes, now)
  assert.ok(!('PROCUREMENT' in res.signalWeights), 'a type with only 2 raw samples stays excluded regardless of recency')
})

test('when every outcome is "as of now" (no recordedAt, or recordedAt=now), recency weighting is a no-op', () => {
  const now = new Date('2026-09-15T00:00:00Z')
  const withoutTimestamps = [
    ...Array.from({ length: 6 }, () => ({ stage: 'WON' as const, prospect: { industry: 'tech', employeeCount: 40, signals: [{ type: 'FUNDING' }] } })),
    ...Array.from({ length: 4 }, () => ({ stage: 'LOST' as const, prospect: { industry: 'retail', employeeCount: 10, signals: [{ type: 'FUNDING' }] } })),
  ]
  const withNowTimestamps = withoutTimestamps.map((o) => ({ ...o, recordedAt: now }))

  const a = calibrate(withoutTimestamps, now)
  const b = calibrate(withNowTimestamps, now)
  assert.deepEqual(a, b, 'omitting recordedAt must match explicitly setting it to `now`')
  assert.equal(a.stats.baselineWinRate, 0.6, 'unweighted baseline math is unchanged')
})
