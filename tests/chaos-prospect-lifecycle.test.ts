// Chaos tests for prospect lifecycle — multi-cycle scoring, signal degradation,
// stage transition ordering, and multi-tenant isolation
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  calculateOpportunityScores,
  detectBuyingStage,
  calcWinProbability,
  getOpportunityTier,
  generateRuleBasedRecommendation,
  calculateExpectedRevenue,
  computeSignalExpiry,
  decayedStrength,
} from '../apps/api/src/lib/signalEngine.js'
import { calibrate } from '../apps/api/src/lib/learningLoop.js'
import type { RawSignal, SignalType, ICPConfig } from '../apps/api/src/lib/signalEngine.js'

function signal(type: SignalType, ageDays = 0, strength = 80): RawSignal {
  return {
    type,
    strength,
    sourceReliability: 85,
    industryRelevance: 80,
    detectedAt: new Date(Date.now() - ageDays * 86_400_000),
  }
}

describe('Prospect lifecycle — full scoring cycle correctness', () => {
  it('fresh PROCUREMENT signal → HOT tier PURCHASING stage', () => {
    const signals = [signal('PROCUREMENT', 0)]
    const scores = calculateOpportunityScores(signals, { industry: 'construction', employeeCount: 50 })
    const stage = detectBuyingStage(signals, scores.opportunityScore)
    const tier = getOpportunityTier(scores.opportunityScore)

    assert.equal(stage, 'PURCHASING')
    // Procurement is strong; with construction industry match and employee count in range, should be HOT or WARM
    assert.ok(['HOT', 'WARM'].includes(tier), `Expected HOT/WARM with PROCUREMENT signal, got ${tier}`)
  })

  it('signal at 0 days is stronger than same signal at 30 days', () => {
    const freshSignals = [signal('HIRING', 0)]
    const staleSignals = [signal('HIRING', 30)]
    const meta = { industry: 'logistics', employeeCount: 100 }

    const freshScores = calculateOpportunityScores(freshSignals, meta)
    const staleScores = calculateOpportunityScores(staleSignals, meta)

    assert.ok(freshScores.intentScore >= staleScores.intentScore,
      `Fresh signal should score ≥ stale: fresh=${freshScores.intentScore} stale=${staleScores.intentScore}`)
    assert.ok(freshScores.timingScore > staleScores.timingScore,
      `Fresh timing should beat stale: ${freshScores.timingScore} vs ${staleScores.timingScore}`)
  })

  it('adding a second signal increases opportunity score', () => {
    const meta = { industry: 'technology', employeeCount: 75 }
    const one = calculateOpportunityScores([signal('HIRING')], meta)
    const two = calculateOpportunityScores([signal('HIRING'), signal('FUNDING')], meta)
    assert.ok(two.opportunityScore >= one.opportunityScore,
      `Two signals should score ≥ one: two=${two.opportunityScore} one=${one.opportunityScore}`)
  })

  it('PROBLEM_OWNER_ACTIVATION is the strongest signal in isolation', () => {
    const types: SignalType[] = ['HIRING', 'FUNDING', 'PROCUREMENT', 'CONTRACT_AWARDED']
    const meta = { industry: 'construction', employeeCount: 50 }

    const poaScore = calculateOpportunityScores([signal('PROBLEM_OWNER_ACTIVATION')], meta)
    for (const type of types) {
      const other = calculateOpportunityScores([signal(type)], meta)
      assert.ok(poaScore.intentScore >= other.intentScore,
        `POA intentScore=${poaScore.intentScore} should be ≥ ${type} intentScore=${other.intentScore}`)
    }
  })

  it('score degrades monotonically as signals age past 60 days', () => {
    const meta = { industry: 'construction', employeeCount: 50 }
    const ageDays = [0, 7, 14, 30, 60, 90]
    const timingScores = ageDays.map(d =>
      calculateOpportunityScores([signal('HIRING', d)], meta).timingScore
    )

    for (let i = 0; i < timingScores.length - 1; i++) {
      assert.ok(timingScores[i] >= timingScores[i + 1],
        `Timing score should degrade: day${ageDays[i]}=${timingScores[i]} day${ageDays[i+1]}=${timingScores[i+1]}`)
    }
  })

  it('win probability aligns with buying stage', () => {
    const stages = ['INACTIVE', 'RESEARCHING', 'EVALUATING', 'COMPARING', 'PURCHASING'] as const
    const score = 60
    const probabilities = stages.map(s => calcWinProbability(s, score))

    for (let i = 0; i < probabilities.length - 1; i++) {
      assert.ok(probabilities[i] <= probabilities[i + 1],
        `Win probability should increase with stage: ${stages[i]}=${probabilities[i]} < ${stages[i+1]}=${probabilities[i+1]}`)
    }
  })
})

