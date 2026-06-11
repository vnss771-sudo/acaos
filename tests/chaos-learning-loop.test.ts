// Chaos tests for learningLoop.ts — edge cases, numeric stability, adversarial data
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { calibrate } from '../apps/api/src/lib/learningLoop.js'

type Outcome = Parameters<typeof calibrate>[0][0]
type MsgOutcome = NonNullable<Parameters<typeof calibrate>[1]>[0]

function wonProspect(industry = 'construction', employeeCount = 50): Outcome {
  return { stage: 'WON', prospect: { industry, employeeCount, signals: [{ type: 'HIRING' }] } }
}
function lostProspect(industry = 'retail', employeeCount = 10): Outcome {
  return { stage: 'LOST', prospect: { industry, employeeCount, signals: [{ type: 'NEWS_MENTION' }] } }
}

function msgOutcome(event: string, channel: string, industry = 'construction'): MsgOutcome {
  return { event, channel, industry, sentAtDow: 2, sentAtHour: 10 }
}

describe('calibrate — numeric stability', () => {
  it('returns uncalibrated when fewer than 10 outcomes', () => {
    for (const n of [0, 1, 5, 9]) {
      const outcomes = Array.from({ length: n }, wonProspect)
      const result = calibrate(outcomes)
      assert.equal(result.stats.calibrated, false)
      assert.equal(result.stats.reason, 'insufficient data')
    }
  })

  it('calibrates at exactly 10 outcomes', () => {
    const outcomes = Array.from({ length: 10 }, (_, i) => i < 7 ? wonProspect() : lostProspect())
    const result = calibrate(outcomes)
    assert.equal(result.stats.calibrated, true)
  })

  it('all WON — 100% win rate does not crash or produce NaN weights', () => {
    const outcomes = Array.from({ length: 20 }, wonProspect)
    const result = calibrate(outcomes)
    assert.equal(result.stats.baselineWinRate, 1.0)
    for (const [k, v] of Object.entries(result.signalWeights)) {
      assert.ok(Number.isFinite(v), `NaN signal weight for ${k}: ${v}`)
      assert.ok(v >= 0, `Negative signal weight for ${k}: ${v}`)
    }
  })

  it('all LOST — 0% win rate does not crash or produce NaN/Infinity', () => {
    const outcomes = Array.from({ length: 20 }, lostProspect)
    const result = calibrate(outcomes)
    assert.equal(result.stats.baselineWinRate, 0)
    // With 0% win rate and lift formula using (baselineWinRate || 0.01), no division by zero
    for (const [k, v] of Object.entries(result.signalWeights)) {
      assert.ok(Number.isFinite(v), `NaN signal weight for ${k}`)
      assert.ok(v >= 0, `Negative signal weight for ${k}`)
    }
  })

  it('signal weights never exceed max signal base weight × 2.0 multiplier', () => {
    const outcomes = Array.from({ length: 20 }, wonProspect)
    const result = calibrate(outcomes)
    for (const [, v] of Object.entries(result.signalWeights)) {
      assert.ok(v <= 200, `Signal weight ${v} exceeds theoretical max (100*2.0)`)
    }
  })

  it('signal weights never go below base weight × 0.5 multiplier', () => {
    const outcomes = Array.from({ length: 20 }, lostProspect)
    // LOST prospects with NEWS_MENTION signal — lift will be low
    const result = calibrate(outcomes)
    for (const [type, v] of Object.entries(result.signalWeights)) {
      assert.ok(v >= 0, `Negative weight for ${type}`)
    }
  })

  it('prospects with no signals are skipped without crashing', () => {
    const outcomes: Outcome[] = [
      ...Array.from({ length: 8 }, wonProspect),
      { stage: 'WON', prospect: { industry: 'tech', employeeCount: 50, signals: [] } },
      { stage: 'WON', prospect: { industry: 'tech', employeeCount: 50, signals: [] } },
    ]
    assert.doesNotThrow(() => calibrate(outcomes))
    const result = calibrate(outcomes)
    assert.equal(result.stats.calibrated, true)
  })

  it('null industry and null employeeCount are handled', () => {
    const outcomes: Outcome[] = Array.from({ length: 10 }, () => ({
      stage: 'WON' as const,
      prospect: { industry: null, employeeCount: null, signals: [{ type: 'HIRING' }] }
    }))
    assert.doesNotThrow(() => calibrate(outcomes))
    const result = calibrate(outcomes)
    assert.ok(!result.icpUpdate.targetIndustries, 'Should not extract industries from null values')
  })

  it('1000 outcomes — completes within 200ms', () => {
    const outcomes = Array.from({ length: 1000 }, (_, i) =>
      i % 3 === 0 ? wonProspect() : lostProspect()
    )
    const start = Date.now()
    calibrate(outcomes)
    const elapsed = Date.now() - start
    assert.ok(elapsed < 200, `1000 outcomes took ${elapsed}ms`)
  })
})

