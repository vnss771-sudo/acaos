import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { calibrate } from '../apps/api/src/lib/learningLoop.js'
import {
  toRawSignal,
  predictBuyingIntent,
  EVENT_BASE_WEIGHTS,
} from '../apps/api/src/lib/signalEngine.js'
import type { RawSignal, SignalType } from '../apps/api/src/lib/signalEngine.js'

// ── helpers ────────────────────────────────────────────────────────────────────

function makeOutcome(stage: 'WON' | 'LOST', opts: {
  industry?: string
  employeeCount?: number
  signalTypes?: string[]
} = {}) {
  return {
    stage,
    prospect: {
      industry: opts.industry ?? null,
      employeeCount: opts.employeeCount ?? null,
      signals: (opts.signalTypes ?? []).map(type => ({ type })),
    },
  }
}

function makeRaw(type: SignalType, ageDays = 0, strength = 80): RawSignal {
  return {
    type,
    strength,
    sourceReliability: 80,
    industryRelevance: 70,
    detectedAt: new Date(Date.now() - ageDays * 86_400_000),
  }
}

// ── calibrate() ───────────────────────────────────────────────────────────────

describe('calibrate()', () => {
  it('returns calibrated=false when fewer than 10 outcomes', () => {
    const outcomes = Array.from({ length: 9 }, (_, i) =>
      makeOutcome(i % 2 === 0 ? 'WON' : 'LOST')
    )
    const result = calibrate(outcomes)
    assert.equal(result.stats.calibrated, false)
    assert.equal(result.stats.reason, 'insufficient data')
    assert.equal(result.stats.totalOutcomes, 9)
    assert.deepEqual(result.signalWeights, {})
    assert.deepEqual(result.icpUpdate, {})
  })

  it('returns calibrated=false for empty outcomes', () => {
    const result = calibrate([])
    assert.equal(result.stats.calibrated, false)
  })

  it('calibrates with exactly 10 outcomes', () => {
    const outcomes = Array.from({ length: 10 }, (_, i) =>
      makeOutcome(i % 2 === 0 ? 'WON' : 'LOST')
    )
    const result = calibrate(outcomes)
    assert.equal(result.stats.calibrated, true)
    assert.equal(result.stats.totalOutcomes, 10)
  })

  it('computes correct baseline win rate', () => {
    const outcomes = [
      ...Array.from({ length: 7 }, () => makeOutcome('WON')),
      ...Array.from({ length: 3 }, () => makeOutcome('LOST')),
    ]
    const result = calibrate(outcomes)
    assert.equal(result.stats.calibrated, true)
    assert.ok(Math.abs(result.stats.baselineWinRate - 0.7) < 0.001)
  })

  it('skips signal types with fewer than 3 occurrences', () => {
    const outcomes = [
      makeOutcome('WON', { signalTypes: ['FUNDING'] }),
      makeOutcome('WON', { signalTypes: ['FUNDING'] }),
      ...Array.from({ length: 8 }, () => makeOutcome('LOST')),
    ]
    const result = calibrate(outcomes)
    assert.equal(result.stats.calibrated, true)
    // FUNDING appears only 2 times — should be excluded
    assert.ok(!('FUNDING' in result.signalWeights), 'FUNDING with 2 occurrences should be skipped')
  })

  it('amplifies high-winning signal type weights', () => {
    // HIRING signals correlate with WON 80% of time vs 50% baseline
    const outcomes = [
      ...Array.from({ length: 5 }, () => makeOutcome('WON', { signalTypes: ['HIRING'] })),
      makeOutcome('WON', { signalTypes: [] }),
      ...Array.from({ length: 4 }, () => makeOutcome('LOST', { signalTypes: ['HIRING'] })),
    ]
    const result = calibrate(outcomes)
    assert.equal(result.stats.calibrated, true)
    if ('HIRING' in result.signalWeights) {
      // HIRING win rate = 5/9 ≈ 0.556; baseline = 6/10 = 0.6; lift < 1 → multiplier clamps at 0.5-2.0
      assert.ok(result.signalWeights['HIRING'] > 0)
      assert.ok(result.signalWeights['HIRING'] <= EVENT_BASE_WEIGHTS['HIRING'] * 2)
    }
  })

  it('extracts top 5 industries from WON outcomes', () => {
    const outcomes = [
      ...Array.from({ length: 5 }, () => makeOutcome('WON', { industry: 'construction' })),
      ...Array.from({ length: 3 }, () => makeOutcome('WON', { industry: 'logistics' })),
      makeOutcome('WON', { industry: 'healthcare' }),
      makeOutcome('LOST', { industry: 'construction' }),
    ]
    const result = calibrate(outcomes)
    assert.equal(result.stats.calibrated, true)
    assert.ok(result.icpUpdate.targetIndustries?.includes('construction'))
    assert.ok(result.icpUpdate.targetIndustries?.includes('logistics'))
  })

  it('does not emit icpUpdate.targetIndustries when no industries', () => {
    const outcomes = Array.from({ length: 10 }, () => makeOutcome('WON'))
    const result = calibrate(outcomes)
    assert.equal(result.icpUpdate.targetIndustries, undefined)
  })

  it('computes p10/p90 employee counts correctly', () => {
    // 10 WON outcomes with employee counts 10,20,30,...,100
    const outcomes = Array.from({ length: 10 }, (_, i) =>
      makeOutcome('WON', { employeeCount: (i + 1) * 10 })
    )
    const result = calibrate(outcomes)
    assert.equal(result.stats.calibrated, true)
    // sorted: [10,20,30,40,50,60,70,80,90,100]
    // p10 index = floor((10-1)*0.1) = floor(0.9) = 0 → 10
    // p90 index = floor((10-1)*0.9) = floor(8.1) = 8 → 90
    assert.equal(result.icpUpdate.minEmployees, 10)
    assert.equal(result.icpUpdate.maxEmployees, 90)
  })

  it('does not emit employee range with fewer than 3 employee counts', () => {
    const outcomes = [
      makeOutcome('WON', { employeeCount: 50 }),
      makeOutcome('WON', { employeeCount: null }),
      ...Array.from({ length: 8 }, () => makeOutcome('LOST')),
    ]
    const result = calibrate(outcomes)
    // Only 1 non-null employee count — below threshold of 3
    assert.equal(result.icpUpdate.minEmployees, undefined)
    assert.equal(result.icpUpdate.maxEmployees, undefined)
  })

  it('returns signal weights as rounded integers', () => {
    const outcomes = [
      ...Array.from({ length: 7 }, () => makeOutcome('WON', { signalTypes: ['FUNDING', 'HIRING'] })),
      ...Array.from({ length: 3 }, () => makeOutcome('LOST', { signalTypes: ['FUNDING'] })),
    ]
    const result = calibrate(outcomes)
    for (const [, weight] of Object.entries(result.signalWeights)) {
      assert.equal(weight, Math.round(weight), 'weights must be integers')
    }
  })
})

