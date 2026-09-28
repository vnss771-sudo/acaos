// Timing fit — "why now?" (lib/timingFit.ts) and its use in scoring + learning.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeTimingFit, DEFAULT_TIMING_FIT, TIMING_FIT_VERSION } from '../packages/backend-core/src/lib/timingFit.ts'
import { explainLeadScore, recomputeScoringWeights, DEFAULT_SCORING_WEIGHTS } from '../packages/backend-core/src/lib/scoring.ts'

const NOW = new Date('2026-10-01T00:00:00Z')
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000)
const ev = (text: string, days: number) => ({ text, observedAt: ago(days) })

test('no dated trigger → neutral 0.5 ("timing unknown"), not a fabricated value', () => {
  for (const evidence of [[], [ev('Family-owned plumbing business since 1998', 2)]]) {
    const r = computeTimingFit(evidence, NOW)
    assert.equal(r.score, DEFAULT_TIMING_FIT)
    assert.equal(r.components, null)
    assert.match(r.reasons[0], /Timing unknown/)
  }
})

test('fresher triggers score higher: same trigger today > 30 days > 180 days', () => {
  const s = (d: number) => computeTimingFit([ev('Awarded a council tender for road works', d)], NOW).score
  assert.ok(s(0) > s(30) && s(30) > s(180), `${s(0)} ${s(30)} ${s(180)}`)
  assert.equal(computeTimingFit([ev('awarded a tender', 30)], NOW).components!.recency, 0.5, '30-day half-life')
})

test('buying stage: tender outranks hiring at the same age; momentum rewards several triggers', () => {
  const tender = computeTimingFit([ev('won the contract for a new depot', 5)], NOW)
  const hiring = computeTimingFit([ev('hiring two apprentices', 5)], NOW)
  assert.ok(tender.components!.stage > hiring.components!.stage)
  const both = computeTimingFit([ev('hiring welders', 5), ev('raised funding', 10)], NOW)
  assert.equal(both.components!.momentum, 1)
  assert.equal(hiring.components!.momentum, 0.5)
})

test('stale-only triggers get no stage/momentum credit (older than 90 days)', () => {
  const r = computeTimingFit([ev('hiring staff', 200)], NOW)
  assert.equal(r.components!.stage, 0)
  assert.equal(r.components!.momentum, 0)
  assert.ok(r.score < DEFAULT_TIMING_FIT, 'stale evidence reads worse than unknown')
})

test('explainable, versioned, deterministic, bounded; future-dated evidence is clamped', () => {
  const input = [ev('hiring welders', 3), ev('expanding to a new site', 12)]
  const a = computeTimingFit(input, NOW)
  assert.deepEqual(a, computeTimingFit(input, NOW))
  assert.equal(a.version, TIMING_FIT_VERSION)
  assert.ok(a.reasons.every(r => /^\+\d+ /.test(r)))
  assert.ok(a.score >= 0 && a.score <= 1)
  assert.equal(computeTimingFit([ev('hiring', -10)], NOW).components!.recency, 1)
})

test('the lead score uses real timing when evidence exists, neutral otherwise', () => {
  const base = { businessName: 'X', category: null, email: null, contactName: null, website: null }
  const fresh = explainLeadScore({ ...base, timingEvidence: [ev('awarded a tender', 1)], scoredAt: NOW } as never)
  const none = explainLeadScore(base as never)
  assert.ok(fresh.signals.timingFit > 0.5)
  assert.equal(none.signals.timingFit, 0.5)
})

test('learning: constant timing is never learned; varying, reply-correlated timing is (bounded)', () => {
  const mk = (i: number, timing: number | null) => ({ score: 50, replied: i % 2 === 0, messageRelevance: 0.5, channelUsed: 'EMAIL', timingFit: timing })
  const constant = Array.from({ length: 60 }, (_, i) => mk(i, 0.5))
  assert.deepEqual(recomputeScoringWeights(constant, { ...DEFAULT_SCORING_WEIGHTS }).adjustedFeatures, [])
  const legacy = Array.from({ length: 60 }, (_, i) => mk(i, null))
  assert.deepEqual(recomputeScoringWeights(legacy, { ...DEFAULT_SCORING_WEIGHTS }).adjustedFeatures, [], 'unknown timing is not evidence')
  const varying = Array.from({ length: 60 }, (_, i) => mk(i, i % 2 === 0 ? 0.9 : 0.2))
  const r = recomputeScoringWeights(varying, { ...DEFAULT_SCORING_WEIGHTS })
  assert.deepEqual(r.adjustedFeatures, ['timingFit'])
  assert.ok(r.weights.timingFit > DEFAULT_SCORING_WEIGHTS.timingFit)
})

test('post-deploy mix: legacy outcomes without timing must not create spurious variance', () => {
  // Older (pre-timing) outcomes all replied; newer ones, all at neutral timing,
  // did not. If "unknown" were read as 0 instead of neutral, timing would
  // falsely "predict" replies purely by deploy date.
  const legacy = Array.from({ length: 30 }, () => ({ score: 50, replied: true, messageRelevance: 0.5, channelUsed: 'EMAIL', timingFit: null }))
  const fresh = Array.from({ length: 30 }, () => ({ score: 50, replied: false, messageRelevance: 0.5, channelUsed: 'EMAIL', timingFit: 0.5 }))
  assert.deepEqual(recomputeScoringWeights([...legacy, ...fresh], { ...DEFAULT_SCORING_WEIGHTS }).adjustedFeatures, [])
})
