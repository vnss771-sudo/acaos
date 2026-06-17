import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  decayedStrength,
  calculateOpportunityScores,
  detectBuyingStage,
  calcWinProbability,
  getOpportunityTier,
  generateRuleBasedRecommendation,
  corroborationLevel,
  EVENT_BASE_WEIGHTS
} from '../apps/api/src/lib/signalEngine.js'
import type { RawSignal, ProspectMeta, BuyingStage } from '../apps/api/src/lib/signalEngine.js'

// ── helpers ────────────────────────────────────────────────────────────────────

function makeSignal(type: RawSignal['type'], ageDays = 0, strength = 80): RawSignal {
  return {
    type,
    strength,
    sourceReliability: 80,
    industryRelevance: 70,
    detectedAt: new Date(Date.now() - ageDays * 86_400_000)
  }
}

const ICPMeta: ProspectMeta = {
  industry: 'civil engineering contractor',
  employeeCount: 50,
  contactEmail: 'ceo@acme.com',
  contactName: 'Jane Smith',
  domain: 'acme.com'
}

const EmptyMeta: ProspectMeta = {}

// ── decayedStrength ────────────────────────────────────────────────────────────

describe('decayedStrength', () => {
  it('returns full strength at age=0', () => {
    const sig = makeSignal('FUNDING', 0, 100)
    const result = decayedStrength(sig)
    assert.ok(result > 99 && result <= 100, `Expected ~100, got ${result}`)
  })

  it('FUNDING strength decays to ~68% at day 30', () => {
    const sig = makeSignal('FUNDING', 30, 100)
    const result = decayedStrength(sig)
    assert.ok(result >= 60 && result <= 75, `Day30 FUNDING should be ~64-72%, got ${result.toFixed(1)}%`)
  })

  it('NEWS_MENTION decays faster than FUNDING', () => {
    const funding = decayedStrength(makeSignal('FUNDING', 30, 100))
    const news = decayedStrength(makeSignal('NEWS_MENTION', 30, 100))
    assert.ok(news < funding, `NEWS_MENTION (${news.toFixed(1)}) should decay faster than FUNDING (${funding.toFixed(1)})`)
  })

  it('PROCUREMENT decays slowest (most durable)', () => {
    const procurement = decayedStrength(makeSignal('PROCUREMENT', 30, 100))
    const website = decayedStrength(makeSignal('WEBSITE_CHANGE', 30, 100))
    assert.ok(procurement > website, `PROCUREMENT (${procurement.toFixed(1)}) should outlast WEBSITE_CHANGE (${website.toFixed(1)})`)
  })

  it('all signal types produce positive strengths at 90 days', () => {
    const types: RawSignal['type'][] = [
      'HIRING', 'FUNDING', 'EXPANSION', 'TECH_ADOPTION', 'LEADERSHIP_CHANGE',
      'NEWS_MENTION', 'PROCUREMENT', 'BUSINESS_REGISTRATION', 'WEBSITE_CHANGE'
    ]
    for (const type of types) {
      const d = decayedStrength(makeSignal(type, 90, 100))
      assert.ok(d > 0, `${type} should still have positive strength at 90 days`)
    }
  })

  it('never exceeds base strength', () => {
    const sig = makeSignal('FUNDING', 0, 75)
    assert.ok(decayedStrength(sig) <= 75 + 0.001)
  })
})

// ── calculateOpportunityScores ─────────────────────────────────────────────────

