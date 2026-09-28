// Adversarial + regression tests for the learning-system hardening (P0).
// Each test reproduces a specific defect the old learning loops had.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  recomputeScoringWeights, DEFAULT_SCORING_WEIGHTS, DEFAULT_MESSAGE_RELEVANCE, explainLeadScore,
  type ScoringOutcomeSample,
} from '../packages/backend-core/src/lib/scoring.ts'
import { learningAdaptationMode, isLearnableFeature, MAX_WEIGHT_STEP } from '../packages/backend-core/src/lib/learningMode.ts'

const sample = (replied: boolean, messageRelevance = DEFAULT_MESSAGE_RELEVANCE, score = 50): ScoringOutcomeSample =>
  ({ score, replied, messageRelevance, channelUsed: 'EMAIL' })

// ── Reply learning ──────────────────────────────────────────────────────────

test('constant feature: a 0.5 placeholder never acquires weight, however many outcomes', () => {
  const outcomes = Array.from({ length: 500 }, (_, i) => sample(i % 3 === 0, 0.5, 20 + (i % 60)))
  let w = { ...DEFAULT_SCORING_WEIGHTS }
  for (let i = 0; i < 100; i++) w = recomputeScoringWeights(outcomes, w).weights
  assert.deepEqual(w, DEFAULT_SCORING_WEIGHTS)
})

test('no evidence → no drift: weak score/reply correlation no longer ratchets weight away from industry', () => {
  const outcomes = Array.from({ length: 70 }, (_, i) => sample(i % 2 === 0))
  const r = recomputeScoringWeights(outcomes, { ...DEFAULT_SCORING_WEIGHTS })
  assert.equal(r.metrics.correlationScore, 0)
  assert.deepEqual(r.weights, DEFAULT_SCORING_WEIGHTS)
  assert.deepEqual(r.adjustedFeatures, [])
})

test('leakage invariant: the recorded predictor is the pre-send constant, not a reply-derived value', () => {
  // The old pipeline wrote replied ? 0.8 : 0.2. The scorer's own pre-send value
  // is the only legitimate value to record; it must equal what scoring used.
  const expl = explainLeadScore({ businessName: 'X', category: null, email: null, contactName: null, website: null } as never)
  assert.equal(expl.signals.messageRelevance, DEFAULT_MESSAGE_RELEVANCE)
})

test('leaked feature would be detected as the outcome itself, and even then moves at most ±10% per step', () => {
  // Construct the old leaked data (feature == outcome). If such data ever
  // arrives, the update is still bounded by MAX_WEIGHT_STEP.
  const outcomes = Array.from({ length: 60 }, (_, i) => { const r = i % 2 === 0; return sample(r, r ? 0.8 : 0.2) })
  const before = DEFAULT_SCORING_WEIGHTS.messageRelevance
  const { weights } = recomputeScoringWeights(outcomes, { ...DEFAULT_SCORING_WEIGHTS })
  const rawAfter = before * (1 + MAX_WEIGHT_STEP)
  const sum = 1 - before + rawAfter
  assert.ok(Math.abs(weights.messageRelevance - rawAfter / sum) < 1e-9)
})

test('small samples cannot move a weight (< 30 outcomes)', () => {
  const outcomes = Array.from({ length: 29 }, (_, i) => sample(i % 2 === 0, (i % 10) / 10))
  assert.equal(isLearnableFeature(outcomes.map(o => o.messageRelevance)), false)
  assert.deepEqual(recomputeScoringWeights(outcomes, { ...DEFAULT_SCORING_WEIGHTS }).weights, DEFAULT_SCORING_WEIGHTS)
})

// ── Adaptation mode ─────────────────────────────────────────────────────────

test('adaptation mode defaults to shadow and rejects unknown values', () => {
  const prev = process.env.LEARNING_ADAPTATION_MODE
  try {
    delete process.env.LEARNING_ADAPTATION_MODE
    assert.equal(learningAdaptationMode(), 'shadow')
    process.env.LEARNING_ADAPTATION_MODE = 'LIVE'
    assert.equal(learningAdaptationMode(), 'live')
    process.env.LEARNING_ADAPTATION_MODE = 'yolo'
    assert.equal(learningAdaptationMode(), 'shadow')
  } finally {
    if (prev === undefined) delete process.env.LEARNING_ADAPTATION_MODE
    else process.env.LEARNING_ADAPTATION_MODE = prev
  }
})

// ── Size is evidence-derived ────────────────────────────────────────────────

test('size is evidence-derived: a known in-range size is surfaced as a headline reason', () => {
  const base = { businessName: 'X', category: null, email: null, contactName: null, website: null }
  const known = explainLeadScore({ ...base, estimatedTeamSize: '10-50' } as never)
  assert.equal(known.signals.size, 1)
  assert.ok(known.topReasons.includes('Team size in the target range'), JSON.stringify(known.topReasons))
})
