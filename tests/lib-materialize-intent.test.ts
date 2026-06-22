import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createFakePrisma, installPrisma, resetPrisma } from './helpers/integration.ts'
import { materializeOutreachIntent } from '../apps/api/src/lib/materializeIntent.ts'

afterEach(() => resetPrisma())

test('materialize creates default campaign + lead + APPROVED draft and links the intent', async () => {
  const fake = createFakePrisma({
    campaign: { findFirst: async () => null, create: async () => ({ id: 'camp1' }) },
    lead: { findFirst: async () => null, create: async () => ({ id: 'lead1' }) },
    outreachDraft: { create: async (a: any) => ({ id: 'draft1', ...a.data }) },
    outreachIntent: { update: async (a: any) => ({ id: 'oi1', ...a.data }) },
  })
  installPrisma(fake)

  const out = await materializeOutreachIntent({
    intent: { id: 'oi1', workspaceId: 'w', status: 'APPROVED', leadId: null, draftSubject: 'S', draftBody: 'B', draftFollowup: 'F' },
    prospect: { companyName: 'Acme Plumbing', contactEmail: 'c@acme.test', contactName: 'C', domain: 'acme.test', location: 'Brisbane', industry: 'Plumbing' },
  })

  assert.deepEqual(out, { leadId: 'lead1', campaignId: 'camp1', draftId: 'draft1' })
  assert.equal(fake.callsTo('outreachDraft', 'create')[0].args[0].data.status, 'APPROVED')
  assert.equal(fake.callsTo('lead', 'create')[0].args[0].data.businessName, 'Acme Plumbing')
  const upd = fake.callsTo('outreachIntent', 'update')[0].args[0].data
  assert.equal(upd.leadId, 'lead1')
  assert.equal(upd.campaignId, 'camp1')
})

test('materialize reuses a provided campaign and an existing lead by email', async () => {
  const fake = createFakePrisma({
    lead: { findFirst: async () => ({ id: 'existing-lead' }), update: async () => ({ id: 'existing-lead' }) },
    outreachDraft: { create: async () => ({ id: 'd' }) },
    outreachIntent: { update: async () => ({}) },
  })
  installPrisma(fake)

  const out = await materializeOutreachIntent({
    intent: { id: 'oi1', workspaceId: 'w', status: 'APPROVED', leadId: null, draftSubject: 'S', draftBody: 'B', draftFollowup: null },
    prospect: { companyName: 'X', contactEmail: 'c@x.test', contactName: null, domain: null, location: null, industry: null },
    campaignId: 'provided-camp',
  })

  assert.equal(out.campaignId, 'provided-camp')
  assert.equal(out.leadId, 'existing-lead')
  assert.equal(fake.callsTo('lead', 'update').length, 1)
  assert.equal(fake.callsTo('lead', 'create').length, 0)
})

test('materialize refuses a non-APPROVED intent (defense-in-depth invariant)', async () => {
  // No prisma calls should happen — the guard throws before any write.
  const fake = createFakePrisma({
    campaign: { findFirst: async () => { throw new Error('should not be reached') } },
    outreachDraft: { create: async () => { throw new Error('should not be reached') } },
  })
  installPrisma(fake)

  for (const status of ['PROPOSED', 'DRAFTED', 'REJECTED', 'SENT']) {
    await assert.rejects(
      () => materializeOutreachIntent({
        intent: { id: 'oi1', workspaceId: 'w', status, leadId: null, draftSubject: 'S', draftBody: 'B', draftFollowup: null },
        prospect: { companyName: 'X', contactEmail: 'c@x.test', contactName: null, domain: null, location: null, industry: null },
      }),
      (err: any) => err.statusCode === 409 && /not APPROVED/.test(err.message),
      `status ${status} must be rejected`,
    )
  }
  assert.equal(fake.callsTo('outreachDraft', 'create').length, 0, 'no draft is created for a non-APPROVED intent')
})
