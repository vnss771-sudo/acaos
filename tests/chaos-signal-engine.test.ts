// Chaos tests for signalEngine.ts — extremes, boundaries, adversarial inputs
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  calculateOpportunityScores,
  detectBuyingStage,
  calcWinProbability,
  getOpportunityTier,
  normalizeSignal,
  detectProblemOwnerActivation,
  computeSignalExpiry,
  decayedStrength,
  generateRuleBasedRecommendation,
  calculateExpectedRevenue,
  EVENT_BASE_WEIGHTS,
} from '../apps/api/src/lib/signalEngine.js'
import type { RawSignal, SignalType, FullSignal } from '../apps/api/src/lib/signalEngine.js'

const ALL_SIGNAL_TYPES: SignalType[] = [
  'HIRING', 'FUNDING', 'EXPANSION', 'TECH_ADOPTION', 'LEADERSHIP_CHANGE',
  'NEWS_MENTION', 'PROCUREMENT', 'BUSINESS_REGISTRATION', 'WEBSITE_CHANGE',
  'JOB_POSTING_SPIKE', 'CONTRACT_AWARDED', 'TENDER_PUBLISHED', 'PERMIT_APPROVED',
  'OFFICE_OPENING', 'PRICING_PAGE_CHANGED', 'ENTERPRISE_PAGE_LAUNCHED',
  'GOV_GRANT_RECEIVED', 'PROJECT_START_DETECTED', 'TECH_STACK_CHANGED',
  'PROBLEM_OWNER_ACTIVATION',
]

function freshSignal(type: SignalType, overrides: Partial<RawSignal> = {}): RawSignal {
  return {
    type,
    strength: 80,
    sourceReliability: 85,
    industryRelevance: 80,
    detectedAt: new Date(),
    ...overrides,
  }
}

