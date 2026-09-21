// Database-backed tests for the per-contact consent enforcement gate in
// sendCampaignBatch (Phase 3 — DPA/CASL consent capture). The gate is DORMANT
// unless COMPLIANCE_GATE_ENABLED is set (same launch-control flag as
// getSendReadiness), and — once enabled — is fail-closed: a workspace whose
// lawful basis is 'consent', or that targets Canadian recipients (CASL), must
// have an on-file ConsentRecord for a lead's exact email before it is sent to.

import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { sendCampaignBatch } from '../apps/worker/src/processors.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace } from './helpers/db.ts'

after(async () => { await disconnect() })
beforeEach(async () => { await resetDb() })

function recordingMailer() {
  const sent: string[] = []
  const fn = async (to: string, _subject: string, _html: string) => {
    sent.push(to)
    return { messageId: `<test-${sent.length}@acaos.test>` }
  }
  return { fn: fn as unknown as typeof import('../packages/backend-core/src/services/mail.ts').sendMail, sent }
}

async function seedCampaign(workspaceId: string) {
  return prisma.campaign.create({ data: { workspaceId, name: 'Q3 Outreach', goalType: 'BOOK_MEETINGS' } })
}

async function seedSendableLead(workspaceId: string, campaignId: string, email: string) {
  const lead = await prisma.lead.create({
    data: { workspaceId, campaignId, businessName: 'Acme', email, stage: 'RESEARCHED' },
  })
  await prisma.outreachDraft.create({ data: { leadId: lead.id, workspaceId, subject: 'Hi', emailBody: 'Hello there' } })
  return lead
}

async function seedSmtp(workspaceId: string) {
  await prisma.workspaceEmailConfig.create({ data: { workspaceId, smtpHost: 'smtp.acme.test', smtpFrom: 'sales@acme.test' } })
}

// Every test flips COMPLIANCE_GATE_ENABLED explicitly and restores it — other
// suites (e.g. tests-db/compliance.test.ts) assume it's unset by default.
async function withGateEnabled<T>(fn: () => Promise<T>): Promise<T> {
  const saved = process.env.COMPLIANCE_GATE_ENABLED
  process.env.COMPLIANCE_GATE_ENABLED = 'true'
  try { return await fn() } finally {
    if (saved === undefined) delete process.env.COMPLIANCE_GATE_ENABLED
    else process.env.COMPLIANCE_GATE_ENABLED = saved
  }
}

test('gate OFF (default): a consent-basis workspace still sends without any ConsentRecord', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await seedSmtp(workspace.id)
  await prisma.workspace.update({ where: { id: workspace.id }, data: { lawfulBasis: 'consent' } })
  const campaign = await seedCampaign(workspace.id)
  await seedSendableLead(workspace.id, campaign.id, 'reach@buyer.test')

  const mailer = recordingMailer()
  const result = await sendCampaignBatch(campaign.id, workspace.id, undefined, undefined, { sendMail: mailer.fn })

  assert.equal(result.sent, 1, 'the gate ships dormant — no behavior change until COMPLIANCE_GATE_ENABLED is set')
  assert.equal(result.skippedByReason.CONSENT_REQUIRED, 0)
})

test('gate ON + lawfulBasis=consent: a lead with no ConsentRecord is skipped, never dispatched (fail-closed)', async () => {
  await withGateEnabled(async () => {
    const { workspace } = await seedUserWithWorkspace()
    await seedSmtp(workspace.id)
    await prisma.workspace.update({ where: { id: workspace.id }, data: { lawfulBasis: 'consent' } })
    const campaign = await seedCampaign(workspace.id)
    const lead = await seedSendableLead(workspace.id, campaign.id, 'no-consent@buyer.test')

    const mailer = recordingMailer()
    const result = await sendCampaignBatch(campaign.id, workspace.id, undefined, undefined, { sendMail: mailer.fn })

    assert.equal(result.sent, 0)
    assert.equal(result.skipped, 1)
    assert.equal(result.skippedByReason.CONSENT_REQUIRED, 1)
    assert.deepEqual(mailer.sent, [], 'the recipient must never reach the mailer without a consent record')
    assert.equal(await prisma.outreachSent.count({ where: { leadId: lead.id } }), 0, 'no outbox row is created for a blocked send')
    // The skip is audited — an operator/SAR trail exists for why this lead was withheld.
    const audit = await prisma.auditEvent.findFirst({ where: { workspaceId: workspace.id, type: 'consent.enforcement.skipped', entityId: lead.id } })
    assert.ok(audit, 'a consent.enforcement.skipped audit event is recorded')
    assert.equal((audit!.metadata as { reason?: string } | null)?.reason, 'lawful_basis_consent')
  })
})