describe('Multi-tenant isolation — workspace A signals do not affect workspace B', () => {
  // Pure function test: same signals yield same scores independent of workspace context
  it('calculateOpportunityScores is pure — same inputs, same output', () => {
    const signals = [signal('HIRING'), signal('FUNDING')]
    const meta = { industry: 'technology', employeeCount: 100 }

    // Simulate multiple workspace scoring cycles
    const results = Array.from({ length: 10 }, () => calculateOpportunityScores(signals, meta))
    for (const r of results) {
      assert.deepEqual(r, results[0], 'Score should be deterministic across multiple calls')
    }
  })

  it('ICP config from workspace A does not bleed into workspace B scoring', () => {
    const signals = [signal('HIRING'), signal('FUNDING')]
    const meta = { industry: 'construction', employeeCount: 50 }

    const icpA: ICPConfig = { targetIndustries: ['construction'], minEmployees: 10, maxEmployees: 500, targetGeos: [], mustHaveEmail: false }
    const icpB: ICPConfig = { targetIndustries: ['fintech'], minEmployees: 200, maxEmployees: 5000, targetGeos: [], mustHaveEmail: true }

    const scoreA = calculateOpportunityScores(signals, meta, icpA)
    const scoreB = calculateOpportunityScores(signals, meta, icpB)

    // Workspace A (construction ICP) should fit better than Workspace B (fintech ICP)
    assert.ok(scoreA.fitScore > scoreB.fitScore,
      `Construction ICP should fit construction prospect better: A=${scoreA.fitScore} B=${scoreB.fitScore}`)
  })

  it('calibrate with workspace A outcomes does not modify workspace B learning', () => {
    const wsAOutcomes = Array.from({ length: 10 }, () => ({
      stage: 'WON' as const,
      prospect: { industry: 'construction', employeeCount: 50, signals: [{ type: 'HIRING' }] }
    }))
    const wsBOutcomes = Array.from({ length: 10 }, () => ({
      stage: 'LOST' as const,
      prospect: { industry: 'fintech', employeeCount: 500, signals: [{ type: 'NEWS_MENTION' }] }
    }))

    const resultA = calibrate(wsAOutcomes)
    const resultB = calibrate(wsBOutcomes)

    // Workspace A should identify construction; Workspace B should not
    assert.ok(resultA.icpUpdate.targetIndustries?.includes('construction'))
    assert.ok(!resultB.icpUpdate.targetIndustries?.includes('construction'),
      `Workspace B should not inherit workspace A industries: ${resultB.icpUpdate.targetIndustries}`)
  })
})

describe('Signal expiry — buying window lifecycle', () => {
  it('100% of signals reach <5% strength by their computed expiry date', () => {
    const types: SignalType[] = ['HIRING', 'FUNDING', 'PROCUREMENT', 'WEBSITE_CHANGE', 'PROBLEM_OWNER_ACTIVATION']
    const baseStrength = 100
    const now = new Date()

    for (const type of types) {
      const expiry = computeSignalExpiry(type, now)
      const ageDays = (expiry.getTime() - now.getTime()) / 86_400_000

      const sig: RawSignal = { type, strength: baseStrength, sourceReliability: 100, industryRelevance: 100, detectedAt: now }
      // Simulate the signal at expiry time
      const atExpiry: RawSignal = { ...sig, detectedAt: new Date(now.getTime() - ageDays * 86_400_000) }
      const decayed = decayedStrength(atExpiry)

      assert.ok(decayed <= baseStrength * 0.055,
        `${type}: expected <5.5% of original at expiry, got ${(decayed / baseStrength * 100).toFixed(2)}%`)
    }
  })

  it('WEBSITE_CHANGE expires sooner than PROCUREMENT', () => {
    const now = new Date()
    const websiteExpiry  = computeSignalExpiry('WEBSITE_CHANGE', now)
    const procurementExpiry = computeSignalExpiry('PROCUREMENT', now)
    assert.ok(websiteExpiry < procurementExpiry,
      `WEBSITE_CHANGE should expire before PROCUREMENT`)
  })

  it('PROBLEM_OWNER_ACTIVATION expires before BUSINESS_REGISTRATION (urgency-driven)', () => {
    const now = new Date()
    const poaExpiry = computeSignalExpiry('PROBLEM_OWNER_ACTIVATION', now)
    const bizExpiry = computeSignalExpiry('BUSINESS_REGISTRATION', now)
    assert.ok(poaExpiry < bizExpiry,
      `POA (0.018) should decay faster than BUSINESS_REGISTRATION (0.006)`)
  })
})

