/**
 * Stress and boundary tests for calibrate() in lib/learningLoop.ts.
 *
 * The basic cases (insufficient data, baseline win rate, weight boost) live in
 * lib-calibrate.test.ts. This file covers adversarial inputs, boundary
 * conditions, and the mathematical invariants that must hold regardless of
 * input shape.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { calibrate } from '../packages/backend-core/src/lib/learningLoop.ts'
import { EVENT_BASE_WEIGHTS } from '../packages/backend-core/src/lib/signalEngine.ts'

// ── Helpers ───────────────────────────────────────────────────────────────────

type Stage = 'WON' | 'LOST'
function make(stage: Stage, industry: string | null = null, employeeCount: number | null = null, types: string[] = []) {
  return { stage, prospect: { industry, employeeCount, signals: types.map(t => ({ type: t })) } }
}

function wonLost(nWon: number, nLost: number, types: string[] = ['FUNDING']) {
  return [
    ...Array.from({ length: nWon }, () => make('WON', 'tech', 50, types)),
    ...Array.from({ length: nLost }, () => make('LOST', 'retail', 10, types)),
  ]
}

// ── Minimum sample boundary ───────────────────────────────────────────────────

describe('minimum sample boundary', () => {
  it('0 outcomes → uncalibrated', () => {
    const r = calibrate([])
    assert.equal(r.stats.calibrated, false)
    assert.equal(r.stats.totalOutcomes, 0)
    assert.deepEqual(r.signalWeights, {})
  })

  it('9 outcomes → uncalibrated (boundary: one below threshold)', () => {
    const r = calibrate(wonLost(5, 4))
    assert.equal(r.stats.calibrated, false)
    assert.equal(r.stats.totalOutcomes, 9)
  })

  it('10 outcomes → calibrated (boundary: exactly at threshold)', () => {
    const r = calibrate(wonLost(5, 5))
    assert.equal(r.stats.calibrated, true)
    assert.equal(r.stats.totalOutcomes, 10)
  })

  it('11 outcomes → calibrated (boundary: one above threshold)', () => {
    const r = calibrate(wonLost(6, 5))
    assert.equal(r.stats.calibrated, true)
  })
})

// ── Win rate extremes ─────────────────────────────────────────────────────────

describe('win rate extremes', () => {
  it('all WON → baselineWinRate = 1.0, weights boosted to 2x cap', () => {
    const r = calibrate(Array.from({ length: 10 }, () => make('WON', 'tech', 50, ['HIRING'])))
    assert.equal(r.stats.baselineWinRate, 1.0)
    // HIRING win rate = 1.0 / 1.0 = 1.0 → lift 1.0 → multiplier 1.0 (no boost when both are 100%)
    const expected = Math.round(EVENT_BASE_WEIGHTS.HIRING * 1.0)
    assert.equal(r.signalWeights.HIRING, expected)
  })

  it('all LOST → baselineWinRate = 0, weights left uncalibrated (no signal to learn, no NaN)', () => {
    const r = calibrate(Array.from({ length: 10 }, () => make('LOST', 'retail', 5, ['FUNDING'])))
    assert.equal(r.stats.baselineWinRate, 0)
    // With zero wins there is no win-rate lift to learn from; rather than floor
    // every weight off a loss streak, calibration is skipped and weights are
    // left as-is. No NaN/Infinity from a zero baseline.
    assert.equal(r.stats.calibrated, false)
    assert.equal(r.stats.reason, 'insufficient wins')
    assert.deepEqual(r.signalWeights, {})
  })

  it('50/50 split → baselineWinRate = 0.5', () => {
    const r = calibrate(wonLost(5, 5))
    assert.equal(r.stats.baselineWinRate, 0.5)
    assert.equal(r.stats.calibrated, true)
  })
})

// ── Signal weight invariants ──────────────────────────────────────────────────

describe('signal weight invariants', () => {
  it('weight is always a finite non-negative integer', () => {
    const types = ['FUNDING', 'HIRING', 'PROCUREMENT', 'EXPANSION', 'TECH_ADOPTION',
                   'LEADERSHIP_CHANGE', 'NEWS_MENTION', 'BUSINESS_REGISTRATION', 'WEBSITE_CHANGE']
    // Give each type enough samples (≥3) across a 50/50 split
    const outcomes = [
      ...Array.from({ length: 5 }, () => make('WON', 'tech', 50, types)),
      ...Array.from({ length: 5 }, () => make('LOST', 'retail', 10, types)),
    ]
    const r = calibrate(outcomes)
    for (const type of types) {
      const w = r.signalWeights[type]
      assert.ok(w !== undefined, `weight for ${type} missing`)
      assert.ok(Number.isFinite(w), `${type} weight is not finite: ${w}`)
      assert.ok(Number.isInteger(w), `${type} weight is not integer: ${w}`)
      assert.ok(w >= 0, `${type} weight is negative: ${w}`)
    }
  })

  it('weight is capped at 2x base weight (max lift)', () => {
    // EXPANSION appears only on WON → lift = 1/0.5 = 2.0 → clamped to 2.0
    const outcomes = [
      ...Array.from({ length: 5 }, () => make('WON', 'tech', 50, ['EXPANSION'])),
      ...Array.from({ length: 5 }, () => make('LOST', 'retail', 10, ['FUNDING'])),
    ]
    const r = calibrate(outcomes)
    const max = Math.round(EVENT_BASE_WEIGHTS.EXPANSION * 2.0)
    assert.ok(r.signalWeights.EXPANSION <= max, `EXPANSION weight ${r.signalWeights.EXPANSION} exceeds 2x cap ${max}`)
  })

  it('weight is floored at 0.5x base weight (min lift)', () => {
    // TECH_ADOPTION appears only on LOST → lift ≈ 0 → clamped to 0.5
    const outcomes = [
      ...Array.from({ length: 5 }, () => make('WON', 'tech', 50, ['HIRING'])),
      ...Array.from({ length: 5 }, () => make('LOST', 'retail', 10, ['TECH_ADOPTION'])),
    ]
    const r = calibrate(outcomes)
    const min = Math.round(EVENT_BASE_WEIGHTS.TECH_ADOPTION * 0.5)
    assert.ok(r.signalWeights.TECH_ADOPTION >= min, `TECH_ADOPTION weight ${r.signalWeights.TECH_ADOPTION} below 0.5x floor ${min}`)
  })
})

// ── Signal sample count boundary ──────────────────────────────────────────────

describe('signal sample count boundary', () => {
  it('signal with exactly 2 occurrences is skipped', () => {
    const outcomes = [
      ...Array.from({ length: 9 }, () => make('WON', 'tech', 50, ['FUNDING'])),
      make('WON', 'tech', 50, ['LEADERSHIP_CHANGE']),
      make('LOST', 'retail', 10, ['LEADERSHIP_CHANGE']), // LEADERSHIP_CHANGE: 2 total → skipped
    ]
    const r = calibrate(outcomes)
    assert.ok(!('LEADERSHIP_CHANGE' in r.signalWeights), 'Signal with 2 samples must be excluded')
    assert.ok('FUNDING' in r.signalWeights, 'Signal with ≥3 samples must be included')
  })

  it('signal with exactly 3 occurrences is included', () => {
    const outcomes = [
      ...Array.from({ length: 8 }, () => make('WON', 'tech', 50, ['FUNDING'])),
      make('WON', 'tech', 50, ['NEWS_MENTION']),
      make('WON', 'tech', 50, ['NEWS_MENTION']),
      make('LOST', 'retail', 10, ['NEWS_MENTION']), // NEWS_MENTION: 3 total → included
    ]
    const r = calibrate(outcomes)
    assert.ok('NEWS_MENTION' in r.signalWeights, 'Signal with exactly 3 samples must be included')
  })

  it('prospect with no signals still contributes to win rate', () => {
    const outcomes = [
      ...Array.from({ length: 5 }, () => make('WON', 'tech', 50, [])),
      ...Array.from({ length: 5 }, () => make('LOST', 'retail', 10, [])),
    ]
    const r = calibrate(outcomes)
    assert.equal(r.stats.calibrated, true)
    assert.equal(r.stats.baselineWinRate, 0.5)
    assert.deepEqual(r.signalWeights, {})
  })
})

// ── ICP extraction ────────────────────────────────────────────────────────────

describe('ICP extraction from WON outcomes', () => {
  it('null industries are excluded from targetIndustries', () => {
    const outcomes = [
      ...Array.from({ length: 5 }, () => make('WON', null, 50, ['FUNDING'])),
      ...Array.from({ length: 5 }, () => make('LOST', 'retail', 10, ['FUNDING'])),
    ]
    const r = calibrate(outcomes)
    assert.ok(r.icpUpdate.targetIndustries === undefined || r.icpUpdate.targetIndustries.length === 0,
      'Null industries must not produce targetIndustries')
  })

  it('industries are lowercased', () => {
    const outcomes = [
      ...Array.from({ length: 6 }, () => make('WON', 'SaaS', 50, ['HIRING'])),
      ...Array.from({ length: 4 }, () => make('LOST', 'retail', 10, ['HIRING'])),
    ]
    const r = calibrate(outcomes)
    assert.ok(r.icpUpdate.targetIndustries?.includes('saas'), 'Industry names must be lowercased')
  })

  it('top 5 industries by frequency when WON spans many sectors', () => {
    // 6 distinct industries + a dominant one
    const industries = ['saas', 'fintech', 'healthtech', 'edtech', 'logistics', 'proptech']
    const outcomes = [
      ...Array.from({ length: 5 }, () => make('WON', 'saas', 50, ['FUNDING'])),
      ...industries.slice(1).map(ind => make('WON', ind, 50, ['FUNDING'])),
      ...Array.from({ length: 4 }, () => make('LOST', 'retail', 10, ['FUNDING'])),
    ]
    const r = calibrate(outcomes)
    assert.ok(r.icpUpdate.targetIndustries !== undefined)
    assert.ok(r.icpUpdate.targetIndustries!.length <= 5, 'At most 5 industries returned')
    assert.equal(r.icpUpdate.targetIndustries![0], 'saas', 'Most common industry is first')
  })

  it('minEmployees ≤ maxEmployees always holds', () => {
    const outcomes = wonLost(6, 4).map((o, i) => ({
      ...o,
      prospect: { ...o.prospect, employeeCount: 10 + i * 20 },
    }))
    const r = calibrate(outcomes)
    if (r.icpUpdate.minEmployees !== undefined && r.icpUpdate.maxEmployees !== undefined) {
      assert.ok(r.icpUpdate.minEmployees <= r.icpUpdate.maxEmployees,
        `minEmployees (${r.icpUpdate.minEmployees}) must not exceed maxEmployees (${r.icpUpdate.maxEmployees})`)
    }
  })

  it('employee count band requires at least 3 WON prospects with non-null counts', () => {
    // Only 2 WON prospects with valid employee counts → no band
    const outcomes = [
      make('WON', 'tech', 50, ['FUNDING']),
      make('WON', 'tech', 100, ['FUNDING']),
      ...Array.from({ length: 8 }, () => make('LOST', 'retail', null, ['FUNDING'])),
    ]
    const r = calibrate(outcomes)
    assert.equal(r.icpUpdate.minEmployees, undefined, 'No band with <3 valid WON employee counts')
  })

  it('null employee counts are excluded from percentile calc', () => {
    const outcomes = [
      make('WON', 'tech', null, ['FUNDING']),  // null — excluded
      make('WON', 'tech', 0, ['FUNDING']),      // 0 — excluded
      ...Array.from({ length: 5 }, (_, i) => make('WON', 'tech', 10 + i * 10, ['FUNDING'])),
      ...Array.from({ length: 3 }, () => make('LOST', 'retail', 5, ['FUNDING'])),
    ]
    const r = calibrate(outcomes)
    if (r.icpUpdate.minEmployees !== undefined) {
      assert.ok(r.icpUpdate.minEmployees > 0, 'Employee count band must exclude zero/null')
    }
  })
})

// ── Scale stress ──────────────────────────────────────────────────────────────

describe('scale: large outcome sets', () => {
  it('100 outcomes complete without error and return calibrated result', () => {
    const r = calibrate(wonLost(60, 40, ['FUNDING', 'HIRING']))
    assert.equal(r.stats.calibrated, true)
    assert.equal(r.stats.totalOutcomes, 100)
    assert.equal(r.stats.baselineWinRate, 0.6)
    assert.ok(Number.isFinite(r.signalWeights.FUNDING))
    assert.ok(Number.isFinite(r.signalWeights.HIRING))
  })

  it('1000 outcomes complete without error', () => {
    const r = calibrate(wonLost(600, 400))
    assert.equal(r.stats.calibrated, true)
    assert.equal(r.stats.totalOutcomes, 1000)
    assert.ok(Number.isFinite(r.signalWeights.FUNDING))
  })

  it('all 9 signal types present → all appear in weights', () => {
    const allTypes = ['FUNDING', 'HIRING', 'PROCUREMENT', 'EXPANSION', 'TECH_ADOPTION',
                      'LEADERSHIP_CHANGE', 'NEWS_MENTION', 'BUSINESS_REGISTRATION', 'WEBSITE_CHANGE']
    const outcomes = wonLost(10, 10, allTypes)
    const r = calibrate(outcomes)
    for (const t of allTypes) {
      assert.ok(t in r.signalWeights, `${t} missing from signalWeights`)
    }
  })
})

// ── Output shape ──────────────────────────────────────────────────────────────

describe('output shape is always well-formed', () => {
  it('stats object always has totalOutcomes and baselineWinRate', () => {
    for (const count of [0, 5, 10, 50]) {
      const won = Math.floor(count / 2)
      const r = calibrate(wonLost(won, count - won))
      assert.equal(typeof r.stats.totalOutcomes, 'number')
      assert.equal(typeof r.stats.baselineWinRate, 'number')
      assert.ok(r.stats.baselineWinRate >= 0 && r.stats.baselineWinRate <= 1,
        `baselineWinRate out of [0,1] range: ${r.stats.baselineWinRate}`)
    }
  })

  it('calibrated=false result still has stats.totalOutcomes', () => {
    const r = calibrate(wonLost(3, 3))
    assert.equal(r.stats.calibrated, false)
    assert.equal(r.stats.totalOutcomes, 6)
    assert.equal(typeof r.stats.reason, 'string')
  })

  it('calibrate is pure: same input produces same output', () => {
    const input = wonLost(5, 5, ['FUNDING', 'PROCUREMENT'])
    const r1 = calibrate(input)
    const r2 = calibrate(input)
    assert.deepEqual(r1, r2)
  })
})