describe('calculateOpportunityScores — score invariants', () => {
  it('all scores are integers in [0,100]', () => {
    const signals = ALL_SIGNAL_TYPES.map(t => freshSignal(t))
    const result = calculateOpportunityScores(signals, { industry: 'construction', employeeCount: 50 })
    for (const key of ['intentScore','fitScore','timingScore','confidenceScore','opportunityScore'] as const) {
      assert.ok(Number.isInteger(result[key]), `${key} should be integer`)
      assert.ok(result[key] >= 0 && result[key] <= 100, `${key}=${result[key]} out of range`)
    }
  })

  it('zero signals produces valid scores (no NaN/Infinity)', () => {
    const result = calculateOpportunityScores([], {})
    for (const v of Object.values(result)) {
      assert.ok(Number.isFinite(v), `got non-finite: ${v}`)
      assert.ok(v >= 0 && v <= 100)
    }
  })

  it('NaN strength does not propagate to opportunity score', () => {
    const signals = [freshSignal('HIRING', { strength: NaN })]
    const result = calculateOpportunityScores(signals, {})
    for (const v of Object.values(result)) {
      assert.ok(Number.isFinite(v), `NaN leaked into score: ${JSON.stringify(result)}`)
    }
  })

  it('Infinity strength is clamped — opportunityScore stays ≤100', () => {
    const signals = [freshSignal('FUNDING', { strength: Infinity })]
    const result = calculateOpportunityScores(signals, {})
    assert.ok(result.opportunityScore <= 100, `Score exceeded 100: ${result.opportunityScore}`)
    assert.ok(Number.isFinite(result.opportunityScore))
  })

  it('negative strength produces non-negative scores', () => {
    const signals = [freshSignal('HIRING', { strength: -100 })]
    const result = calculateOpportunityScores(signals, {})
    assert.ok(result.opportunityScore >= 0, `Negative strength leaked: ${result.opportunityScore}`)
  })

  it('zero strength signals produce zero intentScore', () => {
    const signals = [freshSignal('FUNDING', { strength: 0 }), freshSignal('HIRING', { strength: 0 })]
    const result = calculateOpportunityScores(signals, {})
    assert.equal(result.intentScore, 0)
  })

  it('1000 signals — no performance crash, score stays in range', () => {
    const signals = Array.from({ length: 1000 }, (_, i) =>
      freshSignal(ALL_SIGNAL_TYPES[i % ALL_SIGNAL_TYPES.length], { strength: Math.random() * 100 })
    )
    const start = Date.now()
    const result = calculateOpportunityScores(signals, { industry: 'technology', employeeCount: 200 })
    const elapsed = Date.now() - start
    assert.ok(elapsed < 500, `1000-signal scoring took ${elapsed}ms — too slow`)
    assert.ok(result.opportunityScore >= 0 && result.opportunityScore <= 100)
  })

  it('all signals older than 90 days — timing score bottoms out', () => {
    const old = new Date(Date.now() - 100 * 86_400_000)
    const signals = [freshSignal('HIRING', { detectedAt: old }), freshSignal('FUNDING', { detectedAt: old })]
    const result = calculateOpportunityScores(signals, {})
    assert.ok(result.timingScore <= 15, `Expected low timing score for stale signals, got ${result.timingScore}`)
  })

  it('future detectedAt is handled without error', () => {
    const future = new Date(Date.now() + 30 * 86_400_000)
    const signals = [freshSignal('HIRING', { detectedAt: future })]
    const result = calculateOpportunityScores(signals, {})
    // Future signal = negative age → exp(-rate*negativeAge) > 1 but clamped at cap
    assert.ok(Number.isFinite(result.opportunityScore))
    assert.ok(result.opportunityScore <= 100)
  })

  it('score is deterministic across repeated calls', () => {
    const signals = [freshSignal('PROCUREMENT'), freshSignal('HIRING')]
    const meta = { industry: 'logistics', employeeCount: 75, contactEmail: 'test@co.com' }
    const r1 = calculateOpportunityScores(signals, meta)
    const r2 = calculateOpportunityScores(signals, meta)
    assert.deepEqual(r1, r2)
  })

  it('ICP with empty arrays does not crash', () => {
    const signals = [freshSignal('FUNDING')]
    const result = calculateOpportunityScores(signals, { industry: 'construction' }, {
      targetIndustries: [],
      targetGeos: [],
      mustHaveEmail: false,
    })
    assert.ok(Number.isFinite(result.opportunityScore))
  })

  it('employee count edge cases: 0, -1, 9999999', () => {
    for (const employeeCount of [0, -1, 9_999_999]) {
      const result = calculateOpportunityScores([freshSignal('HIRING')], { employeeCount })
      assert.ok(result.fitScore >= 0 && result.fitScore <= 100, `fitScore OOB for employeeCount=${employeeCount}`)
    }
  })
})

describe('detectBuyingStage — stage transitions and edge cases', () => {
  it('all 20 signal types together → PURCHASING (POA present)', () => {
    const signals = ALL_SIGNAL_TYPES.map(t => freshSignal(t))
    assert.equal(detectBuyingStage(signals, 90), 'PURCHASING')
  })

  it('POA alone overrides all other signals', () => {
    const signals = [freshSignal('PROBLEM_OWNER_ACTIVATION', { strength: 1 })]
    assert.equal(detectBuyingStage(signals, 0), 'PURCHASING')
  })

  it('PROCUREMENT alone triggers PURCHASING regardless of score', () => {
    assert.equal(detectBuyingStage([freshSignal('PROCUREMENT')], 0), 'PURCHASING')
    assert.equal(detectBuyingStage([freshSignal('TENDER_PUBLISHED')], 10), 'PURCHASING')
    assert.equal(detectBuyingStage([freshSignal('CONTRACT_AWARDED')], 5), 'PURCHASING')
  })

  it('HIRING+FUNDING with score ≥75 → PURCHASING', () => {
    assert.equal(detectBuyingStage([freshSignal('HIRING'), freshSignal('FUNDING')], 75), 'PURCHASING')
  })

  it('HIRING+FUNDING with score 74 → COMPARING (not PURCHASING)', () => {
    assert.equal(detectBuyingStage([freshSignal('HIRING'), freshSignal('FUNDING')], 74), 'COMPARING')
  })

  it('score ≥65 alone → COMPARING', () => {
    assert.equal(detectBuyingStage([freshSignal('NEWS_MENTION')], 65), 'COMPARING')
  })

  it('very old signals (>90 days) → INACTIVE regardless of type', () => {
    const old = new Date(Date.now() - 91 * 86_400_000)
    const signals = [freshSignal('PROCUREMENT', { detectedAt: old })]
    assert.equal(detectBuyingStage(signals, 99), 'INACTIVE')
  })

  it('empty signals → INACTIVE', () => {
    assert.equal(detectBuyingStage([], 100), 'INACTIVE')
  })

  it('NEWS_MENTION alone → RESEARCHING', () => {
    assert.equal(detectBuyingStage([freshSignal('NEWS_MENTION')], 10), 'RESEARCHING')
  })

  it('score 45 with HIRING → EVALUATING', () => {
    const result = detectBuyingStage([freshSignal('HIRING')], 45)
    assert.ok(['EVALUATING', 'COMPARING'].includes(result), `unexpected: ${result}`)
  })
})

