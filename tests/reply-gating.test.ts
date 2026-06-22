// Unit tests for reply-classification confidence gating (pure).

import test from 'node:test'
import assert from 'node:assert/strict'
import { effectiveReplyClassification, replyClassificationMinConfidence } from '../packages/backend-core/src/lib/replyGating.ts'

test('high-confidence NOT_INTERESTED passes through (will mark DEAD)', () => {
  assert.equal(effectiveReplyClassification('NOT_INTERESTED', 90, 60), 'NOT_INTERESTED')
  assert.equal(effectiveReplyClassification('NOT_INTERESTED', 60, 60), 'NOT_INTERESTED', 'at the threshold is sufficient')
})

test('low/absent-confidence NOT_INTERESTED is downgraded to NEEDS_MORE_INFO', () => {
  assert.equal(effectiveReplyClassification('NOT_INTERESTED', 30, 60), 'NEEDS_MORE_INFO')
  assert.equal(effectiveReplyClassification('NOT_INTERESTED', null, 60), 'NEEDS_MORE_INFO', 'absent confidence fails safe')
  assert.equal(effectiveReplyClassification('NOT_INTERESTED', undefined, 60), 'NEEDS_MORE_INFO')
})

test('other classifications are never altered (only NOT_INTERESTED is destructive)', () => {
  for (const c of ['INTERESTED', 'NEEDS_MORE_INFO', 'NOT_NOW', 'REFERRAL', 'OUT_OF_OFFICE']) {
    assert.equal(effectiveReplyClassification(c, 1, 60), c)
  }
})

test('a min-confidence of 0 restores always-act-on-the-label behaviour', () => {
  assert.equal(effectiveReplyClassification('NOT_INTERESTED', 0, 0), 'NOT_INTERESTED')
})

test('replyClassificationMinConfidence defaults to 60 and clamps invalid env', () => {
  const saved = process.env.REPLY_CLASSIFICATION_MIN_CONFIDENCE
  try {
    delete process.env.REPLY_CLASSIFICATION_MIN_CONFIDENCE
    assert.equal(replyClassificationMinConfidence(), 60)
    process.env.REPLY_CLASSIFICATION_MIN_CONFIDENCE = '80'
    assert.equal(replyClassificationMinConfidence(), 80)
    process.env.REPLY_CLASSIFICATION_MIN_CONFIDENCE = '150' // out of range
    assert.equal(replyClassificationMinConfidence(), 60)
    process.env.REPLY_CLASSIFICATION_MIN_CONFIDENCE = 'nope'
    assert.equal(replyClassificationMinConfidence(), 60)
  } finally {
    if (saved === undefined) delete process.env.REPLY_CLASSIFICATION_MIN_CONFIDENCE
    else process.env.REPLY_CLASSIFICATION_MIN_CONFIDENCE = saved
  }
})
