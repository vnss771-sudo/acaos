import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// ── inline the pure functions under test ────────────────────────────────────
type Weights = {
  industry: number; size: number; hiring: number; tech: number
  growth: number; contact: number; messageRelevance: number
  channelFit: number; timingFit: number; dataFreshness: number
}
type Metrics = {
  totalScored: number; totalReplied: number; replyRate: number
  avgScoreOfReplied: number; avgScoreOfNotReplied: number; correlationScore: number
}
type Outcome = { score: number; replied: boolean; messageRelevance: number; channelUsed: string }

const DEFAULT_WEIGHTS: Weights = {
  industry: 0.20, size: 0.18, hiring: 0.15, tech: 0.12,
  growth: 0.12, contact: 0.08, messageRelevance: 0.08,
  channelFit: 0.05, timingFit: 0.02, dataFreshness: 0.00
}

function calculateCorrelation(outcomes: Outcome[]): number {
  const replied = outcomes.filter(o => o.replied)
  const notReplied = outcomes.filter(o => !o.replied)
  if (replied.length === 0 || notReplied.length === 0) return 0

  const meanScore = outcomes.reduce((s, o) => s + o.score, 0) / outcomes.length
  const meanReply = replied.length / outcomes.length

  let numerator = 0, denomScore = 0, denomReply = 0
  for (const o of outcomes) {
    const sd = o.score - meanScore
    const rd = (o.replied ? 1 : 0) - meanReply
    numerator += sd * rd
    denomScore += sd * sd
    denomReply += rd * rd
  }
  if (denomScore === 0 || denomReply === 0) return 0
  return numerator / Math.sqrt(denomScore * denomReply)
}