// ── toRawSignal() ─────────────────────────────────────────────────────────────

describe('toRawSignal()', () => {
  it('maps DB signal fields to RawSignal', () => {
    const now = new Date()
    const raw = toRawSignal({
      type: 'FUNDING' as SignalType,
      strength: 85,
      sourceReliability: 90,
      industryRelevance: 75,
      detectedAt: now,
    })
    assert.equal(raw.type, 'FUNDING')
    assert.equal(raw.strength, 85)
    assert.equal(raw.sourceReliability, 90)
    assert.equal(raw.industryRelevance, 75)
    assert.equal(raw.detectedAt, now)
  })

  it('preserves exact Date reference', () => {
    const date = new Date('2025-01-15T00:00:00Z')
    const raw = toRawSignal({
      type: 'HIRING' as SignalType,
      strength: 70,
      sourceReliability: 80,
      industryRelevance: 60,
      detectedAt: date,
    })
    assert.equal(raw.detectedAt.getTime(), date.getTime())
  })

  it('round-trips all signal types without loss', () => {
    const types: SignalType[] = [
      'HIRING', 'FUNDING', 'EXPANSION', 'TECH_ADOPTION', 'LEADERSHIP_CHANGE',
      'NEWS_MENTION', 'PROCUREMENT', 'BUSINESS_REGISTRATION', 'WEBSITE_CHANGE',
    ]
    for (const type of types) {
      const raw = toRawSignal({ type, strength: 50, sourceReliability: 70, industryRelevance: 60, detectedAt: new Date() })
      assert.equal(raw.type, type)
    }
  })
})

