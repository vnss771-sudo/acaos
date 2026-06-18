import test from 'node:test'
import assert from 'node:assert/strict'
import {
  hasValidEvidence,
  evidenceGatedPriority,
  AUTO_RECOMMEND_THRESHOLD,
  HIGH_CONFIDENCE_PRIORITY,
} from '../packages/backend-core/src/lib/recommendationPolicy.ts'

const fresh = () => new Date()
const ancient = () => new Date(Date.now() - 800 * 86_400_000) // ~2+ years → EXPIRED for any type

test('hasValidEvidence: true only for a fresh, evidence-backed signal', () => {
  assert.equal(hasValidEvidence([{ type: 'HIRING', detectedAt: fresh(), evidenceSourceId: 'ev1' }]), true)
  // No evidence source → not valid (evidence-first).
  assert.equal(hasValidEvidence([{ type: 'HIRING', detectedAt: fresh(), evidenceSourceId: null }]), false)
  // Evidence but expired → not valid.
  assert.equal(hasValidEvidence([{ type: 'WEBSITE_CHANGE', detectedAt: ancient(), evidenceSourceId: 'ev1' }]), false)
  assert.equal(hasValidEvidence([]), false)
})

test('evidenceGatedPriority: caps high priority below the line without valid evidence', () => {
  const noEvidence = [{ type: 'HIRING' as const, detectedAt: fresh(), evidenceSourceId: null }]
  assert.equal(evidenceGatedPriority(90, noEvidence), HIGH_CONFIDENCE_PRIORITY - 1)
  assert.equal(evidenceGatedPriority(70, noEvidence), HIGH_CONFIDENCE_PRIORITY - 1)
})

test('evidenceGatedPriority: leaves high priority intact with valid evidence', () => {
  const withEvidence = [{ type: 'FUNDING' as const, detectedAt: fresh(), evidenceSourceId: 'ev1' }]
  assert.equal(evidenceGatedPriority(90, withEvidence), 90)
})

test('evidenceGatedPriority: never touches sub-threshold priorities', () => {
  assert.equal(evidenceGatedPriority(50, []), 50)
  assert.equal(evidenceGatedPriority(69, []), 69)
})

test('thresholds are sane', () => {
  assert.equal(AUTO_RECOMMEND_THRESHOLD, 70)
  assert.equal(HIGH_CONFIDENCE_PRIORITY, 70)
})