describe('calcWinProbability — clamping and stage ordering', () => {
  it('always in [0.01, 0.95]', () => {
    for (const stage of ['INACTIVE','RESEARCHING','EVALUATING','COMPARING','PURCHASING'] as const) {
      for (const score of [0, 25, 50, 75, 100, -1, 101, 200, -200]) {
        const p = calcWinProbability(stage, score)
        assert.ok(p >= 0.01 && p <= 0.95, `stage=${stage} score=${score} → p=${p} OOB`)
      }
    }
  })

  it('stage ordering: INACTIVE < RESEARCHING < EVALUATING < COMPARING < PURCHASING at score=50', () => {
    const scores = (['INACTIVE','RESEARCHING','EVALUATING','COMPARING','PURCHASING'] as const).map(s =>
      calcWinProbability(s, 50)
    )
    for (let i = 0; i < scores.length - 1; i++) {
      assert.ok(scores[i] < scores[i+1], `Stage ordering broken at index ${i}: ${scores[i]} ≥ ${scores[i+1]}`)
    }
  })

  it('higher score → higher win probability within same stage', () => {
    const p30 = calcWinProbability('EVALUATING', 30)
    const p70 = calcWinProbability('EVALUATING', 70)
    assert.ok(p30 < p70, `Higher score should yield higher win prob: ${p30} vs ${p70}`)
  })

  it('NaN score produces valid probability', () => {
    const p = calcWinProbability('COMPARING', NaN)
    assert.ok(Number.isFinite(p))
    assert.ok(p >= 0.01 && p <= 0.95)
  })
})

describe('getOpportunityTier — boundary conditions', () => {
  const cases: [number, string][] = [
    [100, 'HOT'], [72, 'HOT'], [71.9, 'WARM'], [71, 'WARM'],
    [45, 'WARM'], [44.9, 'COLD'], [44, 'COLD'], [0, 'COLD'],
    [-1, 'COLD'], [1000, 'HOT'], [NaN, 'COLD'],
  ]
  for (const [score, expected] of cases) {
    it(`score=${score} → ${expected}`, () => {
      assert.equal(getOpportunityTier(score), expected)
    })
  }
})

describe('decayedStrength — mathematical properties', () => {
  it('fresh signal (0 days) has full strength', () => {
    const sig = freshSignal('HIRING', { strength: 80, detectedAt: new Date() })
    const d = decayedStrength(sig)
    assert.ok(d > 78 && d <= 80, `Expected ~80, got ${d}`)
  })

  it('90-day-old signal retains >0 strength', () => {
    const old = new Date(Date.now() - 90 * 86_400_000)
    const sig = freshSignal('PROCUREMENT', { strength: 100, detectedAt: old })
    const d = decayedStrength(sig)
    assert.ok(d > 0 && d <= 100, `Out of range: ${d}`)
  })

  it('WEBSITE_CHANGE decays faster than PROCUREMENT', () => {
    const old = new Date(Date.now() - 30 * 86_400_000)
    const website = decayedStrength(freshSignal('WEBSITE_CHANGE', { strength: 100, detectedAt: old }))
    const proc = decayedStrength(freshSignal('PROCUREMENT', { strength: 100, detectedAt: old }))
    assert.ok(website < proc, `WEBSITE_CHANGE should decay faster than PROCUREMENT: ${website} vs ${proc}`)
  })

  it('zero-strength signal decays to zero', () => {
    const sig = freshSignal('FUNDING', { strength: 0, detectedAt: new Date(Date.now() - 30 * 86_400_000) })
    assert.equal(decayedStrength(sig), 0)
  })
})