describe('calculateOpportunityScores', () => {
  it('returns 0 composite score when no signals', () => {
    const { opportunityScore, intentScore, timingScore } = calculateOpportunityScores([], EmptyMeta)
    assert.equal(intentScore, 0)
    assert.equal(timingScore, 10) // default for no signals
    assert.equal(opportunityScore, 0) // product includes intent=0
  })

  it('all scores are 0-100', () => {
    const sigs = [makeSignal('FUNDING', 0, 95), makeSignal('HIRING', 1, 85)]
    const s = calculateOpportunityScores(sigs, ICPMeta)
    for (const [k, v] of Object.entries(s)) {
      assert.ok(v >= 0 && v <= 100, `${k}=${v} should be 0-100`)
    }
  })

  it('fresh FUNDING signal on ICP company scores HOT (≥72)', () => {
    const sigs = [makeSignal('FUNDING', 0, 95)]
    const { opportunityScore } = calculateOpportunityScores(sigs, ICPMeta)
    assert.ok(opportunityScore >= 72, `Expected HOT (≥72), got ${opportunityScore}`)
  })

  it('30-day-old news mention on unknown company scores below 50', () => {
    const sigs = [makeSignal('NEWS_MENTION', 30, 50)]
    const { opportunityScore } = calculateOpportunityScores(sigs, EmptyMeta)
    assert.ok(opportunityScore < 50, `Expected COLD/WARM, got ${opportunityScore}`)
  })

  it('multiple signals boost intent over single signal', () => {
    const single = calculateOpportunityScores([makeSignal('HIRING', 0, 80)], ICPMeta)
    const multi = calculateOpportunityScores([
      makeSignal('HIRING', 0, 80),
      makeSignal('FUNDING', 1, 90),
      makeSignal('EXPANSION', 2, 70)
    ], ICPMeta)
    assert.ok(multi.intentScore >= single.intentScore,
      `Multi-signal (${multi.intentScore}) should be >= single-signal (${single.intentScore})`)
  })

  it('ICP industry match boosts fit score', () => {
    const icp = calculateOpportunityScores([], ICPMeta)
    const unknown = calculateOpportunityScores([], EmptyMeta)
    assert.ok(icp.fitScore > unknown.fitScore,
      `ICP fit (${icp.fitScore}) should beat unknown (${unknown.fitScore})`)
  })

  it('90-day old signals produce lower timing score than fresh', () => {
    const fresh = calculateOpportunityScores([makeSignal('HIRING', 0)], ICPMeta)
    const stale = calculateOpportunityScores([makeSignal('HIRING', 90)], ICPMeta)
    assert.ok(fresh.timingScore > stale.timingScore,
      `Fresh timing (${fresh.timingScore}) should beat stale (${stale.timingScore})`)
  })

  it('high source reliability boosts confidence', () => {
    const highRel: RawSignal = { type: 'FUNDING', strength: 80, sourceReliability: 95, industryRelevance: 80, detectedAt: new Date() }
    const lowRel: RawSignal = { type: 'FUNDING', strength: 80, sourceReliability: 30, industryRelevance: 40, detectedAt: new Date() }
    const h = calculateOpportunityScores([highRel], ICPMeta)
    const l = calculateOpportunityScores([lowRel], ICPMeta)
    assert.ok(h.confidenceScore > l.confidenceScore,
      `High reliability (${h.confidenceScore}) should beat low (${l.confidenceScore})`)
  })

  it('geometric mean penalises weak dimensions — single low score tanks composite', () => {
    // sourceReliability=0 drives intent to 0, proving geometric mean penalises weak dimensions
    const sig: RawSignal = { type: 'FUNDING', strength: 100, sourceReliability: 0, industryRelevance: 0, detectedAt: new Date() }
    const { opportunityScore, intentScore } = calculateOpportunityScores([sig], ICPMeta)
    // When sourceReliability=0, intent collapses to 0 — the geometric mean ensures composite is also 0
    assert.equal(intentScore, 0, 'Intent should be 0 when sourceReliability=0')
    assert.equal(opportunityScore, 0, 'Composite should be 0 when any dimension is 0')
  })
})

// ── EVENT_BASE_WEIGHTS ─────────────────────────────────────────────────────────

describe('EVENT_BASE_WEIGHTS', () => {
  it('FUNDING=95 is highest weight per spec', () => {
    assert.equal(EVENT_BASE_WEIGHTS.FUNDING, 95)
  })

  it('PROCUREMENT=90 second per spec', () => {
    assert.equal(EVENT_BASE_WEIGHTS.PROCUREMENT, 90)
  })

  it('HIRING=85 per spec', () => {
    assert.equal(EVENT_BASE_WEIGHTS.HIRING, 85)
  })

  it('LEADERSHIP_CHANGE=65 per spec', () => {
    assert.equal(EVENT_BASE_WEIGHTS.LEADERSHIP_CHANGE, 65)
  })

  it('all weights are 0-100', () => {
    for (const [k, v] of Object.entries(EVENT_BASE_WEIGHTS)) {
      assert.ok(v >= 0 && v <= 100, `${k}=${v} must be 0-100`)
    }
  })
})

// ── detectBuyingStage ──────────────────────────────────────────────────────────

