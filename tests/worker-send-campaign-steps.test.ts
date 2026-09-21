// Unit tests for the pure per-lead decision helpers extracted out of
// sendCampaignBatch (apps/worker/src/processors.ts). Before that extraction
// this logic was only reachable through a full DB-tier integration test;
// these run with no database and no network.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveDraftSource,
  collectDraftViolations,
  isUniqueConstraintViolation,
} from '../apps/worker/src/processors.ts'

// ── resolveDraftSource ──────────────────────────────────────────────────────

test('resolveDraftSource: reuses an existing draft when one is present, regardless of approval mode', () => {
  const lead = { id: 'lead-1', outreachDrafts: [{ subject: 'Hi there', emailBody: 'Body copy' }] }
  const decision = resolveDraftSource(lead, { approvalRequired: true, policyReviewLeadIds: new Set() })
  assert.deepEqual(decision, { action: 'reuse', subject: 'Hi there', body: 'Body copy' })
})

test('resolveDraftSource: skips POLICY_REVIEW leads without regenerating, even outside approval mode', () => {
  const lead = { id: 'lead-2', outreachDrafts: [] }
  const decision = resolveDraftSource(lead, { approvalRequired: false, policyReviewLeadIds: new Set(['lead-2']) })
  assert.deepEqual(decision, { action: 'skip', reason: 'POLICY_REVIEW' })
})

test('resolveDraftSource: POLICY_REVIEW is checked before the approval-required gate', () => {
  const lead = { id: 'lead-3', outreachDrafts: [] }
  const decision = resolveDraftSource(lead, { approvalRequired: true, policyReviewLeadIds: new Set(['lead-3']) })
  assert.deepEqual(decision, { action: 'skip', reason: 'POLICY_REVIEW' })
})

test('resolveDraftSource: no draft + approval required + nothing approved -> NO_APPROVED_DRAFT', () => {
  const lead = { id: 'lead-4', outreachDrafts: [] }
  const decision = resolveDraftSource(lead, { approvalRequired: true, policyReviewLeadIds: new Set() })
  assert.deepEqual(decision, { action: 'skip', reason: 'NO_APPROVED_DRAFT' })
})

test('resolveDraftSource: no draft + approval not required -> generate', () => {
  const lead = { id: 'lead-5', outreachDrafts: [] }
  const decision = resolveDraftSource(lead, { approvalRequired: false, policyReviewLeadIds: new Set() })
  assert.deepEqual(decision, { action: 'generate' })
})

// ── collectDraftViolations ──────────────────────────────────────────────────

test('collectDraftViolations: a clean, well-formed draft has no violations', () => {
  const violations = collectDraftViolations(
    { subject: 'Quick question about your dispatch process', body: 'Hi Alex, saw ACME is expanding into commercial HVAC — wanted to see if faster crew scheduling would help. Worth a quick chat?', followup: null },
    { text: 'ACME Field Services HVAC commercial expansion', hasPriorConnection: false },
    undefined,
  )
  assert.deepEqual(violations, [])
})

test('collectDraftViolations: a block-severity tone violation is mapped to a TONE_ code, not thrown', () => {
  const violations = collectDraftViolations(
    { subject: 'Quick question about your dispatch process', body: "Hi — I noticed you're struggling with dispatch across your crews. Worth a quick chat?", followup: null },
    { text: 'ACME Field Services', hasPriorConnection: false },
    undefined,
  )
  assert.ok(violations.some((v) => v.code === 'TONE_PRESUMPTUOUS_CLAIM'), `expected a TONE_ violation, got: ${JSON.stringify(violations)}`)
})

test('collectDraftViolations: a fabricated prior-contact claim is flagged when the lead has no recorded connection', () => {
  const violations = collectDraftViolations(
    { subject: 'Following up on our chat', body: 'As we discussed last week, I wanted to follow up on next steps for your team.', followup: null },
    { text: 'ACME Field Services', hasPriorConnection: false },
    undefined,
  )
  assert.ok(violations.some((v) => v.code === 'FABRICATED_PRIOR_CONTACT'), `expected FABRICATED_PRIOR_CONTACT, got: ${JSON.stringify(violations)}`)
})

test('collectDraftViolations: the same prior-contact phrasing is allowed when the lead has a recorded connection', () => {
  const violations = collectDraftViolations(
    { subject: 'Following up on our chat', body: 'As we discussed last week, I wanted to follow up on next steps for your team.', followup: null },
    { text: 'ACME Field Services', hasPriorConnection: true },
    undefined,
  )
  assert.ok(!violations.some((v) => v.code === 'FABRICATED_PRIOR_CONTACT'))
})

test('collectDraftViolations: a too-short subject trips the workspace draft policy', () => {
  const violations = collectDraftViolations(
    { subject: 'Hi', body: 'A perfectly reasonable, long-enough body of outreach copy about scheduling software for field crews.', followup: null },
    { text: 'ACME Field Services', hasPriorConnection: false },
    undefined,
  )
  assert.ok(violations.some((v) => v.code === 'SUBJECT_TOO_SHORT'), `expected SUBJECT_TOO_SHORT, got: ${JSON.stringify(violations)}`)
})

test('collectDraftViolations: honors a custom draftPolicy override (forbidden phrase)', () => {
  const violations = collectDraftViolations(
    { subject: 'Quick question about scheduling', body: 'This is a great way to boost your roi with less admin overhead for field crews.', followup: null },
    { text: 'ACME Field Services', hasPriorConnection: false },
    { forbiddenPhrases: ['boost your roi'] },
  )
  assert.ok(violations.some((v) => v.code === 'FORBIDDEN_PHRASE'), `expected a FORBIDDEN_PHRASE violation, got: ${JSON.stringify(violations)}`)
})

test('collectDraftViolations: violations combine policy + grounding + tone in one array', () => {
  const violations = collectDraftViolations(
    { subject: 'Hi', body: "As we discussed, I noticed you're clearly struggling with dispatch.", followup: null },
    { text: 'ACME Field Services', hasPriorConnection: false },
    undefined,
  )
  const codes = violations.map((v) => v.code)
  assert.ok(codes.includes('SUBJECT_TOO_SHORT'), `codes: ${codes}`)
  assert.ok(codes.includes('FABRICATED_PRIOR_CONTACT'), `codes: ${codes}`)
  assert.ok(codes.some((c) => c.startsWith('TONE_')), `codes: ${codes}`)
})

// ── isUniqueConstraintViolation ─────────────────────────────────────────────

test('isUniqueConstraintViolation: true for a Prisma P2002 error object', () => {
  assert.equal(isUniqueConstraintViolation({ code: 'P2002' }), true)
})

test('isUniqueConstraintViolation: false for a different Prisma error code', () => {
  assert.equal(isUniqueConstraintViolation({ code: 'P2025' }), false)
})

test('isUniqueConstraintViolation: false for a plain Error, null, or a primitive', () => {
  assert.equal(isUniqueConstraintViolation(new Error('boom')), false)
  assert.equal(isUniqueConstraintViolation(null), false)
  assert.equal(isUniqueConstraintViolation(undefined), false)
  assert.equal(isUniqueConstraintViolation('P2002'), false)
})