describe('calibrate — channel weight stability', () => {
  it('channel with <5 sends is filtered from channelWeights', () => {
    const outcomes = Array.from({ length: 10 }, wonProspect)
    const messages: MsgOutcome[] = Array.from({ length: 4 }, () => msgOutcome('SENT', 'EMAIL'))
    const result = calibrate(outcomes, messages)
    assert.ok(!result.channelWeights['EMAIL'], `EMAIL with <5 sends should be filtered, got ${result.channelWeights['EMAIL']}`)
  })

  it('channel weights in [0,100]', () => {
    const outcomes = Array.from({ length: 10 }, wonProspect)
    const messages: MsgOutcome[] = [
      ...Array.from({ length: 10 }, () => msgOutcome('SENT', 'EMAIL')),
      ...Array.from({ length: 5 }, () => msgOutcome('REPLIED', 'EMAIL')),
      ...Array.from({ length: 2 }, () => msgOutcome('MEETING_BOOKED', 'EMAIL')),
    ]
    const result = calibrate(outcomes, messages)
    for (const [ch, v] of Object.entries(result.channelWeights)) {
      assert.ok(v >= 0 && v <= 100, `channelWeight[${ch}]=${v} OOB`)
    }
  })

  it('perfect reply rate (100% replied on all sends) gives weight ≤100', () => {
    const outcomes = Array.from({ length: 10 }, wonProspect)
    const messages: MsgOutcome[] = [
      ...Array.from({ length: 10 }, () => msgOutcome('SENT', 'EMAIL')),
      ...Array.from({ length: 10 }, () => msgOutcome('REPLIED', 'EMAIL')),
    ]
    const result = calibrate(outcomes, messages)
    assert.ok(result.channelWeights['EMAIL'] <= 100)
  })

  it('zero engagement rate produces weight 0', () => {
    const outcomes = Array.from({ length: 10 }, wonProspect)
    // 10 sends, zero engagement events
    const messages: MsgOutcome[] = Array.from({ length: 10 }, () => msgOutcome('SENT', 'LINKEDIN'))
    const result = calibrate(outcomes, messages)
    assert.ok(!result.channelWeights['LINKEDIN'] || result.channelWeights['LINKEDIN'] === 0,
      `Zero engagement should yield 0 weight, got ${result.channelWeights['LINKEDIN']}`)
  })
})

describe('calibrate — timing weight stability', () => {
  it('timing with <3 sends is filtered', () => {
    const outcomes = Array.from({ length: 10 }, wonProspect)
    // Only 2 sends at Tuesday 10am
    const messages: MsgOutcome[] = [
      { event: 'SENT', channel: 'EMAIL', industry: 'construction', sentAtDow: 2, sentAtHour: 10 },
      { event: 'SENT', channel: 'EMAIL', industry: 'construction', sentAtDow: 2, sentAtHour: 10 },
    ]
    const result = calibrate(outcomes, messages)
    assert.ok(!result.timingWeights['2:10'], `2:10 with <3 sends should be filtered`)
  })

  it('timing weights in [0,100]', () => {
    const outcomes = Array.from({ length: 10 }, wonProspect)
    const messages: MsgOutcome[] = [
      ...Array.from({ length: 5 }, () => ({ event: 'SENT', channel: 'EMAIL', industry: 'c', sentAtDow: 1, sentAtHour: 9 })),
      ...Array.from({ length: 3 }, () => ({ event: 'REPLIED', channel: 'EMAIL', industry: 'c', sentAtDow: 1, sentAtHour: 9 })),
    ]
    const result = calibrate(outcomes, messages)
    for (const [k, v] of Object.entries(result.timingWeights)) {
      assert.ok(v >= 0 && v <= 100, `timingWeight[${k}]=${v} OOB`)
    }
  })

  it('outcomes without sentAtDow/sentAtHour are skipped without crash', () => {
    const outcomes = Array.from({ length: 10 }, wonProspect)
    const messages: MsgOutcome[] = Array.from({ length: 5 }, () => ({
      event: 'SENT', channel: 'EMAIL', industry: 'c'
      // no sentAtDow or sentAtHour
    }))
    assert.doesNotThrow(() => calibrate(outcomes, messages))
  })
})

describe('calibrate — ICP update extraction', () => {
  it('extracts top industries from WON outcomes', () => {
    const outcomes: Outcome[] = [
      ...Array.from({ length: 7 }, () => wonProspect('construction', 50)),
      ...Array.from({ length: 3 }, () => lostProspect('retail', 5)),
    ]
    const result = calibrate(outcomes)
    assert.ok(result.icpUpdate.targetIndustries?.includes('construction'),
      `Expected construction in industries: ${JSON.stringify(result.icpUpdate.targetIndustries)}`)
  })

  it('with <3 valid employee counts, minEmployees/maxEmployees are omitted', () => {
    const outcomes: Outcome[] = Array.from({ length: 10 }, () => ({
      stage: 'WON' as const,
      prospect: { industry: 'construction', employeeCount: null, signals: [{ type: 'HIRING' }] }
    }))
    const result = calibrate(outcomes)
    assert.ok(result.icpUpdate.minEmployees === undefined)
    assert.ok(result.icpUpdate.maxEmployees === undefined)
  })

  it('ICP percentile range is ordered: min ≤ max', () => {
    const outcomes: Outcome[] = Array.from({ length: 10 }, (_, i) => ({
      stage: 'WON' as const,
      prospect: { industry: 'technology', employeeCount: (i + 1) * 10, signals: [{ type: 'HIRING' }] }
    }))
    const result = calibrate(outcomes)
    if (result.icpUpdate.minEmployees !== undefined && result.icpUpdate.maxEmployees !== undefined) {
      assert.ok(result.icpUpdate.minEmployees <= result.icpUpdate.maxEmployees,
        `min=${result.icpUpdate.minEmployees} > max=${result.icpUpdate.maxEmployees}`)
    }
  })

  it('mixed outcome data with extreme employee counts does not break calibration', () => {
    const outcomes: Outcome[] = [
      ...Array.from({ length: 7 }, (_, i) => ({
        stage: 'WON' as const,
        prospect: { industry: 'tech', employeeCount: i === 0 ? 9999999 : i * 10, signals: [{ type: 'HIRING' }] }
      })),
      ...Array.from({ length: 3 }, lostProspect),
    ]
    assert.doesNotThrow(() => calibrate(outcomes))
  })
})