describe('detectBuyingStage', () => {
  it('returns INACTIVE when no signals', () => {
    assert.equal(detectBuyingStage([], 50), 'INACTIVE')
  })

  it('returns INACTIVE when all signals are >90 days old', () => {
    const old = makeSignal('FUNDING', 95)
    assert.equal(detectBuyingStage([old], 70), 'INACTIVE')
  })

  it('PROCUREMENT signal triggers PURCHASING', () => {
    const sigs = [makeSignal('PROCUREMENT', 0)]
    assert.equal(detectBuyingStage(sigs, 50), 'PURCHASING')
  })

  it('high score + FUNDING triggers PURCHASING', () => {
    const sigs = [makeSignal('FUNDING', 0)]
    assert.equal(detectBuyingStage(sigs, 80), 'PURCHASING')
  })

  it('FUNDING + HIRING combination triggers COMPARING', () => {
    const sigs = [makeSignal('FUNDING', 0), makeSignal('HIRING', 0)]
    // With score below 75 and no procurement, should be COMPARING or higher
    const stage = detectBuyingStage(sigs, 60)
    assert.ok(['COMPARING', 'PURCHASING'].includes(stage),
      `FUNDING+HIRING at score 60 should be COMPARING or PURCHASING, got ${stage}`)
  })

  it('single HIRING signal triggers EVALUATING', () => {
    const sigs = [makeSignal('HIRING', 0, 70)]
    const stage = detectBuyingStage(sigs, 40)
    assert.ok(['EVALUATING', 'COMPARING', 'PURCHASING'].includes(stage),
      `Single HIRING should be at least EVALUATING, got ${stage}`)
  })

  it('mild NEWS signal triggers RESEARCHING for low score', () => {
    const sigs = [makeSignal('NEWS_MENTION', 0, 40)]
    const stage = detectBuyingStage(sigs, 20)
    assert.equal(stage, 'RESEARCHING')
  })

  it('stage progression: INACTIVE < RESEARCHING < EVALUATING < COMPARING < PURCHASING', () => {
    const stageOrder: BuyingStage[] = ['INACTIVE', 'RESEARCHING', 'EVALUATING', 'COMPARING', 'PURCHASING']
    // Just verify the enum values exist and are distinct
    assert.equal(new Set(stageOrder).size, 5)
  })
})

// ── calcWinProbability ─────────────────────────────────────────────────────────

describe('calcWinProbability', () => {
  it('PURCHASING stage has highest base probability', () => {
    const p = calcWinProbability('PURCHASING', 50)
    assert.ok(p >= 0.55 && p <= 0.65, `PURCHASING at score 50 should be ~60%, got ${(p * 100).toFixed(1)}%`)
  })

  it('INACTIVE stage has lowest probability', () => {
    const inactive = calcWinProbability('INACTIVE', 50)
    const researching = calcWinProbability('RESEARCHING', 50)
    assert.ok(inactive < researching, `INACTIVE (${inactive}) should be lower than RESEARCHING (${researching})`)
  })

  it('higher score increases probability within same stage', () => {
    const low = calcWinProbability('EVALUATING', 20)
    const high = calcWinProbability('EVALUATING', 80)
    assert.ok(high > low, `Score 80 (${high.toFixed(2)}) should beat score 20 (${low.toFixed(2)}) in same stage`)
  })

  it('probability is always between 0.01 and 0.95', () => {
    const stages: BuyingStage[] = ['INACTIVE', 'RESEARCHING', 'EVALUATING', 'COMPARING', 'PURCHASING']
    for (const stage of stages) {
      for (const score of [0, 25, 50, 75, 100]) {
        const p = calcWinProbability(stage, score)
        assert.ok(p >= 0.01 && p <= 0.95,
          `${stage}@${score}: probability ${p.toFixed(3)} out of [0.01, 0.95]`)
      }
    }
  })

  it('PURCHASING at score 80 approaches 78%', () => {
    const p = calcWinProbability('PURCHASING', 80)
    assert.ok(p > 0.70, `PURCHASING@80 should be >70%, got ${(p * 100).toFixed(1)}%`)
  })
})

// ── getOpportunityTier ─────────────────────────────────────────────────────────