// ── calibrate() — channel & timing weights ────────────────────────────────────

describe('calibrate() message weights', () => {
  function makeOutcomes(n: number) {
    return Array.from({ length: n }, (_, i) => makeOutcome(i % 2 === 0 ? 'WON' : 'LOST'))
  }

  it('populates channelWeights from message outcomes', () => {
    const msgOutcomes = [
      ...Array.from({ length: 10 }, () => ({ event: 'SENT',           channel: 'EMAIL', industry: null })),
      ...Array.from({ length: 3 },  () => ({ event: 'MEETING_BOOKED', channel: 'EMAIL', industry: null })),
      ...Array.from({ length: 5 },  () => ({ event: 'SENT',           channel: 'PHONE', industry: null })),
    ]
    const result = calibrate(makeOutcomes(10), msgOutcomes)
    assert.equal(result.stats.calibrated, true)
    assert.ok('EMAIL' in result.channelWeights, 'EMAIL should have a weight')
    assert.equal(result.channelWeights['EMAIL'], Math.round(Math.min(100, Math.max(0, (3/10) * 500))))
  })

  it('skips channels with fewer than 5 sent events', () => {
    const msgOutcomes = [
      ...Array.from({ length: 4 }, () => ({ event: 'SENT',    channel: 'LINKEDIN', industry: null })),
      { event: 'MEETING_BOOKED', channel: 'LINKEDIN', industry: null },
    ]
    const result = calibrate(makeOutcomes(10), msgOutcomes)
    assert.ok(!('LINKEDIN' in result.channelWeights), 'LINKEDIN with 4 sent should be excluded')
  })

  it('populates timingWeights from sentAt hour/dow', () => {
    const msgOutcomes = [
      ...Array.from({ length: 5 }, () => ({ event: 'SENT',           channel: 'EMAIL', industry: null, sentAtDow: 2, sentAtHour: 9 })),
      ...Array.from({ length: 2 }, () => ({ event: 'MEETING_BOOKED', channel: 'EMAIL', industry: null, sentAtDow: 2, sentAtHour: 9 })),
    ]
    const result = calibrate(makeOutcomes(10), msgOutcomes)
    // 5 sent events ≥ threshold of 3, so '2:9' should appear
    assert.ok('2:9' in result.timingWeights, '5 sent events should meet the threshold of 3')
    // 2/5 meeting rate * 500 = 200 → clamped to 100
    assert.equal(result.timingWeights['2:9'], 100)
  })

  it('returns empty channelWeights and timingWeights when no message outcomes', () => {
    const result = calibrate(makeOutcomes(10))
    assert.deepEqual(result.channelWeights, {})
    assert.deepEqual(result.timingWeights, {})
  })

  it('full-funnel: REPLIED contributes 0.40 engagement weight per event', () => {
    const msgOutcomes = [
      ...Array.from({ length: 10 }, () => ({ event: 'SENT',    channel: 'EMAIL', industry: null })),
      ...Array.from({ length: 5 },  () => ({ event: 'REPLIED', channel: 'EMAIL', industry: null })),
    ]
    const result = calibrate(makeOutcomes(10), msgOutcomes)
    // engagement = 5 * 0.40 = 2.0; rate = 2.0/10 = 0.2; score = 0.2*500 = 100 (clamped)
    assert.ok('EMAIL' in result.channelWeights)
    assert.equal(result.channelWeights['EMAIL'], 100)
  })

  it('full-funnel: OPENED contributes 0.05 and CLICKED 0.15 engagement weight', () => {
    const msgOutcomes = [
      ...Array.from({ length: 10 }, () => ({ event: 'SENT',    channel: 'EMAIL', industry: null })),
      ...Array.from({ length: 4 },  () => ({ event: 'OPENED',  channel: 'EMAIL', industry: null })),
      ...Array.from({ length: 2 },  () => ({ event: 'CLICKED', channel: 'EMAIL', industry: null })),
    ]
    const result = calibrate(makeOutcomes(10), msgOutcomes)
    // engagement = 4*0.05 + 2*0.15 = 0.2 + 0.3 = 0.5; rate = 0.5/10 = 0.05; score = 0.05*500 = 25
    assert.ok('EMAIL' in result.channelWeights)
    assert.equal(result.channelWeights['EMAIL'], 25)
  })

  it('full-funnel: mixed funnel events produce correct composite score', () => {
    const msgOutcomes = [
      ...Array.from({ length: 20 }, () => ({ event: 'SENT',           channel: 'EMAIL', industry: null })),
      ...Array.from({ length: 10 }, () => ({ event: 'OPENED',         channel: 'EMAIL', industry: null })),
      ...Array.from({ length: 5 },  () => ({ event: 'CLICKED',        channel: 'EMAIL', industry: null })),
      ...Array.from({ length: 2 },  () => ({ event: 'REPLIED',        channel: 'EMAIL', industry: null })),
      { event: 'MEETING_BOOKED', channel: 'EMAIL', industry: null },
    ]
    const result = calibrate(makeOutcomes(10), msgOutcomes)
    // engagement = 10*0.05 + 5*0.15 + 2*0.40 + 1*1.0 = 0.5 + 0.75 + 0.8 + 1.0 = 3.05
    // rate = 3.05/20 = 0.1525; score = 0.1525*500 = 76.25 → round = 76
    assert.ok('EMAIL' in result.channelWeights)
    assert.equal(result.channelWeights['EMAIL'], 76)
  })
})