describe('calculateExpectedRevenue — boundary/chaos inputs', () => {
  it('null/undefined win probability → 0', () => {
    assert.equal(calculateExpectedRevenue(null, 10000), 0)
    assert.equal(calculateExpectedRevenue(undefined, 10000), 0)
  })

  it('zero or negative deal value → 0', () => {
    assert.equal(calculateExpectedRevenue(0.5, 0), 0)
    assert.equal(calculateExpectedRevenue(0.5, -5000), 0)
    assert.equal(calculateExpectedRevenue(0.5, null), 0)
  })

  it('win probability clamped to [0,1]', () => {
    const overOne  = calculateExpectedRevenue(2.0, 10000)
    const baseline = calculateExpectedRevenue(1.0, 10000)
    assert.ok(overOne <= baseline * 1.1, `win prob >1 should not inflate: ${overOne} vs ${baseline}`)
  })

  it('retention and expansion probabilities clamped to [0,1]', () => {
    const result = calculateExpectedRevenue(0.5, 10000, 5.0, -2.0)
    assert.ok(result >= 0 && Number.isFinite(result))
  })

  it('all NaN inputs → 0 or finite result', () => {
    const result = calculateExpectedRevenue(NaN, NaN)
    assert.ok(Number.isFinite(result))
    assert.equal(result, 0)
  })
})

describe('normalizeSignal — all 20 types have entries', () => {
  for (const type of ALL_SIGNAL_TYPES) {
    it(`normalizeSignal(${type}) returns valid object`, () => {
      const norm = normalizeSignal(type)
      assert.ok(norm.normalizedType, `normalizedType missing for ${type}`)
      assert.ok(norm.category, `category missing for ${type}`)
      assert.ok(norm.buyingImplication, `buyingImplication missing for ${type}`)
      assert.ok(Array.isArray(norm.predictedNeeds) && norm.predictedNeeds.length > 0, `predictedNeeds empty for ${type}`)
    })
  }
})

describe('detectProblemOwnerActivation — adversarial title inputs', () => {
  const base = { title: '', description: '', type: 'HIRING' as SignalType, strength: 80,
    sourceReliability: 80, industryRelevance: 80, detectedAt: new Date() }

  it('empty signals → not activated (returns NONE sentinel)', () => {
    const result = detectProblemOwnerActivation([])
    assert.equal(result.activated, false)
    assert.equal(result.activationTier, null)
    assert.equal(result.confidence, 0)
  })

  it('XSS in title does not crash detector', () => {
    const signals: FullSignal[] = [
      { ...base, title: '<script>alert("xss")</script> Head of Operations', type: 'HIRING' },
      { ...base, title: 'Upgrading systems', type: 'TECH_ADOPTION' },
    ]
    // Should not throw; returns a valid ProblemOwnerResult
    assert.doesNotThrow(() => {
      const result = detectProblemOwnerActivation(signals)
      assert.ok(typeof result.activated === 'boolean')
    })
  })

  it('SQL injection in description does not crash', () => {
    const signals: FullSignal[] = [
      { ...base, description: "'; DROP TABLE signals; --", title: 'VP Operations Hired', type: 'HIRING' },
    ]
    assert.doesNotThrow(() => detectProblemOwnerActivation(signals))
  })

  it('100 signals processed without error', () => {
    const signals: FullSignal[] = Array.from({ length: 100 }, (_, i) => ({
      ...base,
      type: ALL_SIGNAL_TYPES[i % ALL_SIGNAL_TYPES.length],
      title: `Signal title ${i}`,
    }))
    assert.doesNotThrow(() => detectProblemOwnerActivation(signals))
  })

  it('unicode in title does not crash', () => {
    const signals: FullSignal[] = [
      { ...base, title: '首席运营官 Director Operations 🚀', type: 'HIRING' },
      { ...base, title: 'procurement overhaul', type: 'PROCUREMENT' },
    ]
    assert.doesNotThrow(() => detectProblemOwnerActivation(signals))
  })

  it('null/undefined title and description handled gracefully', () => {
    const signals: FullSignal[] = [
      { ...base, title: null, description: null },
      { ...base, title: undefined as unknown as null },
    ]
    assert.doesNotThrow(() => detectProblemOwnerActivation(signals))
  })
})