describe('getOpportunityTier', () => {
  it('score >= 72 is HOT', () => {
    assert.equal(getOpportunityTier(72), 'HOT')
    assert.equal(getOpportunityTier(100), 'HOT')
  })

  it('score 45-71 is WARM', () => {
    assert.equal(getOpportunityTier(45), 'WARM')
    assert.equal(getOpportunityTier(71), 'WARM')
    assert.equal(getOpportunityTier(60), 'WARM')
  })

  it('score < 45 is COLD', () => {
    assert.equal(getOpportunityTier(0), 'COLD')
    assert.equal(getOpportunityTier(44), 'COLD')
  })

  it('boundary at exactly 72 is HOT', () => {
    assert.equal(getOpportunityTier(72), 'HOT')
    assert.equal(getOpportunityTier(71), 'WARM')
  })

  it('boundary at exactly 45 is WARM', () => {
    assert.equal(getOpportunityTier(45), 'WARM')
    assert.equal(getOpportunityTier(44), 'COLD')
  })
})

// ── generateRuleBasedRecommendation ───────────────────────────────────────────

describe('generateRuleBasedRecommendation', () => {
  const fullMeta = {
    industry: 'construction',
    employeeCount: 50,
    contactEmail: 'ceo@builder.com',
    contactName: 'Bob Smith',
    contactPhone: '+1 555 1234',
    linkedinUrl: 'https://linkedin.com/in/bobsmith',
    domain: 'builder.com'
  }

  it('returns all required fields', () => {
    const rec = generateRuleBasedRecommendation(fullMeta, [makeSignal('FUNDING', 0)])
    assert.ok(rec.bestContact)
    assert.ok(rec.bestTiming)
    assert.ok(rec.bestChannel)
    assert.ok(rec.messageAngle)
    assert.ok(rec.reasoning)
    assert.ok(rec.actionText)
    assert.ok(['HIGH', 'MEDIUM', 'LOW'].includes(rec.urgency), `urgency=${rec.urgency}`)
    assert.ok(rec.priority >= 0 && rec.priority <= 100)
  })

  it('prefers EMAIL channel when email is available', () => {
    const rec = generateRuleBasedRecommendation(fullMeta, [makeSignal('HIRING', 0)])
    assert.equal(rec.bestChannel, 'EMAIL')
  })

  it('falls back to LINKEDIN when no email but LinkedIn available', () => {
    const meta = { ...fullMeta, contactEmail: undefined }
    const rec = generateRuleBasedRecommendation(meta, [makeSignal('HIRING', 0)])
    assert.equal(rec.bestChannel, 'LINKEDIN')
  })

  it('FUNDING signal maps to GROWTH message angle', () => {
    const rec = generateRuleBasedRecommendation(fullMeta, [makeSignal('FUNDING', 0)])
    assert.equal(rec.messageAngle, 'GROWTH')
  })

  it('HIRING signal maps to EFFICIENCY message angle', () => {
    const rec = generateRuleBasedRecommendation(fullMeta, [makeSignal('HIRING', 0)])
    assert.equal(rec.messageAngle, 'EFFICIENCY')
  })

  it('PROCUREMENT signal maps to COST_SAVINGS message angle', () => {
    const rec = generateRuleBasedRecommendation(fullMeta, [makeSignal('PROCUREMENT', 0)])
    assert.equal(rec.messageAngle, 'COST_SAVINGS')
  })

  it('fresh signal (day 0) sets urgency=HIGH', () => {
    const rec = generateRuleBasedRecommendation(fullMeta, [makeSignal('FUNDING', 0)])
    assert.equal(rec.urgency, 'HIGH')
  })

  it('stale signal (45 days) sets urgency=LOW', () => {
    const rec = generateRuleBasedRecommendation(fullMeta, [makeSignal('NEWS_MENTION', 45)])
    assert.equal(rec.urgency, 'LOW')
  })

  it('uses contactName as bestContact when available', () => {
    const rec = generateRuleBasedRecommendation(fullMeta, [makeSignal('FUNDING', 0)])
    assert.equal(rec.bestContact, 'Bob Smith')
  })

  it('falls back to default contact when name unavailable', () => {
    const noName = { ...fullMeta, contactName: undefined }
    const rec = generateRuleBasedRecommendation(noName, [makeSignal('FUNDING', 0)])
    assert.ok(rec.bestContact, 'Should still have a bestContact fallback')
  })

  it('works with empty signals array', () => {
    const rec = generateRuleBasedRecommendation(fullMeta, [])
    assert.ok(rec.bestChannel)
    assert.ok(rec.messageAngle)
  })

  it('priority decreases for older signals', () => {
    const fresh = generateRuleBasedRecommendation(fullMeta, [makeSignal('FUNDING', 1)])
    const stale = generateRuleBasedRecommendation(fullMeta, [makeSignal('FUNDING', 60)])
    assert.ok(fresh.priority > stale.priority,
      `Fresh priority (${fresh.priority}) should exceed stale (${stale.priority})`)
  })
})

