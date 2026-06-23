import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseAiJson,
  parseLeadResearchJson,
  AiSchemaError,
  OutreachDraftOutputSchema,
  ReplyAnalysisOutputSchema,
} from '../packages/backend-core/src/lib/aiSchemas.ts'
import { ApiError } from '../packages/backend-core/src/lib/errors.ts'

// ── parseAiJson: strict, fail-closed validation ───────────────────────────────

test('parseAiJson(outreach): accepts a well-formed draft and returns a typed object', () => {
  const out = parseAiJson(
    OutreachDraftOutputSchema,
    JSON.stringify({ subject: 'quick q on scheduling', email: 'Hi — how are you handling dispatch?', followup: 'Just bumping this.' }),
    'test',
  )
  assert.equal(out.subject, 'quick q on scheduling')
  assert.equal(out.email, 'Hi — how are you handling dispatch?')
  assert.equal(out.followup, 'Just bumping this.')
})

test('parseAiJson(outreach): followup is optional', () => {
  const out = parseAiJson(OutreachDraftOutputSchema, JSON.stringify({ subject: 's', email: 'e' }), 'test')
  assert.equal(out.followup, undefined)
})

test('parseAiJson: throws a typed AiSchemaError (502, AI_SCHEMA_INVALID) on non-JSON', () => {
  assert.throws(
    () => parseAiJson(OutreachDraftOutputSchema, 'not json at all', 'generate-outreach'),
    (err: unknown) => {
      assert.ok(err instanceof AiSchemaError)
      assert.ok(err instanceof ApiError, 'AiSchemaError must extend ApiError for the Express layer')
      assert.equal((err as AiSchemaError).statusCode, 502)
      assert.equal((err as AiSchemaError).operation, 'generate-outreach')
      assert.match((err as AiSchemaError).message, /AI_SCHEMA_INVALID/)
      assert.match((err as AiSchemaError).message, /not valid JSON/i)
      return true
    },
  )
})

test('parseAiJson(outreach): throws when a required field (email) is missing', () => {
  assert.throws(
    () => parseAiJson(OutreachDraftOutputSchema, JSON.stringify({ subject: 'hi' }), 'test'),
    (err: unknown) => err instanceof AiSchemaError && /email/.test((err as AiSchemaError).issues),
  )
})

test('parseAiJson(outreach): throws on an empty required string (min length)', () => {
  assert.throws(
    () => parseAiJson(OutreachDraftOutputSchema, JSON.stringify({ subject: '', email: 'x' }), 'test'),
    (err: unknown) => err instanceof AiSchemaError,
  )
})

test('parseAiJson(outreach): throws when a string exceeds its max length', () => {
  const huge = 'x'.repeat(600) // subject cap is 500
  assert.throws(
    () => parseAiJson(OutreachDraftOutputSchema, JSON.stringify({ subject: huge, email: 'e' }), 'test'),
    (err: unknown) => err instanceof AiSchemaError,
  )
})

test('parseAiJson(reply): accepts a valid classification enum', () => {
  const out = parseAiJson(
    ReplyAnalysisOutputSchema,
    JSON.stringify({ classification: 'INTERESTED', confidence: 88, urgency: 'this_week' }),
    'analyze-reply',
  )
  assert.equal(out.classification, 'INTERESTED')
  assert.equal(out.confidence, 88)
})

test('parseAiJson(reply): throws on an unknown classification value', () => {
  assert.throws(
    () => parseAiJson(ReplyAnalysisOutputSchema, JSON.stringify({ classification: 'VERY_INTERESTED' }), 'analyze-reply'),
    (err: unknown) => err instanceof AiSchemaError && /classification/.test((err as AiSchemaError).issues),
  )
})

test('parseAiJson(reply): throws on an out-of-range confidence', () => {
  assert.throws(
    () => parseAiJson(ReplyAnalysisOutputSchema, JSON.stringify({ classification: 'INTERESTED', confidence: 500 }), 'test'),
    (err: unknown) => err instanceof AiSchemaError,
  )
})

// ── parseLeadResearchJson: lenient, never throws ──────────────────────────────

