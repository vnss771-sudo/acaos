import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveOutreachGate, SKIPPED_POOR_FIT_REASON } from '../packages/backend-core/src/lib/outreachGate.ts'

test('skip → suppress generation with a poor-fit reason', () => {
  const d = resolveOutreachGate({ recommendedAction: 'skip' })
  assert.equal(d.generate, false)
  assert.equal(d.generate === false && d.skipReason, SKIPPED_POOR_FIT_REASON)
})

test('skip + override → generate but force POLICY_REVIEW (never auto-send a thin lead)', () => {
  const d = resolveOutreachGate({ recommendedAction: 'skip', override: true })
  assert.equal(d.generate, true)
  assert.equal(d.generate === true && d.draftStatus, 'POLICY_REVIEW')
})

test('manual_review_then_draft → generate into POLICY_REVIEW', () => {
  const d = resolveOutreachGate({ recommendedAction: 'manual_review_then_draft' })
  assert.equal(d.generate, true)
  assert.equal(d.generate === true && d.draftStatus, 'POLICY_REVIEW')
})

test('auto_draft → normal DRAFTED flow', () => {
  const d = resolveOutreachGate({ recommendedAction: 'auto_draft' })
  assert.equal(d.generate, true)
  assert.equal(d.generate === true && d.draftStatus, 'DRAFTED')
})

test('no recommendation (never researched) → normal DRAFTED flow', () => {
  for (const recommendedAction of [undefined, null, '']) {
    const d = resolveOutreachGate({ recommendedAction })
    assert.equal(d.generate, true)
    assert.equal(d.generate === true && d.draftStatus, 'DRAFTED')
  }
})

test('override forces review even for an auto_draft lead (human asked to double-check)', () => {
  const d = resolveOutreachGate({ recommendedAction: 'auto_draft', override: true })
  assert.equal(d.generate === true && d.draftStatus, 'POLICY_REVIEW')
})

test('the gate is tighten-only — it never returns APPROVED/auto-send', () => {
  const statuses = (['skip', 'manual_review_then_draft', 'auto_draft', undefined] as const).map((a) => {
    const d = resolveOutreachGate({ recommendedAction: a })
    return d.generate ? d.draftStatus : 'SUPPRESSED'
  })
  // Only DRAFTED / POLICY_REVIEW / SUPPRESSED are ever produced — nothing that bypasses approval.
  assert.ok(statuses.every((s) => ['DRAFTED', 'POLICY_REVIEW', 'SUPPRESSED'].includes(s)))
})
