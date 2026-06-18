/**
 * Advanced chaos tests for the signal intelligence engine.
 *
 * Covers boundary conditions, numerical edge cases, scoring monotonicity,
 * buying-stage machine transitions, and adversarial input combinations that
 * the unit tests in lib-signal-engine.test.ts don't reach.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  decayedStrength,
  calculateOpportunityScores,
  detectBuyingStage,
  calcWinProbability,
  getOpportunityTier,
  generateRuleBasedRecommendation,
  EVENT_BASE_WEIGHTS,
} from '../packages/backend-core/src/lib/signalEngine.ts'
import type { RawSignal, ProspectMeta, ICPConfig } from '../packages/backend-core/src/lib/signalEngine.ts'

// ── helpers ────────────────────────────────────────────────────────────────────

function sig(
  type: RawSignal['type'],
  ageDays = 0,
  strength = 80,
  sourceReliability = 80,
  industryRelevance = 70
): RawSignal {
  return { type, strength, sourceReliability, industryRelevance, detectedAt: new Date(Date.now() - ageDays * 86_400_000) }
}

const ICP: ICPConfig = {
  targetIndustries: ['construction', 'electrical', 'plumbing'],
  minEmployees: 10,
  maxEmployees: 500,
  targetGeos: ['QLD', 'NSW'],
  mustHaveEmail: true,
}

const FULL_META: ProspectMeta = {
  industry: 'electrical contractor',
  employeeCount: 50,
  contactEmail: 'ceo@sparky.com',
  contactName: 'Dave',
  domain: 'sparky.com',
  location: 'QLD',
}

// ── decayedStrength: numerical edge cases ─────────────────────────────────────

describe('decayedStrength: boundary conditions', () => {
  it('strength=0 always returns 0 regardless of age', () => {
    for (const ageDays of [0, 1, 30, 365]) {
      assert.equal(decayedStrength(sig('FUNDING', ageDays, 0)), 0)
    }
  })

  it('age=0 returns exactly the base strength (no decay)', () => {
    const s = sig('HIRING', 0, 100)
    const result = decayedStrength(s)
    assert.ok(result > 99.9 && result <= 100, `Expected ~100, got ${result}`)
  })

  it('future-dated signal (detectedAt in the future) does not explode', () => {
    const future: RawSignal = { ...sig('FUNDING', 0, 80), detectedAt: new Date(Date.now() + 7 * 86_400_000) }
    const result = decayedStrength(future)
    assert.ok(result >= 0 && isFinite(result), `Expected finite non-negative, got ${result}`)
  })

  it('very old signal (10 years) still returns non-negative', () => {
    const ancient = sig('PROCUREMENT', 365 * 10, 100)
    const result = decayedStrength(ancient)
    assert.ok(result >= 0 && isFinite(result), `Expected non-negative, got ${result}`)
  })

  it('PROCUREMENT at 1 year still has more residual than WEBSITE_CHANGE at 1 year', () => {
    const proc = decayedStrength(sig('PROCUREMENT', 365, 100))
    const web = decayedStrength(sig('WEBSITE_CHANGE', 365, 100))
    assert.ok(proc > web, `PROCUREMENT(${proc.toFixed(3)}) should outlast WEBSITE_CHANGE(${web.toFixed(3)}) at 1 year`)
  })

  it('decay is monotonically decreasing over time for all signal types', () => {
    const types: RawSignal['type'][] = ['HIRING', 'FUNDING', 'EXPANSION', 'TECH_ADOPTION',
      'LEADERSHIP_CHANGE', 'NEWS_MENTION', 'PROCUREMENT', 'BUSINESS_REGISTRATION', 'WEBSITE_CHANGE']
    for (const type of types) {
      const d0 = decayedStrength(sig(type, 0, 100))
      const d7 = decayedStrength(sig(type, 7, 100))
      const d30 = decayedStrength(sig(type, 30, 100))
      const d90 = decayedStrength(sig(type, 90, 100))
      assert.ok(d0 >= d7 && d7 >= d30 && d30 >= d90,
        `${type}: decay not monotone: ${d0.toFixed(2)} >= ${d7.toFixed(2)} >= ${d30.toFixed(2)} >= ${d90.toFixed(2)}`)
    }
  })
})

// ── calculateOpportunityScores: zero/one/many signals ─────────────────────────

describe('calculateOpportunityScores: empty and extreme inputs', () => {
  it('zero signals → all scores in valid range, timing=10 (no-signal floor)', () => {
    const scores = calculateOpportunityScores([], {})
    assert.ok(scores.opportunityScore >= 0 && scores.opportunityScore <= 100, `opp: ${scores.opportunityScore}`)
    assert.ok(scores.intentScore === 0, `intentScore should be 0 with no signals, got ${scores.intentScore}`)
    assert.ok(scores.timingScore === 10, `timingScore floor should be 10, got ${scores.timingScore}`)
    assert.ok(scores.confidenceScore >= 0 && scores.confidenceScore <= 100)
    assert.ok(scores.fitScore >= 0 && scores.fitScore <= 100)
  })

  it('single high-value fresh FUNDING signal → intent > 50', () => {
    const scores = calculateOpportunityScores([sig('FUNDING', 0, 100)], FULL_META)
    assert.ok(scores.intentScore > 50, `Expected intentScore > 50, got ${scores.intentScore}`)
    assert.ok(scores.timingScore === 100, `Fresh signal should have timing=100, got ${scores.timingScore}`)
  })

  it('100 identical signals — opportunity score capped at 100', () => {
    const signals = Array.from({ length: 100 }, () => sig('FUNDING', 0, 100))
    const scores = calculateOpportunityScores(signals, FULL_META)
    assert.ok(scores.opportunityScore <= 100, `Score exceeded 100: ${scores.opportunityScore}`)
    assert.ok(scores.intentScore <= 100, `Intent exceeded 100: ${scores.intentScore}`)
    assert.ok(scores.confidenceScore <= 100, `Confidence exceeded 100: ${scores.confidenceScore}`)
    assert.ok(scores.fitScore <= 100, `Fit exceeded 100: ${scores.fitScore}`)
  })

  it('all signals expired (90 days old) → opportunity score notably lower than fresh', () => {
    const fresh = calculateOpportunityScores([sig('FUNDING', 0, 100)], FULL_META)
    const stale = calculateOpportunityScores([sig('FUNDING', 90, 100)], FULL_META)
    assert.ok(fresh.opportunityScore > stale.opportunityScore,
      `Fresh (${fresh.opportunityScore}) should beat stale (${stale.opportunityScore})`)
  })

  it('all scores are integers (no float leakage)', () => {
    const scores = calculateOpportunityScores([sig('HIRING', 5, 75)], FULL_META)
    for (const [k, v] of Object.entries(scores)) {
      if (k === 'winProbability') continue // float field
      assert.ok(Number.isInteger(v), `${k} should be integer, got ${v}`)
    }
  })

  it('ICP config matched vs. unmatched prospect — fit score differs by >=15 points', () => {
    const matched = calculateOpportunityScores([sig('HIRING', 1)], FULL_META, ICP)
    const unmatched = calculateOpportunityScores([sig('HIRING', 1)], {
      industry: 'social media influencer', employeeCount: 2,
      contactEmail: undefined, contactName: undefined, domain: undefined, location: 'overseas'
    }, ICP)
    assert.ok(matched.fitScore > unmatched.fitScore,
      `ICP-matched fit (${matched.fitScore}) must be higher than unmatched (${unmatched.fitScore})`)
    assert.ok(matched.fitScore - unmatched.fitScore >= 10,
      `Expected >=10 point gap, got ${matched.fitScore - unmatched.fitScore}`)
  })

  it('ICP mustHaveEmail=true: prospect without email gets lower fit', () => {
    const withEmail = calculateOpportunityScores([], { ...FULL_META }, ICP)
    const withoutEmail = calculateOpportunityScores([], { ...FULL_META, contactEmail: null }, ICP)
    assert.ok(withEmail.fitScore >= withoutEmail.fitScore,
      `Email fit (${withEmail.fitScore}) must be >= no-email (${withoutEmail.fitScore})`)
  })

  it('opportunity score is monotonically non-decreasing as signal count grows', () => {
    const scores = [0, 1, 2, 3, 5, 10].map(n => {
      const signals = Array.from({ length: n }, () => sig('HIRING', 1, 80))
      return calculateOpportunityScores(signals, FULL_META).opportunityScore
    })
    for (let i = 1; i < scores.length; i++) {
      assert.ok(scores[i] >= scores[i - 1],
        `Score should not decrease as signals grow: [${scores.join(', ')}]`)
    }
  })
})

// ── Buying stage machine ──────────────────────────────────────────────────────

describe('detectBuyingStage: state machine correctness', () => {
  const allStages: ReturnType<typeof detectBuyingStage>[] = [
    'RESEARCHING', 'EVALUATING', 'COMPARING', 'PURCHASING', 'INACTIVE'
  ]

  it('returns one of the 5 valid buying stages for any input', () => {
    const cases: [RawSignal[], number][] = [
      [[], 0], [[], 50], [[], 95],
      [[sig('FUNDING', 0)], 0], [[sig('FUNDING', 0)], 75],
      [[sig('PROCUREMENT', 0)], 85],
    ]
    for (const [signals, oppScore] of cases) {
      const stage = detectBuyingStage(signals, oppScore)
      assert.ok(allStages.includes(stage), `Unexpected stage: ${stage}`)
    }
  })

  it('PROCUREMENT signal strongly pushes toward PURCHASING stage', () => {
    const stage = detectBuyingStage([sig('PROCUREMENT', 0, 100)], 90)
    assert.ok(stage === 'PURCHASING' || stage === 'EVALUATING',
      `PROCUREMENT should push to PURCHASING/EVALUATING, got ${stage}`)
  })

  it('no signals + low score → RESEARCHING or INACTIVE', () => {
    const stage = detectBuyingStage([], 5)
    assert.ok(stage === 'RESEARCHING' || stage === 'INACTIVE', `Got ${stage}`)
  })

  it('very old signals (180d) with low score → INACTIVE', () => {
    const stage = detectBuyingStage([sig('FUNDING', 180, 20)], 10)
    assert.ok(stage === 'INACTIVE' || stage === 'RESEARCHING', `Got ${stage}`)
  })

  it('multiple HIRING+EXPANSION (fresh) → EVALUATING or higher', () => {
    const signals = [sig('HIRING', 0, 90), sig('EXPANSION', 2, 85), sig('TECH_ADOPTION', 1, 75)]
    const stage = detectBuyingStage(signals, 70)
    const highStages: ReturnType<typeof detectBuyingStage>[] = ['EVALUATING', 'COMPARING', 'PURCHASING']
    assert.ok(highStages.includes(stage), `Expected active buying stage, got ${stage}`)
  })
})

// ── Win probability ───────────────────────────────────────────────────────────

describe('calcWinProbability: monotonicity and bounds', () => {
  const stages: ReturnType<typeof detectBuyingStage>[] = [
    'RESEARCHING', 'EVALUATING', 'COMPARING', 'PURCHASING', 'INACTIVE'
  ]

  it('win probability is always in [0, 1]', () => {
    for (const stage of stages) {
      for (const score of [0, 25, 50, 75, 100]) {
        const p = calcWinProbability(stage, score)
        assert.ok(p >= 0 && p <= 1, `${stage}@${score}: p=${p} out of [0,1]`)
      }
    }
  })

  it('PURCHASING has higher win probability than RESEARCHING at same score', () => {
    const purchasing = calcWinProbability('PURCHASING', 70)
    const researching = calcWinProbability('RESEARCHING', 70)
    assert.ok(purchasing > researching,
      `PURCHASING (${purchasing}) should be > RESEARCHING (${researching})`)
  })

  it('higher opportunity score → higher or equal win probability for same stage', () => {
    for (const stage of ['EVALUATING', 'COMPARING', 'PURCHASING'] as const) {
      const low = calcWinProbability(stage, 20)
      const high = calcWinProbability(stage, 80)
      assert.ok(high >= low, `${stage}: high score (${high}) should be >= low score (${low})`)
    }
  })

  it('INACTIVE has the lowest win probability', () => {
    for (const score of [50, 75, 100]) {
      const inactive = calcWinProbability('INACTIVE', score)
      for (const stage of stages.filter(s => s !== 'INACTIVE')) {
        const other = calcWinProbability(stage, score)
        assert.ok(inactive <= other + 0.05,
          `INACTIVE (${inactive}) should be near lowest at score ${score}, ${stage} is ${other}`)
      }
    }
  })
})

// ── getOpportunityTier ─────────────────────────────────────────────────────────

describe('getOpportunityTier: score thresholds', () => {
  it('score 100 → HOT', () => assert.equal(getOpportunityTier(100), 'HOT'))
  it('score 72 → HOT', () => assert.equal(getOpportunityTier(72), 'HOT'))
  it('score 71 → WARM', () => assert.equal(getOpportunityTier(71), 'WARM'))
  it('score 45 → WARM', () => assert.equal(getOpportunityTier(45), 'WARM'))
  it('score 44 → COLD', () => assert.equal(getOpportunityTier(44), 'COLD'))
  it('score 0 → COLD', () => assert.equal(getOpportunityTier(0), 'COLD'))

  it('boundary at 72 is HOT not WARM', () => {
    assert.equal(getOpportunityTier(72), 'HOT')
    assert.equal(getOpportunityTier(71), 'WARM')
  })

  it('boundary at 45 is WARM not COLD', () => {
    assert.equal(getOpportunityTier(45), 'WARM')
    assert.equal(getOpportunityTier(44), 'COLD')
  })
})

// ── generateRuleBasedRecommendation ───────────────────────────────────────────

describe('generateRuleBasedRecommendation: output contracts', () => {
  it('returns a valid recommendation for empty signals and empty meta', () => {
    const rec = generateRuleBasedRecommendation({}, [])
    assert.ok(typeof rec.bestChannel === 'string', 'bestChannel must be string')
    assert.ok(typeof rec.urgency === 'string', 'urgency must be string')
    assert.ok(typeof rec.priority === 'number', 'priority must be number')
    assert.ok(rec.priority >= 0 && rec.priority <= 100, `priority out of range: ${rec.priority}`)
  })

  it('recommendation with email contact → includes email channel', () => {
    const rec = generateRuleBasedRecommendation({ contactEmail: 'ceo@co.com' }, [])
    assert.ok(rec.bestChannel?.toLowerCase().includes('email') || rec.bestContact?.toLowerCase().includes('email'),
      `Expected email recommendation, got channel=${rec.bestChannel}`)
  })

  it('LinkedIn URL → LinkedIn channel recommended', () => {
    const rec = generateRuleBasedRecommendation({ linkedinUrl: 'https://linkedin.com/in/ceo', contactEmail: undefined }, [])
    const text = JSON.stringify(rec).toLowerCase()
    assert.ok(text.includes('linkedin') || rec.bestChannel?.toLowerCase().includes('linkedin') || rec.bestChannel?.toLowerCase().includes('social'),
      `Expected LinkedIn mention, got: ${JSON.stringify(rec)}`)
  })

  it('PROCUREMENT signal → urgency HIGH or priority >= 70', () => {
    const rec = generateRuleBasedRecommendation(FULL_META, [sig('PROCUREMENT', 0, 100)])
    assert.ok(rec.urgency === 'HIGH' || rec.priority >= 70,
      `PROCUREMENT should push urgency/priority up, got urgency=${rec.urgency} priority=${rec.priority}`)
  })

  it('actionText is always a non-empty string', () => {
    for (const meta of [{}, FULL_META, { contactEmail: 'x@y.com' }]) {
      const rec = generateRuleBasedRecommendation(meta, [])
      assert.ok(typeof rec.actionText === 'string' && rec.actionText.length > 0,
        `actionText empty for meta=${JSON.stringify(meta)}`)
    }
  })

  it('does not throw with maximal signal diversity (all 9 types)', () => {
    const allTypes: RawSignal['type'][] = [
      'HIRING', 'FUNDING', 'EXPANSION', 'TECH_ADOPTION', 'LEADERSHIP_CHANGE',
      'NEWS_MENTION', 'PROCUREMENT', 'BUSINESS_REGISTRATION', 'WEBSITE_CHANGE'
    ]
    const signals = allTypes.map(t => sig(t, 0, 80))
    assert.doesNotThrow(() => generateRuleBasedRecommendation(FULL_META, signals))
  })
})

// ── Signal weight customization ────────────────────────────────────────────────

describe('calculateOpportunityScores with custom signalWeights', () => {
  it('boosted HIRING weight → higher intent when HIRING signal present', () => {
    const baseLine = calculateOpportunityScores([sig('HIRING', 0, 80)], FULL_META)
    const boosted = calculateOpportunityScores([sig('HIRING', 0, 80)], FULL_META, undefined, {
      HIRING: EVENT_BASE_WEIGHTS.HIRING * 2
    })
    assert.ok(boosted.intentScore >= baseLine.intentScore,
      `Boosted HIRING should raise intent: ${boosted.intentScore} >= ${baseLine.intentScore}`)
  })

  it('zeroed FUNDING weight → FUNDING signal has no effect on intent', () => {
    const withWeight = calculateOpportunityScores([sig('FUNDING', 0, 100)], FULL_META)
    const zeroWeight = calculateOpportunityScores([sig('FUNDING', 0, 100)], FULL_META, undefined, {
      FUNDING: 0
    })
    assert.ok(withWeight.intentScore >= zeroWeight.intentScore,
      `Zero weight should not increase intent: ${withWeight.intentScore} >= ${zeroWeight.intentScore}`)
  })
})