test('parseLeadResearchJson: parses a complete research object', () => {
  const out = parseLeadResearchJson(
    JSON.stringify({
      aiSummary: 'A growing plumbing firm.',
      outreachAngle: 'dispatch across crews',
      qualificationSignals: ['field workforce', 'hiring'],
      icpScore: 72,
      hiringSignals: true,
      digitalMaturity: 'low',
      estimatedTeamSize: '10-50',
    }),
  )
  assert.equal(out.icpScore, 72)
  assert.equal(out.digitalMaturity, 'low')
  assert.deepEqual(out.qualificationSignals, ['field workforce', 'hiring'])
})

test('parseLeadResearchJson: tolerates non-JSON by returning an empty object', () => {
  const out = parseLeadResearchJson('the model said hello, not JSON')
  assert.deepEqual(out, {})
})

test('parseLeadResearchJson: tolerates a non-object (array) payload', () => {
  assert.deepEqual(parseLeadResearchJson('[1,2,3]'), {})
})

test('parseLeadResearchJson: drops a wrong-typed field but keeps the valid ones', () => {
  // icpScore as a string and digitalMaturity as a bad enum should be dropped,
  // not throw — research is best-effort enrichment.
  const out = parseLeadResearchJson(
    JSON.stringify({ aiSummary: 'ok', icpScore: 'eighty', digitalMaturity: 'enormous' }),
  )
  assert.equal(out.aiSummary, 'ok')
  assert.equal(out.icpScore, undefined)
  assert.equal(out.digitalMaturity, undefined)
})

test('parseLeadResearchJson: drops an out-of-range icpScore', () => {
  const out = parseLeadResearchJson(JSON.stringify({ icpScore: 9999 }))
  assert.equal(out.icpScore, undefined)
})

// ── structured evidence / risk flags / recommended action ─────────────────────

test('parseLeadResearchJson: parses structured evidence, risk flags, and recommended action', () => {
  const out = parseLeadResearchJson(
    JSON.stringify({
      evidence: [
        { signal: 'Website lists 4 service areas', type: 'confirmed', confidence: 'high', sourceUrl: 'https://acme.example/services' },
        { signal: 'Likely dispatch complexity', type: 'inferred', confidence: 'medium' },
      ],
      riskFlags: ['Team size is estimated'],
      recommendedAction: 'manual_review_then_draft',
      confidence: 'medium',
    }),
  )
  assert.equal(out.evidence?.length, 2)
  assert.equal(out.evidence?.[0].type, 'confirmed')
  assert.equal(out.evidence?.[0].sourceUrl, 'https://acme.example/services')
  assert.deepEqual(out.riskFlags, ['Team size is estimated'])
  assert.equal(out.recommendedAction, 'manual_review_then_draft')
  assert.equal(out.confidence, 'medium')
})

test('parseLeadResearchJson: defaults an evidence item to the weakest provenance when type/confidence drift', () => {
  // A real observation with an unknown `type` must degrade to "inferred"/"low",
  // never silently masquerade as a confirmed fact.
  const out = parseLeadResearchJson(
    JSON.stringify({ evidence: [{ signal: 'Active BNI participation', type: 'rumour', confidence: 'certain' }] }),
  )
  assert.equal(out.evidence?.length, 1)
  assert.equal(out.evidence?.[0].type, 'inferred')
  assert.equal(out.evidence?.[0].confidence, 'low')
})

test('parseLeadResearchJson: drops a malformed evidence item but keeps the valid ones', () => {
  const out = parseLeadResearchJson(
    JSON.stringify({
      evidence: [
        { type: 'confirmed', confidence: 'high' }, // no `signal` — must be dropped
        { signal: 'Has a careers page', type: 'observed', confidence: 'medium' },
      ],
    }),
  )
  assert.equal(out.evidence?.length, 1)
  assert.equal(out.evidence?.[0].signal, 'Has a careers page')
})

test('parseLeadResearchJson: drops an invalid recommendedAction enum without throwing', () => {
  const out = parseLeadResearchJson(JSON.stringify({ aiSummary: 'ok', recommendedAction: 'launch_nukes' }))
  assert.equal(out.aiSummary, 'ok')
  assert.equal(out.recommendedAction, undefined)
})