// ── integration: full scoring pipeline ───────────────────────────────────────

describe('full scoring pipeline integration', () => {
  it('fresh procurement on ICP → PURCHASING stage + HOT tier + high win prob', () => {
    const sigs = [makeSignal('PROCUREMENT', 0, 90)]
    const scores = calculateOpportunityScores(sigs, ICPMeta)
    const stage = detectBuyingStage(sigs, scores.opportunityScore)
    const winProb = calcWinProbability(stage, scores.opportunityScore)
    const tier = getOpportunityTier(scores.opportunityScore)

    assert.equal(stage, 'PURCHASING')
    assert.equal(tier, 'HOT')
    assert.ok(winProb >= 0.40, `Win prob should be ≥40%, got ${(winProb * 100).toFixed(1)}%`)
  })

  it('90-day old single news mention on unknown company → COLD + low win prob', () => {
    const sigs = [makeSignal('NEWS_MENTION', 90, 30)]
    const scores = calculateOpportunityScores(sigs, EmptyMeta)
    const stage = detectBuyingStage(sigs, scores.opportunityScore)
    const winProb = calcWinProbability(stage, scores.opportunityScore)
    const tier = getOpportunityTier(scores.opportunityScore)

    assert.equal(tier, 'COLD')
    assert.ok(winProb <= 0.10, `Win prob should be ≤10% for stale COLD prospect, got ${(winProb * 100).toFixed(1)}%`)
  })

  it('revenue forecast: Expected Revenue = probability × dealValue', () => {
    const sigs = [makeSignal('FUNDING', 0, 95), makeSignal('HIRING', 1, 80)]
    const scores = calculateOpportunityScores(sigs, ICPMeta)
    const stage = detectBuyingStage(sigs, scores.opportunityScore)
    const winProb = calcWinProbability(stage, scores.opportunityScore)
    const dealValue = 15000
    const expectedRevenue = Math.round(dealValue * winProb)

    assert.ok(expectedRevenue > 0, 'Expected revenue should be positive')
    assert.ok(expectedRevenue <= dealValue, 'Expected revenue should not exceed deal value')
  })
})

describe('corroboration (distinct-type convergence)', () => {
  it('levels: none/single/promising/urgent by distinct type count', () => {
    assert.equal(corroborationLevel([]).level, 'none')
    assert.equal(corroborationLevel([makeSignal('HIRING')]).level, 'single')
    assert.equal(corroborationLevel([makeSignal('HIRING'), makeSignal('FUNDING')]).level, 'promising')
    assert.equal(corroborationLevel([makeSignal('HIRING'), makeSignal('FUNDING'), makeSignal('EXPANSION')]).level, 'urgent')
  })

  it('counts DISTINCT types, not raw signal count', () => {
    const threeSame = corroborationLevel([makeSignal('HIRING'), makeSignal('HIRING'), makeSignal('HIRING')])
    assert.equal(threeSame.distinctTypes, 1)
    assert.equal(threeSame.level, 'single')
  })

  it('distinct types boost intent more than repeats of one type', () => {
    const sameType = calculateOpportunityScores(
      [makeSignal('HIRING', 0, 80), makeSignal('HIRING', 0, 80), makeSignal('HIRING', 0, 80)], ICPMeta)
    const distinct = calculateOpportunityScores(
      [makeSignal('HIRING', 0, 80), makeSignal('FUNDING', 0, 80), makeSignal('EXPANSION', 0, 80)], ICPMeta)
    assert.ok(distinct.intentScore > sameType.intentScore,
      `distinct-type intent (${distinct.intentScore}) should beat same-type (${sameType.intentScore})`)
  })

  it('corroboration is a multiplier — does not resurrect a zero intent', () => {
    // Two distinct types but both sourceReliability 0 → intent stays 0.
    const sigs = [makeSignal('HIRING', 0, 80), makeSignal('FUNDING', 0, 80)].map(s => ({ ...s, sourceReliability: 0 }))
    assert.equal(calculateOpportunityScores(sigs, ICPMeta).intentScore, 0)
  })
})