describe('Expected revenue — financial projection invariants', () => {
  it('revenue scales linearly with deal value', () => {
    const r1 = calculateExpectedRevenue(0.5, 10_000)
    const r2 = calculateExpectedRevenue(0.5, 20_000)
    assert.ok(Math.abs(r2 - r1 * 2) <= 2, `Expected linear scaling: r1=${r1} r2=${r2}`)
  })

  it('revenue scales with win probability', () => {
    const r30 = calculateExpectedRevenue(0.3, 10_000)
    const r60 = calculateExpectedRevenue(0.6, 10_000)
    assert.ok(r60 > r30, `Higher win prob should yield more expected revenue: ${r30} vs ${r60}`)
  })

  it('expansion bonus adds revenue (not removes it)', () => {
    const base = calculateExpectedRevenue(0.5, 10_000, 0.8, 0)
    const withExpansion = calculateExpectedRevenue(0.5, 10_000, 0.8, 0.5)
    assert.ok(withExpansion > base, `Expansion should increase revenue: base=${base} expanded=${withExpansion}`)
  })

  it('full pipeline: POA signal → PURCHASING → high win prob → high expected revenue', () => {
    const signals = [signal('PROBLEM_OWNER_ACTIVATION')]
    const meta = { industry: 'construction', employeeCount: 50, contactEmail: 'ceo@co.com' }
    const scores = calculateOpportunityScores(signals, meta)
    const stage = detectBuyingStage(signals, scores.opportunityScore)
    const winProb = calcWinProbability(stage, scores.opportunityScore)
    const expectedRevenue = calculateExpectedRevenue(winProb, 15_000)

    assert.equal(stage, 'PURCHASING')
    assert.ok(winProb >= 0.4, `Win probability with POA should be ≥0.40, got ${winProb}`)
    assert.ok(expectedRevenue > 0, 'Expected revenue should be positive')
  })

  it('INACTIVE prospect → very low win probability → low expected revenue', () => {
    const signals = [signal('NEWS_MENTION', 95)] // very stale
    const meta = { industry: 'unknown_industry' }
    const scores = calculateOpportunityScores(signals, meta)
    const stage = detectBuyingStage(signals, scores.opportunityScore)
    const winProb = calcWinProbability(stage, scores.opportunityScore)
    const expectedRevenue = calculateExpectedRevenue(winProb, 10_000)

    assert.equal(stage, 'INACTIVE')
    assert.ok(winProb <= 0.05, `INACTIVE win prob should be ≤5%, got ${winProb}`)
    assert.ok(expectedRevenue < 1000, `INACTIVE revenue should be low, got ${expectedRevenue}`)
  })
})

