import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveResearchAction } from '../packages/backend-core/src/lib/researchGate.ts'

test('empty research downgrades auto_draft → manual_review_then_draft', () => {
  assert.equal(
    resolveResearchAction({ recommendedAction: 'auto_draft', aiSummary: '', evidenceCount: 0 }),
    'manual_review_then_draft',
  )
})

test('empty research with no recommendation still forces manual review (not auto-draft)', () => {
  assert.equal(
    resolveResearchAction({ recommendedAction: null, aiSummary: '   ', evidenceCount: 0 }),
    'manual_review_then_draft',
  )
})

test('a poor-fit skip is never resurrected by the thin-research guard', () => {
  assert.equal(
    resolveResearchAction({ recommendedAction: 'skip', aiSummary: '', evidenceCount: 0 }),
    'skip',
  )
})

test('research with a summary is left as-is (auto_draft preserved)', () => {
  assert.equal(
    resolveResearchAction({ recommendedAction: 'auto_draft', aiSummary: 'Real summary of the business.', evidenceCount: 0 }),
    'auto_draft',
  )
})

test('research with evidence (but no summary) is substantive enough to preserve', () => {
  assert.equal(
    resolveResearchAction({ recommendedAction: 'auto_draft', aiSummary: '', evidenceCount: 3 }),
    'auto_draft',
  )
})

test('null recommendation with substance stays null (normal DRAFTED flow)', () => {
  assert.equal(
    resolveResearchAction({ recommendedAction: null, aiSummary: 'has substance', evidenceCount: 0 }),
    null,
  )
})
