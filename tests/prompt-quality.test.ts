// Unit tests for the pure prompt-quality rate math.

import test from 'node:test'
import assert from 'node:assert/strict'
import { computePromptQualityRates } from '../packages/backend-core/src/lib/promptQuality.ts'

test('all approved → approvalRate 1, no rejections or policy review', () => {
  const r = computePromptQualityRates({ APPROVED: 8, SENT: 2 })
  assert.equal(r.total, 10)
  assert.equal(r.approvalRate, 1)
  assert.equal(r.rejectionRate, 0)
  assert.equal(r.policyReviewRate, 0)
})

test('mixed approvals and rejections compute over the reviewed pool', () => {
  // kept = APPROVED(3)+SENT(1)=4, rejected = 6 → reviewed 10.
  const r = computePromptQualityRates({ APPROVED: 3, SENT: 1, REJECTED: 6, DRAFTED: 5 })
  assert.equal(r.approvalRate, 0.4)
  assert.equal(r.rejectionRate, 0.6)
})

test('policy-review rate is over all drafts', () => {
  const r = computePromptQualityRates({ DRAFTED: 6, POLICY_REVIEW: 4 })
  assert.equal(r.total, 10)
  assert.equal(r.policyReviewRate, 0.4)
  // No approve/reject decisions yet → rates are 0 (no reviewed pool).
  assert.equal(r.approvalRate, 0)
})

test('empty / undecided drafts yield zero rates without dividing by zero', () => {
  assert.deepEqual(computePromptQualityRates({}), { total: 0, approvalRate: 0, rejectionRate: 0, policyReviewRate: 0 })
  assert.deepEqual(computePromptQualityRates({ DRAFTED: 5 }), { total: 5, approvalRate: 0, rejectionRate: 0, policyReviewRate: 0 })
})
