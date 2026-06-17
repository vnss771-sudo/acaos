import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createFakePrisma, installPrisma, resetPrisma } from './helpers/integration.ts'
import { buildEvidenceSnapshot, createOutreachIntentForRecommendation } from '../apps/api/src/lib/outreachIntent.ts'

afterEach(() => resetPrisma())

test('buildEvidenceSnapshot captures signals with freshness + evidence flag', () => {
  const snap = buildEvidenceSnapshot([
    { type: 'HIRING', detectedAt: new Date(), title: '3 roles', source: 'apollo', evidenceSourceId: 'ev1' },
    { type: 'FUNDING', detectedAt: new Date(), evidenceSourceId: null },
  ])
  assert.equal(snap.signalCount, 2)
  assert.equal(snap.signals[0].hasEvidence, true)
  assert.equal(snap.signals[1].hasEvidence, false)
  assert.ok(snap.signals[0].freshness)
  assert.ok(snap.capturedAt)
})

test('createOutreachIntentForRecommendation writes a PROPOSED intent with snapshot', async () => {
  const fake = createFakePrisma({ outreachIntent: { create: async (a: any) => ({ id: 'oi1', ...a.data }) } })
  installPrisma(fake)

  const intent = await createOutreachIntentForRecommendation({
    workspaceId: 'w', prospectId: 'p', recommendationId: 'r1',
    messageAngle: 'scheduling', channel: 'EMAIL',
    signals: [{ type: 'HIRING', detectedAt: new Date(), evidenceSourceId: 'ev1' }],
  })

  const arg = fake.callsTo('outreachIntent', 'create')[0].args[0] as any
  assert.equal(arg.data.status, 'PROPOSED')
  assert.equal(arg.data.recommendationId, 'r1')
  assert.equal(arg.data.messageAngle, 'scheduling')
  assert.equal(arg.data.evidenceSnapshot.signalCount, 1)
  assert.equal((intent as any).status, 'PROPOSED')
})

import { buildIntentDraftInput } from '../apps/api/src/lib/outreachIntent.ts'

test('buildIntentDraftInput maps evidence context; intent angle wins over recommendation', () => {
  const input = buildIntentDraftInput({
    prospect: { companyName: 'Acme Plumbing', industry: 'Plumbing', contactName: 'Mark Lee', location: 'Brisbane' },
    recommendation: { reasoning: 'Hiring + new depot', messageAngle: 'rec angle' },
    intent: { messageAngle: 'scheduling across crews' },
    icp: { targetIndustries: ['Plumbing'], outreachTone: 'direct' },
  })
  assert.equal(input.businessName, 'Acme Plumbing')
  assert.equal(input.category, 'Plumbing')
  assert.equal(input.contactName, 'Mark Lee')
  assert.equal(input.city, 'Brisbane')
  assert.equal(input.aiSummary, 'Hiring + new depot')
  assert.equal(input.outreachAngle, 'scheduling across crews')
})

test('buildIntentDraftInput falls back to recommendation angle when intent has none', () => {
  const input = buildIntentDraftInput({ prospect: { companyName: 'X' }, recommendation: { messageAngle: 'rec angle' }, intent: {} })
  assert.equal(input.outreachAngle, 'rec angle')
})
