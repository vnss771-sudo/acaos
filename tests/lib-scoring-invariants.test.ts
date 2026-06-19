// Governance net for the scoring constants. The individual constants already
// have behavioural tests; this file locks the *cross-constant invariants* the
// inline comments assert but nothing enforced — the relationships that must hold
// for the model to make sense, so an accidental edit to one number that breaks
// an ordering or a bound fails here instead of silently skewing every score.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  decayedStrength,
  calcWinProbability,
  getOpportunityTier,
  type RawSignal,
  type BuyingStage,
} from '../packages/backend-core/src/lib/signalEngine.ts'

function sig(type: RawSignal['type'], ageDays: number, strength = 100): RawSignal {
  return {
    type,
    strength,
    sourceReliability: 100,
    industryRelevance: 100,
    detectedAt: new Date(Date.now() - ageDays * 86_400_000),
  }
}

// SIGNAL_DECAY_RATES: the full durability ranking, not just the two pairwise
// cases the behavioural suite checks. Durable, slow-moving signals (procurement,
// a new business registration) must outlast volatile ones (a news mention, a
// website tweak) at the same age. Locks the relative ordering of all 9 rates.
test('decay durability ordering holds across every signal type', () => {
  const DURABILITY_ORDER: RawSignal['type'][] = [
    'BUSINESS_REGISTRATION', // slowest decay (most durable)
    'PROCUREMENT',
    'TECH_ADOPTION',
    'LEADERSHIP_CHANGE',
    'EXPANSION',
    'HIRING',
    'FUNDING',
    'NEWS_MENTION',
    'WEBSITE_CHANGE',        // fastest decay (most perishable)
  ]
  const atDay30 = DURABILITY_ORDER.map((t) => decayedStrength(sig(t, 30)))
  for (let i = 1; i < atDay30.length; i++) {
    assert.ok(
      atDay30[i] <= atDay30[i - 1] + 1e-9,
      `${DURABILITY_ORDER[i]} (${atDay30[i].toFixed(2)}) must not outlast ` +
      `${DURABILITY_ORDER[i - 1]} (${atDay30[i - 1].toFixed(2)}) at day 30`,
    )
  }
})

// STAGE_BASE_PROBS / calcWinProbability: win probability must rise with how far
// along the buying journey a company is, holding the opportunity score fixed.
// This enforces the strict ordering of the (non-exported) base-probability table.
test('win probability increases with buying-stage seriousness at a fixed score', () => {
  const ORDER: BuyingStage[] = ['INACTIVE', 'RESEARCHING', 'EVALUATING', 'COMPARING', 'PURCHASING']
  const probs = ORDER.map((s) => calcWinProbability(s, 60))
  for (let i = 1; i < probs.length; i++) {
    assert.ok(probs[i] > probs[i - 1], `${ORDER[i]} (${probs[i]}) must beat ${ORDER[i - 1]} (${probs[i - 1]})`)
  }
})

// calcWinProbability must be monotonic in the opportunity score at a fixed stage,
// and always clamped to the [0.01, 0.95] band regardless of input.
test('win probability is monotonic in opportunity score and stays within [0.01, 0.95]', () => {
  const scores = [0, 25, 50, 75, 100]
  const probs = scores.map((s) => calcWinProbability('EVALUATING', s))
  for (let i = 1; i < probs.length; i++) {
    assert.ok(probs[i] >= probs[i - 1], `score ${scores[i]} must not lower the probability`)
  }
  for (const s of [-100, 0, 50, 100, 1000]) {
    for (const stage of ['INACTIVE', 'PURCHASING'] as BuyingStage[]) {
      const p = calcWinProbability(stage, s)
      assert.ok(p >= 0.01 && p <= 0.95, `prob ${p} out of band for ${stage}@${s}`)
    }
  }
})

// getOpportunityTier: the HOT cutoff must sit strictly above the WARM cutoff, and
// the tier must never regress as the score climbs.
test('opportunity tier never regresses as the score rises', () => {
  const rank = { COLD: 0, WARM: 1, HOT: 2 } as const
  let prev = -1
  for (let score = 0; score <= 100; score++) {
    const r = rank[getOpportunityTier(score)]
    assert.ok(r >= prev, `tier regressed at score ${score}`)
    prev = r
  }
  assert.equal(getOpportunityTier(100), 'HOT')
  assert.equal(getOpportunityTier(0), 'COLD')
})
