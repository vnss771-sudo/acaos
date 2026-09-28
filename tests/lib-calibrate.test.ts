// Tests for lib/learningLoop.ts calibrate() (P6 — learning-loop calibration).
//
// Pure function: turns WON/LOST prospect outcomes into adjusted signal weights
// and an ICP update. No database involved.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { calibrate, buildRecommendationDrafts, sameJson, confidenceLabel } from '../packages/backend-core/src/lib/learningLoop.ts'
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

test('a high-win-rate signal type is boosted, but shrinkage keeps a small sample under the 2x cap', () => {
  // FUNDING appears only on WON; PROCUREMENT appears only on LOST.
  const outcomes = [
    ...Array.from({ length: 5 }, () => outcome('WON', 'tech', 40, ['FUNDING'])),
    ...Array.from({ length: 5 }, () => outcome('LOST', 'retail', 10, ['PROCUREMENT'])),
  ]
  const res = calibrate(outcomes)
  const fundingBase = EVENT_BASE_WEIGHTS.FUNDING
  // baseline win rate = 0.5; FUNDING wins 5/5, but the win rate is shrunk toward
  // the baseline (small sample) so the multiplier lands below the hard 2x cap
  // while still boosting the weight above its base.
  assert.ok(res.signalWeights.FUNDING > fundingBase, 'high win-rate signal must be boosted')
  assert.ok(res.signalWeights.FUNDING <= Math.round(fundingBase * 2.0), 'never exceeds the 2x cap')
  // PROCUREMENT never wins → multiplier clamped to the 0.5 floor.
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

test('does not calibrate weights when there are zero wins (no signal lift to learn)', () => {
  const outcomes = Array.from({ length: 10 }, () => outcome('LOST', 'retail', 10, ['FUNDING']))
  const res = calibrate(outcomes)
  // An all-LOST sample has no win-rate signal; calibrating would just floor every
  // weight uniformly and discard existing tuning. Report the baseline but leave
  // weights untouched (no NaN/Infinity, no division by zero).
  assert.equal(res.stats.calibrated, false)
  assert.equal(res.stats.reason, 'insufficient wins')
  assert.equal(res.stats.baselineWinRate, 0)
  assert.deepEqual(res.signalWeights, {})
})

// ── Learning hardening (P0): ICP maths + recommendations ────────────────────
// ── ICP learning maths ──────────────────────────────────────────────────────

const po2 = (stage: Stage, industry: string, employeeCount = 30) =>
  ({ stage, prospect: { industry, employeeCount, signals: [] as { type: string }[] } })
const many = (n: number, stage: Stage, industry: string) => Array.from({ length: n }, () => po2(stage, industry))

test('industry ranking uses adjusted win RATE, not raw win count (HVAC 10/200 vs Electrical 5/30)', () => {
  const r = calibrate([...many(10, 'WON', 'HVAC'), ...many(190, 'LOST', 'HVAC'), ...many(5, 'WON', 'Electrical'), ...many(25, 'LOST', 'Electrical')])
  assert.deepEqual(r.icpUpdate.targetIndustries, ['electrical'])
  const elec = r.industryInsights.find(i => i.segment === 'electrical')!
  assert.ok(elec.lift > 1 && elec.adjustedWinRate < elec.observedWinRate, 'shrunk toward baseline')
})

test('one lucky win in a tiny segment does not outrank a large proven segment', () => {
  const r = calibrate([...many(1, 'WON', 'Lucky'), ...many(1, 'LOST', 'Lucky'), ...many(50, 'WON', 'Proven'), ...many(150, 'LOST', 'Proven')])
  assert.ok(!r.industryInsights.some(i => i.segment === 'lucky'), '2 samples is below the minimum and withheld')
})

// ── Recommendations, never silent ICP rewrites ──────────────────────────────

test('ICP changes are proposed as recommendations with evidence', () => {
  const r = calibrate([...many(8, 'WON', 'Electrical'), ...many(4, 'LOST', 'Electrical'), ...many(1, 'WON', 'HVAC'), ...many(12, 'LOST', 'HVAC')])
  const drafts = buildRecommendationDrafts(r, { targetIndustries: ['HVAC', 'Plumbing'], minEmployees: 5, maxEmployees: 500, signalWeights: {} })
  const ind = drafts.find(d => d.type === 'ICP_INDUSTRY')!
  assert.deepEqual(ind.currentValue, ['HVAC', 'Plumbing'])
  assert.deepEqual(ind.proposedValue, ['electrical'])
  assert.ok(Array.isArray((ind.evidence as { industries: unknown[] }).industries))
  assert.equal(ind.sampleSize, 25)
  const ev = ind.evidence as { confidence: string; calibrationVersion: number; recencyHalfLifeDays: number }
  assert.equal(ev.confidence, 'Low')
  assert.equal(ev.calibrationVersion, 1)
  assert.equal(ev.recencyHalfLifeDays, 180)
})

test('no recommendation when the proposal matches the current configuration', () => {
  const r = calibrate([...many(8, 'WON', 'Electrical'), ...many(4, 'LOST', 'Electrical'), ...many(1, 'WON', 'HVAC'), ...many(12, 'LOST', 'HVAC')])
  const drafts = buildRecommendationDrafts(r, {
    targetIndustries: ['Electrical'], minEmployees: r.icpUpdate.minEmployees ?? null,
    maxEmployees: r.icpUpdate.maxEmployees ?? null, signalWeights: r.signalWeights,
  })
  assert.deepEqual(drafts, [])
})

test('uncalibrated results produce no recommendations', () => {
  assert.deepEqual(buildRecommendationDrafts(calibrate([po2('WON', 'x')]), { targetIndustries: [], minEmployees: null, maxEmployees: null, signalWeights: {} }), [])
})

test('sameJson ignores key order (jsonb reorders keys)', () => {
  assert.equal(sameJson({ FUNDING: 1, HIRING: 2 }, { HIRING: 2, FUNDING: 1 }), true)
  assert.equal(sameJson({ a: [1, 2] }, { a: [2, 1] }), false)
})

test('among above-baseline industries, order is by adjusted lift, not win count', () => {
  // Busy: 20/40 wins (50%). Sharp: 9/10 wins (90%). Filler drags the baseline down.
  const r = calibrate([...many(20, 'WON', 'Busy'), ...many(20, 'LOST', 'Busy'), ...many(9, 'WON', 'Sharp'), ...many(1, 'LOST', 'Sharp'), ...many(5, 'WON', 'Filler'), ...many(95, 'LOST', 'Filler')])
  assert.deepEqual(r.icpUpdate.targetIndustries, ['sharp', 'busy'])
})

test('confidence label follows sample size', () => {
  assert.deepEqual([confidenceLabel(29), confidenceLabel(30), confidenceLabel(99), confidenceLabel(100)], ['Low', 'Medium', 'Medium', 'High'])
})
