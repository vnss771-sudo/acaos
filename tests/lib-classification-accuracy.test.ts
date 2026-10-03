// Unit tests for the reply-classifier accuracy / drift report (pure).

import test from 'node:test'
import assert from 'node:assert/strict'
import { computeClassificationAccuracy, MIN_REVIEWED, type ReviewedReply } from '../packages/backend-core/src/lib/classificationAccuracy.ts'
import { REPLY_STAGE, replyOutcomeFor } from '../packages/backend-core/src/lib/replyGating.ts'

const ok = (predicted: string, confidence = 90): ReviewedReply => ({ predicted, confidence, feedback: 'CORRECT', corrected: null })
const wrong = (predicted: string, corrected: string, confidence = 90): ReviewedReply => ({ predicted, confidence, feedback: 'INCORRECT', corrected })

test(`accuracy is withheld below ${MIN_REVIEWED} decided verdicts, with the reason`, () => {
  const r = computeClassificationAccuracy([ok('INTERESTED'), wrong('NOT_NOW', 'INTERESTED'), { predicted: 'REFERRAL', confidence: 70, feedback: 'UNSURE', corrected: null }], 60)
  assert.equal(r.accuracy, null)
  assert.match(r.withheldReason!, /at least 5 .*\(2 so far\)/)
  assert.equal(r.reviewed, 3)
  assert.equal(r.unsure, 1)
  assert.equal(r.recommendation, null)
})

test('accuracy, per-label errors and the most common mistakes', () => {
  const r = computeClassificationAccuracy([
    ok('INTERESTED'), ok('INTERESTED'), ok('NOT_INTERESTED'), ok('NEEDS_MORE_INFO'),
    wrong('NOT_NOW', 'INTERESTED'), wrong('NOT_NOW', 'INTERESTED'), wrong('NOT_NOW', 'NEEDS_MORE_INFO'),
    ok('NOT_NOW'),
  ], 60)
  assert.equal(r.accuracy, 5 / 8)
  assert.equal(r.withheldReason, null)
  assert.deepEqual(r.labels[0], { label: 'NOT_NOW', reviewed: 4, wrong: 3, topCorrection: { to: 'INTERESTED', count: 2 } })
  assert.deepEqual(r.mistakes[0], { from: 'NOT_NOW', to: 'INTERESTED', count: 2 })
})

test('recommends a higher confidence floor when confident negatives keep being overturned, stating the cost', () => {
  const rows = [
    wrong('NOT_INTERESTED', 'NOT_NOW', 72), wrong('NOT_INTERESTED', 'INTERESTED', 78),
    ok('NOT_INTERESTED', 75), ok('NOT_INTERESTED', 95), ok('INTERESTED'), ok('INTERESTED'),
  ]
  const r = computeClassificationAccuracy(rows, 60)
  assert.deepEqual(r.overturnedNegatives, { count: 2, aboveFloor: 2, floor: 60 })
  assert.match(r.recommendation!, /REPLY_CLASSIFICATION_MIN_CONFIDENCE to 80/)
  assert.match(r.recommendation!, /1 correct "not interested" reply would also have waited/)
})

test('no recommendation when the overturned negatives were already held below the floor', () => {
  const rows = [
    wrong('NOT_INTERESTED', 'NOT_NOW', 40), wrong('NOT_INTERESTED', 'INTERESTED', 50),
    ok('INTERESTED'), ok('INTERESTED'), ok('INTERESTED'),
  ]
  const r = computeClassificationAccuracy(rows, 60)
  assert.equal(r.overturnedNegatives.aboveFloor, 0)
  assert.equal(r.recommendation, null)
})

test('stage and outcome maps match what the analyze-reply worker applies', () => {
  assert.equal(REPLY_STAGE.NOT_INTERESTED, 'DEAD')
  assert.equal(REPLY_STAGE.OUT_OF_OFFICE, 'OUTREACH_SENT')
  assert.deepEqual(replyOutcomeFor('NOT_NOW'), { replied: true, replyIntent: 'NEED_MORE_INFO' })
  assert.deepEqual(replyOutcomeFor('NOT_INTERESTED'), { replied: false, replyIntent: 'NOT_INTERESTED' })
})