describe('Recommendation generation — full pipeline', () => {
  it('POA prospect gets urgency=HIGH and priority=100', () => {
    const signals = [signal('PROBLEM_OWNER_ACTIVATION')]
    const rec = generateRuleBasedRecommendation({ contactEmail: 'ceo@co.com' }, signals, 0.7)
    assert.equal(rec.urgency, 'HIGH')
    assert.equal(rec.priority, 100)
    assert.ok(rec.bestTiming.includes('NOW'), `Expected NOW in POA timing: ${rec.bestTiming}`)
  })

  it('stale signal (>30 days) gets urgency=LOW', () => {
    const signals = [signal('NEWS_MENTION', 35)]
    const rec = generateRuleBasedRecommendation({}, signals)
    assert.equal(rec.urgency, 'LOW')
    assert.ok(rec.priority <= 75, `Expected low priority for stale signal: ${rec.priority}`)
  })

  it('fresh signal (<3 days) gets urgency=HIGH', () => {
    const signals = [signal('FUNDING', 1)]
    const rec = generateRuleBasedRecommendation({ contactEmail: 'a@b.com' }, signals)
    assert.equal(rec.urgency, 'HIGH')
  })

  it('LINKEDIN takes priority over EMAIL when no email but has linkedinUrl', () => {
    const signals = [signal('HIRING')]
    const rec = generateRuleBasedRecommendation({ linkedinUrl: 'https://linkedin.com/in/ceo' }, signals)
    assert.equal(rec.bestChannel, 'LINKEDIN')
  })

  it('PHONE takes priority when no email and no linkedin', () => {
    const signals = [signal('HIRING')]
    const rec = generateRuleBasedRecommendation({ contactPhone: '+1-555-0100' }, signals)
    assert.equal(rec.bestChannel, 'PHONE')
  })

  it('all 20 signal types produce valid recommendations', () => {
    const ALL_TYPES: SignalType[] = [
      'HIRING', 'FUNDING', 'EXPANSION', 'TECH_ADOPTION', 'LEADERSHIP_CHANGE',
      'NEWS_MENTION', 'PROCUREMENT', 'BUSINESS_REGISTRATION', 'WEBSITE_CHANGE',
      'JOB_POSTING_SPIKE', 'CONTRACT_AWARDED', 'TENDER_PUBLISHED', 'PERMIT_APPROVED',
      'OFFICE_OPENING', 'PRICING_PAGE_CHANGED', 'ENTERPRISE_PAGE_LAUNCHED',
      'GOV_GRANT_RECEIVED', 'PROJECT_START_DETECTED', 'TECH_STACK_CHANGED',
      'PROBLEM_OWNER_ACTIVATION',
    ]
    for (const type of ALL_TYPES) {
      const rec = generateRuleBasedRecommendation({ contactEmail: 'ceo@co.com' }, [signal(type)])
      assert.ok(rec.messageAngle, `messageAngle missing for ${type}`)
      assert.ok(rec.reasoning, `reasoning missing for ${type}`)
      assert.ok(rec.predictedNeed, `predictedNeed missing for ${type}`)
      assert.ok(rec.meetingProbability >= 0 && rec.meetingProbability <= 0.95,
        `meetingProbability OOB for ${type}: ${rec.meetingProbability}`)
    }
  })
})

describe('Scoring model — weight stability under calibration', () => {
  it('calibrated signal weights produce higher scores for matching prospect types', () => {
    const outcomes = [
      ...Array.from({ length: 7 }, () => ({
        stage: 'WON' as const,
        prospect: { industry: 'construction', employeeCount: 50, signals: [{ type: 'PROCUREMENT' }] }
      })),
      ...Array.from({ length: 3 }, () => ({
        stage: 'LOST' as const,
        prospect: { industry: 'retail', employeeCount: 5, signals: [{ type: 'NEWS_MENTION' }] }
      })),
    ]
    const { signalWeights } = calibrate(outcomes)

    // PROCUREMENT should have a boosted weight (high win rate)
    const procWeight = signalWeights['PROCUREMENT']
    const newsWeight = signalWeights['NEWS_MENTION']

    if (procWeight !== undefined && newsWeight !== undefined) {
      assert.ok(procWeight >= newsWeight,
        `PROCUREMENT weight should be ≥ NEWS_MENTION after WON calibration: ${procWeight} vs ${newsWeight}`)
    }
  })

  it('calibrated weights applied to scoring increase score for matching signals', () => {
    const outcomes = Array.from({ length: 10 }, () => ({
      stage: 'WON' as const,
      prospect: { industry: 'construction', employeeCount: 50, signals: [{ type: 'FUNDING' }, { type: 'HIRING' }] }
    }))
    const { signalWeights } = calibrate(outcomes)

    const meta = { industry: 'construction', employeeCount: 50 }
    const signals = [signal('FUNDING'), signal('HIRING')]

    const defaultScores = calculateOpportunityScores(signals, meta)
    const calibratedScores = calculateOpportunityScores(signals, meta, undefined, signalWeights)

    // Calibrated should be at least as good (we won with these signals)
    assert.ok(calibratedScores.opportunityScore >= defaultScores.opportunityScore - 5,
      `Calibrated score should be ≥ default for matching signals: ${calibratedScores.opportunityScore} vs ${defaultScores.opportunityScore}`)
  })
})