test('gate ON + lawfulBasis=consent: a lead WITH a matching ConsentRecord sends normally', async () => {
  await withGateEnabled(async () => {
    const { workspace } = await seedUserWithWorkspace()
    await seedSmtp(workspace.id)
    await prisma.workspace.update({ where: { id: workspace.id }, data: { lawfulBasis: 'consent' } })
    const campaign = await seedCampaign(workspace.id)
    const lead = await seedSendableLead(workspace.id, campaign.id, 'Consented@Buyer.TEST')
    await prisma.consentRecord.create({
      data: { workspaceId: workspace.id, emailKey: 'consented@buyer.test', basis: 'express_consent', source: 'manual' },
    })

    const mailer = recordingMailer()
    const result = await sendCampaignBatch(campaign.id, workspace.id, undefined, undefined, { sendMail: mailer.fn })

    assert.equal(result.sent, 1, 'normalized emailKey match allows the send despite mixed-case input')
    assert.deepEqual(mailer.sent, ['Consented@Buyer.TEST'])
    assert.equal((await prisma.outreachSent.findFirst({ where: { leadId: lead.id } }))!.status, 'SENT')
  })
})

test('gate ON + lawfulBasis=legitimate_interest: no per-contact consent required (not a consent-basis workspace)', async () => {
  await withGateEnabled(async () => {
    const { workspace } = await seedUserWithWorkspace()
    await seedSmtp(workspace.id)
    await prisma.workspace.update({ where: { id: workspace.id }, data: { lawfulBasis: 'legitimate_interest' } })
    const campaign = await seedCampaign(workspace.id)
    await seedSendableLead(workspace.id, campaign.id, 'reach@buyer.test')

    const mailer = recordingMailer()
    const result = await sendCampaignBatch(campaign.id, workspace.id, undefined, undefined, { sendMail: mailer.fn })

    assert.equal(result.sent, 1, 'legitimate interest does not require a per-contact ConsentRecord')
    assert.equal(result.skippedByReason.CONSENT_REQUIRED, 0)
  })
})

test('gate ON + targetsCanada: CASL requires a ConsentRecord per recipient, not just one on file workspace-wide', async () => {
  await withGateEnabled(async () => {
    const { workspace } = await seedUserWithWorkspace()
    await seedSmtp(workspace.id)
    await prisma.workspace.update({ where: { id: workspace.id }, data: { targetsCanada: true } })
    const campaign = await seedCampaign(workspace.id)
    const consented = await seedSendableLead(workspace.id, campaign.id, 'ca-consented@buyer.test')
    const notConsented = await seedSendableLead(workspace.id, campaign.id, 'ca-no-consent@buyer.test')
    // Only ONE of the two recipients has a matching record — the workspace-level
    // getSendReadiness check (consentCount > 0) would already be satisfied here,
    // but the per-contact gate must still block the other recipient.
    await prisma.consentRecord.create({
      data: { workspaceId: workspace.id, emailKey: 'ca-consented@buyer.test', basis: 'implied_consent', source: 'import' },
    })

    const mailer = recordingMailer()
    const result = await sendCampaignBatch(campaign.id, workspace.id, undefined, undefined, { sendMail: mailer.fn })

    assert.equal(result.sent, 1)
    assert.equal(result.skippedByReason.CONSENT_REQUIRED, 1)
    assert.deepEqual(mailer.sent, ['ca-consented@buyer.test'])
    assert.equal(await prisma.outreachSent.count({ where: { leadId: consented.id, status: 'SENT' } }), 1)
    assert.equal(await prisma.outreachSent.count({ where: { leadId: notConsented.id } }), 0)
  })
})