describe('generateRuleBasedRecommendation — chaos inputs', () => {
  it('no signals returns default recommendation', () => {
    const rec = generateRuleBasedRecommendation({ contactEmail: 'a@b.com' }, [])
    assert.ok(rec.messageAngle, 'messageAngle missing')
    assert.ok(rec.bestChannel, 'bestChannel missing')
    assert.ok(Number.isFinite(rec.meetingProbability))
    assert.ok(rec.meetingProbability >= 0 && rec.meetingProbability <= 0.95)
  })

  it('all 20 signal types at once — no crash', () => {
    const signals = ALL_SIGNAL_TYPES.map(t => freshSignal(t))
    assert.doesNotThrow(() => generateRuleBasedRecommendation({ contactEmail: 'test@co.com' }, signals, 0.5))
  })

  it('meetingProbability always in [0, 0.95]', () => {
    for (const winProb of [0, 0.01, 0.5, 0.99, 1.0, 2.0, -1, NaN]) {
      const rec = generateRuleBasedRecommendation({}, [freshSignal('PROBLEM_OWNER_ACTIVATION')], winProb)
      assert.ok(rec.meetingProbability >= 0 && rec.meetingProbability <= 0.95,
        `meetingProbability=${rec.meetingProbability} OOB for winProb=${winProb}`)
    }
  })

  it('priority always in [10, 100]', () => {
    for (const type of ALL_SIGNAL_TYPES) {
      const old = new Date(Date.now() - 200 * 86_400_000)
      const rec = generateRuleBasedRecommendation({}, [freshSignal(type, { detectedAt: old })])
      assert.ok(rec.priority >= 10 && rec.priority <= 100, `priority=${rec.priority} OOB for type=${type}`)
    }
  })

  it('channel selection falls back to EMAIL when no contact info', () => {
    const rec = generateRuleBasedRecommendation({}, [freshSignal('FUNDING')])
    assert.equal(rec.bestChannel, 'EMAIL')
  })
})

describe('computeSignalExpiry — all signal types', () => {
  for (const type of ALL_SIGNAL_TYPES) {
    it(`${type} expiry is in the future from now`, () => {
      const expiry = computeSignalExpiry(type, new Date())
      assert.ok(expiry > new Date(), `${type} expiry ${expiry} is not in the future`)
    })
  }

  it('WEBSITE_CHANGE expires before PROCUREMENT (faster decay)', () => {
    const now = new Date()
    const webExpiry  = computeSignalExpiry('WEBSITE_CHANGE', now)
    const procExpiry = computeSignalExpiry('PROCUREMENT', now)
    assert.ok(webExpiry < procExpiry, `WEBSITE_CHANGE should expire before PROCUREMENT`)
  })
})

describe('EVENT_BASE_WEIGHTS — completeness and range', () => {
  it('all 20 signal types have weights in [1,100]', () => {
    for (const type of ALL_SIGNAL_TYPES) {
      const w = EVENT_BASE_WEIGHTS[type]
      assert.ok(w !== undefined, `Missing weight for ${type}`)
      assert.ok(w >= 1 && w <= 100, `Weight OOB for ${type}: ${w}`)
    }
  })

  it('PROBLEM_OWNER_ACTIVATION has max weight 100', () => {
    assert.equal(EVENT_BASE_WEIGHTS['PROBLEM_OWNER_ACTIVATION'], 100)
  })

  it('CONTRACT_AWARDED (98) > FUNDING (95) > HIRING (85)', () => {
    assert.ok(EVENT_BASE_WEIGHTS['CONTRACT_AWARDED'] > EVENT_BASE_WEIGHTS['FUNDING'])
    assert.ok(EVENT_BASE_WEIGHTS['FUNDING'] > EVENT_BASE_WEIGHTS['HIRING'])
  })
})