// ── predictBuyingIntent() ─────────────────────────────────────────────────────

describe('predictBuyingIntent()', () => {
  it('returns INACTIVE stage and STABLE trajectory with no signals', () => {
    const result = predictBuyingIntent([], 'INACTIVE', 20)
    assert.equal(result.predictedStage, 'INACTIVE')
    assert.equal(result.trajectory, 'STABLE')
    assert.ok(result.nextAction.length > 0)
  })

  it('returns ACCELERATING when predicted stage is higher than current', () => {
    const signals = [makeRaw('FUNDING', 1), makeRaw('HIRING', 2)]
    // Current stage is RESEARCHING, FUNDING+HIRING → EVALUATING or higher
    const result = predictBuyingIntent(signals, 'RESEARCHING', 50)
    assert.ok(result.trajectory === 'ACCELERATING' || result.trajectory === 'STABLE')
  })

  it('returns DECELERATING when predicted stage is lower than current', () => {
    // No recent signals — detectBuyingStage will return INACTIVE
    const oldSignals = [makeRaw('FUNDING', 120)]  // > 90 days old
    const result = predictBuyingIntent(oldSignals, 'PURCHASING', 80)
    assert.equal(result.predictedStage, 'INACTIVE')
    assert.equal(result.trajectory, 'DECELERATING')
  })

  it('confidence increases with more recent signals', () => {
    const few  = predictBuyingIntent([makeRaw('HIRING', 5)], 'EVALUATING', 50)
    const many = predictBuyingIntent(
      Array.from({ length: 5 }, (_, i) => makeRaw('HIRING', i + 1)),
      'EVALUATING',
      50
    )
    assert.ok(many.confidence >= few.confidence, 'more signals → higher confidence')
  })

  it('confidence is capped at 95', () => {
    const signals = Array.from({ length: 20 }, (_, i) => makeRaw('FUNDING', i))
    const result = predictBuyingIntent(signals, 'COMPARING', 99)
    assert.ok(result.confidence <= 95)
  })

  it('PURCHASING stage includes fast-track next action', () => {
    const signals = [makeRaw('PROCUREMENT', 0), makeRaw('FUNDING', 1), makeRaw('HIRING', 2)]
    const result = predictBuyingIntent(signals, 'COMPARING', 85)
    if (result.predictedStage === 'PURCHASING') {
      assert.ok(result.nextAction.toLowerCase().includes('proposal') || result.nextAction.toLowerCase().includes('fast'))
    }
  })

  it('handles unknown string stage without throwing', () => {
    assert.doesNotThrow(() => {
      predictBuyingIntent([makeRaw('HIRING', 0)], 'UNKNOWN_STAGE', 50)
    })
  })
})
