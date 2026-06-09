import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { calibrate } from '../apps/api/src/lib/learningLoop.js'
import type { OutcomeRecord } from '../apps/api/src/lib/learningLoop.js'

function makeOutcome(stage: 'WON' | 'LOST', opts: {
  industry?: string
  employeeCount?: number
  signalTypes?: string[]
} = {}): OutcomeRecord {
  return {
    stage,
    prospect: {
      industry: opts.industry ?? null,
      employeeCount: opts.employeeCount ?? null,
      signals: (opts.signalTypes ?? []).map(t => ({ type: t }))
    }
  }
}

describe('calibrate — insufficient data', () => {
  it('returns calibrated=false when fewer than 5 outcomes', () => {
    const result = calibrate([makeOutcome('WON'), makeOutcome('LOST')])
    assert.equal(result.stats.calibrated, false)
    assert.equal(result.stats.reason, 'insufficient_data')
  })

  it('returns empty signalWeights and icpUpdate when not calibrated', () => {
    const result = calibrate([makeOutcome('WON'), makeOutcome('LOST')])
    assert.deepEqual(result.signalWeights, {})
    assert.deepEqual(result.icpUpdate, {})
  })

  it('calibrates with exactly 5 outcomes', () => {
    const outcomes = [
      makeOutcome('WON'), makeOutcome('WON'), makeOutcome('WON'),
      makeOutcome('LOST'), makeOutcome('LOST')
    ]
    const result = calibrate(outcomes)
    assert.equal(result.stats.calibrated, true)
  })
})

describe('calibrate — signal weight computation', () => {
  function buildDataset(): OutcomeRecord[] {
    // 10 WON prospects with FUNDING + HIRING signals
    // 5 LOST prospects with only WEBSITE_CHANGE
    const won = Array.from({ length: 10 }, () =>
      makeOutcome('WON', { signalTypes: ['FUNDING', 'HIRING'] })
    )
    const lost = Array.from({ length: 5 }, () =>
      makeOutcome('LOST', { signalTypes: ['WEBSITE_CHANGE'] })
    )
    return [...won, ...lost]
  }

  it('FUNDING gets multiplier > 1 when it predicts WON', () => {
    const result = calibrate(buildDataset())
    assert.ok(result.stats.calibrated, 'should calibrate')
    assert.ok((result.signalWeights.FUNDING ?? 1) > 1,
      `FUNDING multiplier should be > 1, got ${result.signalWeights.FUNDING}`)
  })

  it('WEBSITE_CHANGE gets multiplier < 1 when it predicts LOST', () => {
    const result = calibrate(buildDataset())
    assert.ok((result.signalWeights.WEBSITE_CHANGE ?? 1) < 1,
      `WEBSITE_CHANGE multiplier should be < 1, got ${result.signalWeights.WEBSITE_CHANGE}`)
  })

  it('multipliers are clamped to [0.3, 3.0]', () => {
    const result = calibrate(buildDataset())
    for (const [, v] of Object.entries(result.signalWeights)) {
      assert.ok(v >= 0.3 && v <= 3.0, `multiplier ${v} out of [0.3, 3.0]`)
    }
  })

  it('signal types with fewer than 3 samples are not adjusted', () => {
    // PROCUREMENT appears only twice — should not be in weights
    const outcomes = [
      ...Array.from({ length: 8 }, () => makeOutcome('WON', { signalTypes: ['FUNDING'] })),
      makeOutcome('WON', { signalTypes: ['PROCUREMENT'] }),
      makeOutcome('LOST', { signalTypes: ['PROCUREMENT'] }),
    ]
    const result = calibrate(outcomes)
    assert.equal(result.signalWeights.PROCUREMENT, undefined,
      'PROCUREMENT had < 3 samples and should not be calibrated')
  })
})

describe('calibrate — ICP auto-update', () => {
  function buildICPDataset(): OutcomeRecord[] {
    return [
      ...Array.from({ length: 8 }, () => makeOutcome('WON', { industry: 'Construction', employeeCount: 80 })),
      ...Array.from({ length: 4 }, () => makeOutcome('WON', { industry: 'Logistics', employeeCount: 150 })),
      ...Array.from({ length: 3 }, () => makeOutcome('LOST', { industry: 'Agriculture', employeeCount: 5 })),
    ]
  }

  it('updates targetIndustries from WON prospects', () => {
    const result = calibrate(buildICPDataset())
    assert.ok(result.icpUpdate.targetIndustries?.includes('Construction'),
      'Construction should be in targetIndustries')
  })

  it('updates employee count range from WON prospects', () => {
    const result = calibrate(buildICPDataset())
    assert.ok(result.icpUpdate.minEmployees !== undefined, 'minEmployees should be set')
    assert.ok(result.icpUpdate.maxEmployees !== undefined, 'maxEmployees should be set')
    assert.ok((result.icpUpdate.minEmployees ?? 0) < (result.icpUpdate.maxEmployees ?? 0),
      'minEmployees should be less than maxEmployees')
  })

  it('does not update ICP when fewer than 5 WON prospects', () => {
    const outcomes = [
      makeOutcome('WON', { industry: 'Construction' }),
      makeOutcome('WON', { industry: 'Construction' }),
      makeOutcome('LOST'), makeOutcome('LOST'), makeOutcome('LOST')
    ]
    const result = calibrate(outcomes)
    assert.deepEqual(result.icpUpdate, {}, 'ICP update should be empty with < 5 WON')
  })
})

describe('calibrate — stats accuracy', () => {
  it('correctly computes baseline win rate', () => {
    const outcomes = [
      ...Array.from({ length: 7 }, () => makeOutcome('WON')),
      ...Array.from({ length: 3 }, () => makeOutcome('LOST'))
    ]
    const result = calibrate(outcomes)
    assert.equal(result.stats.wonCount, 7)
    assert.equal(result.stats.totalOutcomes, 10)
    assert.ok(Math.abs(result.stats.baselineWinRate - 0.7) < 0.001,
      `Win rate should be 0.7, got ${result.stats.baselineWinRate}`)
  })

  it('handles 100% win rate without dividing by zero', () => {
    const outcomes = Array.from({ length: 5 }, () => makeOutcome('WON'))
    const result = calibrate(outcomes)
    assert.equal(result.stats.calibrated, true)
    assert.equal(result.stats.baselineWinRate, 1.0)
  })
})
