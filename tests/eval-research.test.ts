import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateResearch, RESEARCH_CASES, type ResearchCase } from '../scripts/eval-research.ts'

// Drive the eval's evaluator with fixtures so its logic is verified without a key
// or the network — the live harness (npm run eval:research) reuses the same fn.
const C: ResearchCase = RESEARCH_CASES[0] // plumbing case; expects "plumb"

const fails = (raw: string) => evaluateResearch(C, raw).filter((f) => f.severity === 'FAIL')
const warns = (raw: string) => evaluateResearch(C, raw).filter((f) => f.severity === 'WARN')

const CLEAN = JSON.stringify({
  aiSummary: 'Acme Plumbing is a growing plumbing service in Brisbane.',
  outreachAngle: 'Coordinating plumbing jobs across crews as you grow',
  evidence: [
    { signal: 'Website lists 4 service areas', type: 'confirmed', confidence: 'high', sourceUrl: 'https://acme.example/services' },
    { signal: 'Likely dispatch complexity', type: 'inferred', confidence: 'low' },
  ],
  riskFlags: ['Team size is estimated'],
  recommendedAction: 'manual_review_then_draft',
  confidence: 'medium',
  icpScore: 75,
})

test('evaluateResearch: a clean evidence-backed response passes (no FAILs)', () => {
  assert.deepEqual(fails(CLEAN), [])
})

test('evaluateResearch: non-JSON fails', () => {
  assert.ok(fails('the model said hi').length === 1)
})

test('evaluateResearch: missing evidence[] fails', () => {
  const raw = JSON.stringify({ aiSummary: 'plumbing co', icpScore: 70, recommendedAction: 'skip' })
  assert.ok(fails(raw).some((f) => /no evidence/.test(f.message)))
})

test('evaluateResearch: a "confirmed" item without a real sourceUrl fails (honesty rule)', () => {
  const raw = JSON.stringify({
    aiSummary: 'plumbing', outreachAngle: 'x', icpScore: 70, recommendedAction: 'skip',
    evidence: [{ signal: 'They are definitely hiring', type: 'confirmed', confidence: 'high' }],
  })
  assert.ok(fails(raw).some((f) => /confirmed.*without a real sourceUrl/.test(f.message)))
})

test('evaluateResearch: invalid type / confidence / recommendedAction all fail', () => {
  const raw = JSON.stringify({
    aiSummary: 'plumbing', outreachAngle: 'x', icpScore: 70, recommendedAction: 'launch_nukes',
    evidence: [{ signal: 's', type: 'rumour', confidence: 'certain' }],
  })
  const msgs = fails(raw).map((f) => f.message).join(' | ')
  assert.match(msgs, /invalid type/)
  assert.match(msgs, /invalid confidence/)
  assert.match(msgs, /invalid recommendedAction/)
})

test('evaluateResearch: banned filler in the summary fails', () => {
  const raw = JSON.stringify({
    aiSummary: 'We help plumbing teams streamline operations.', outreachAngle: 'x', icpScore: 70,
    recommendedAction: 'skip', evidence: [{ signal: 's', type: 'observed', confidence: 'low' }],
  })
  assert.ok(fails(raw).some((f) => /banned filler/.test(f.message)))
})

test('evaluateResearch: auto_draft on an all-inferred assessment fails', () => {
  const raw = JSON.stringify({
    aiSummary: 'plumbing', outreachAngle: 'x', icpScore: 70, recommendedAction: 'auto_draft',
    riskFlags: ['estimated'],
    evidence: [{ signal: 'a', type: 'inferred', confidence: 'low' }, { signal: 'b', type: 'inferred', confidence: 'low' }],
  })
  assert.ok(fails(raw).some((f) => /auto_draft on an all-inferred/.test(f.message)))
})

test('evaluateResearch: inferences without riskFlags warn (not fail)', () => {
  const raw = JSON.stringify({
    aiSummary: 'plumbing', outreachAngle: 'x', icpScore: 70, recommendedAction: 'manual_review_then_draft',
    evidence: [{ signal: 'guess', type: 'inferred', confidence: 'low' }],
  })
  assert.deepEqual(fails(raw), [])
  assert.ok(warns(raw).some((f) => /no riskFlags/.test(f.message)))
})