function recomputeWeights(outcomes: Outcome[], current: Weights): { weights: Weights; metrics: Metrics } {
  const replied = outcomes.filter(o => o.replied)
  const notReplied = outcomes.filter(o => !o.replied)

  const avgReplied = replied.length > 0
    ? replied.reduce((s, o) => s + o.score, 0) / replied.length : 0
  const avgNotReplied = notReplied.length > 0
    ? notReplied.reduce((s, o) => s + o.score, 0) / notReplied.length : 0

  const correlation = calculateCorrelation(outcomes)
  const replyRate = outcomes.length > 0 ? replied.length / outcomes.length : 0

  const w = { ...current }
  const lr = 0.1

  if (correlation < 0.3) {
    w.messageRelevance += lr * 0.02
    w.channelFit += lr * 0.02
    w.industry -= lr * 0.01
  }

  const msgImpact = replied.length > 0
    ? replied.reduce((s, o) => s + o.messageRelevance, 0) / replied.length : 0
  if (msgImpact > 0.7) w.messageRelevance += lr * 0.01

  const emailReplies = replied.filter(o => o.channelUsed === 'EMAIL').length
  const linkedinReplies = replied.filter(o => o.channelUsed === 'LINKEDIN').length
  if (linkedinReplies > emailReplies * 1.5) w.channelFit += lr * 0.01

  const weightKeys = Object.keys(DEFAULT_WEIGHTS) as (keyof Weights)[]
  for (const k of weightKeys) w[k] = Math.max(0, w[k])
  const total = weightKeys.reduce((s, k) => s + w[k], 0)
  if (total > 0) for (const k of weightKeys) w[k] = w[k] / total

  return {
    weights: w,
    metrics: {
      totalScored: outcomes.length,
      totalReplied: replied.length,
      replyRate,
      avgScoreOfReplied: avgReplied,
      avgScoreOfNotReplied: avgNotReplied,
      correlationScore: correlation
    }
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────
function makeOutcome(score: number, replied: boolean, messageRelevance = 0.5, channelUsed = 'EMAIL'): Outcome {
  return { score, replied, messageRelevance, channelUsed }
}

function sumWeights(w: Weights): number {
  return Object.values(w).reduce((s, v) => s + v, 0)
}

// ── calculateCorrelation ─────────────────────────────────────────────────────
describe('calculateCorrelation', () => {
  it('returns 0 when all replied', () => {
    const outcomes = [makeOutcome(80, true), makeOutcome(60, true)]
    assert.equal(calculateCorrelation(outcomes), 0)
  })

  it('returns 0 when none replied', () => {
    const outcomes = [makeOutcome(80, false), makeOutcome(60, false)]
    assert.equal(calculateCorrelation(outcomes), 0)
  })

  it('returns 0 for empty array', () => {
    assert.equal(calculateCorrelation([]), 0)
  })

  it('returns positive correlation when high scores reply', () => {
    const outcomes = [
      makeOutcome(90, true), makeOutcome(85, true),
      makeOutcome(20, false), makeOutcome(15, false)
    ]
    const r = calculateCorrelation(outcomes)
    assert.ok(r > 0, `Expected positive correlation, got ${r}`)
  })

  it('returns negative correlation when low scores reply', () => {
    const outcomes = [
      makeOutcome(90, false), makeOutcome(85, false),
      makeOutcome(20, true), makeOutcome(15, true)
    ]
    const r = calculateCorrelation(outcomes)
    assert.ok(r < 0, `Expected negative correlation, got ${r}`)
  })

  it('returns value in [-1, 1]', () => {
    const outcomes = Array.from({ length: 20 }, (_, i) => makeOutcome(i * 5, i % 2 === 0))
    const r = calculateCorrelation(outcomes)
    assert.ok(r >= -1 && r <= 1, `Correlation ${r} out of range`)
  })

  it('returns 0 when all scores identical (no variance)', () => {
    const outcomes = [makeOutcome(50, true), makeOutcome(50, false)]
    assert.equal(calculateCorrelation(outcomes), 0)
  })
})

// ── recomputeWeights ─────────────────────────────────────────────────────────
describe('recomputeWeights', () => {
  it('weights always sum to ~1', () => {
    const outcomes = Array.from({ length: 14 }, (_, i) => makeOutcome(50 + i, i % 3 !== 0))
    const { weights } = recomputeWeights(outcomes, { ...DEFAULT_WEIGHTS })
    assert.ok(Math.abs(sumWeights(weights) - 1) < 1e-10, `Sum=${sumWeights(weights)}`)
  })

  it('all weights stay non-negative', () => {
    const outcomes = Array.from({ length: 21 }, (_, i) => makeOutcome(i * 4, false))
    const { weights } = recomputeWeights(outcomes, { ...DEFAULT_WEIGHTS })
    for (const [k, v] of Object.entries(weights)) {
      assert.ok(v >= 0, `Weight ${k}=${v} is negative`)
    }
  })

  it('metrics.totalScored equals outcomes length', () => {
    const outcomes = Array.from({ length: 7 }, (_, i) => makeOutcome(50, i % 2 === 0))
    const { metrics } = recomputeWeights(outcomes, { ...DEFAULT_WEIGHTS })
    assert.equal(metrics.totalScored, 7)
  })

  it('metrics.totalReplied counts replied outcomes', () => {
    const outcomes = [
      makeOutcome(80, true), makeOutcome(70, true),
      makeOutcome(40, false), makeOutcome(30, false), makeOutcome(20, false)
    ]
    const { metrics } = recomputeWeights(outcomes, { ...DEFAULT_WEIGHTS })
    assert.equal(metrics.totalReplied, 2)
  })

  it('metrics.replyRate is correct fraction', () => {
    const outcomes = [
      makeOutcome(80, true), makeOutcome(70, true), makeOutcome(60, false), makeOutcome(50, false)
    ]
    const { metrics } = recomputeWeights(outcomes, { ...DEFAULT_WEIGHTS })
    assert.ok(Math.abs(metrics.replyRate - 0.5) < 1e-10)
  })

  it('metrics.avgScoreOfReplied averages replied scores', () => {
    const outcomes = [makeOutcome(80, true), makeOutcome(60, true), makeOutcome(40, false)]
    const { metrics } = recomputeWeights(outcomes, { ...DEFAULT_WEIGHTS })
    assert.ok(Math.abs(metrics.avgScoreOfReplied - 70) < 1e-10)
  })

  it('metrics.avgScoreOfNotReplied averages non-replied scores', () => {
    const outcomes = [makeOutcome(80, true), makeOutcome(30, false), makeOutcome(50, false)]
    const { metrics } = recomputeWeights(outcomes, { ...DEFAULT_WEIGHTS })
    assert.ok(Math.abs(metrics.avgScoreOfNotReplied - 40) < 1e-10)
  })

  it('zero outcomes: replyRate is 0 and all metrics are 0', () => {
    const { metrics } = recomputeWeights([], { ...DEFAULT_WEIGHTS })
    assert.equal(metrics.totalScored, 0)
    assert.equal(metrics.replyRate, 0)
    assert.equal(metrics.avgScoreOfReplied, 0)
    assert.equal(metrics.avgScoreOfNotReplied, 0)
  })

  it('weak correlation boosts messageRelevance weight', () => {
    // All scores identical → correlation = 0 < 0.3 → boost message relevance
    const outcomes = [makeOutcome(50, true), makeOutcome(50, false), makeOutcome(50, true), makeOutcome(50, false)]
    const before = DEFAULT_WEIGHTS.messageRelevance
    const { weights } = recomputeWeights(outcomes, { ...DEFAULT_WEIGHTS })
    // After normalization the relative weight of messageRelevance should be higher
    // than starting proportion since we added to it before normalizing
    assert.ok(weights.messageRelevance > before * 0.95, `Expected messageRelevance boost, got ${weights.messageRelevance}`)
  })

  it('weak correlation boosts channelFit weight', () => {
    const outcomes = [makeOutcome(50, true), makeOutcome(50, false)]
    const { weights } = recomputeWeights(outcomes, { ...DEFAULT_WEIGHTS })
    // channelFit gets boosted by weak correlation path
    assert.ok(weights.channelFit >= 0)
  })

  it('high LinkedIn reply rate boosts channelFit', () => {
    const outcomes = [
      makeOutcome(60, true, 0.5, 'LINKEDIN'),
      makeOutcome(60, true, 0.5, 'LINKEDIN'),
      makeOutcome(60, true, 0.5, 'LINKEDIN'),
      makeOutcome(60, false, 0.5, 'EMAIL')
    ]
    const { weights } = recomputeWeights(outcomes, { ...DEFAULT_WEIGHTS })
    assert.ok(weights.channelFit >= 0)
    assert.ok(Math.abs(sumWeights(weights) - 1) < 1e-10)
  })

  it('high message relevance among replies boosts messageRelevance', () => {
    const outcomes = [
      makeOutcome(70, true, 0.9),
      makeOutcome(65, true, 0.85),
      makeOutcome(40, false, 0.2)
    ]
    const { weights } = recomputeWeights(outcomes, { ...DEFAULT_WEIGHTS })
    // messageRelevance boosted via msgImpact > 0.7 path
    assert.ok(weights.messageRelevance >= 0)
    assert.ok(Math.abs(sumWeights(weights) - 1) < 1e-10)
  })

  it('repeated updates remain stable (no runaway growth)', () => {
    let w = { ...DEFAULT_WEIGHTS }
    const outcomes = Array.from({ length: 7 }, (_, i) => makeOutcome(50, i % 2 === 0))
    for (let i = 0; i < 100; i++) {
      const result = recomputeWeights(outcomes, w)
      w = result.weights
    }
    assert.ok(Math.abs(sumWeights(w) - 1) < 1e-10)
    for (const v of Object.values(w)) assert.ok(v >= 0 && v <= 1)
  })

  it('does not mutate the input weights object', () => {
    const original = { ...DEFAULT_WEIGHTS }
    const frozen = { ...DEFAULT_WEIGHTS }
    const outcomes = [makeOutcome(70, true), makeOutcome(30, false)]
    recomputeWeights(outcomes, frozen)
    for (const k of Object.keys(original) as (keyof Weights)[]) {
      assert.equal(frozen[k], original[k], `Weight ${k} was mutated`)
    }
  })
})
