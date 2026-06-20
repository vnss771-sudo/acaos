// Database-backed behavioral tests for sendCampaignBatch — the most
// safety-critical worker path (SMTP dispatch, suppression, outbox idempotency,
// fail-closed claims, mission-stop). Previously covered only by static
// source-grep gates (operational-chaos-safety-gates.test.ts), which pass even
// when the behavior is broken. These exercise the real logic against a live DB
// with a stubbed mailer (injected via the deps seam) so no real SMTP is needed.

import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { sendCampaignBatch } from '../apps/worker/src/processors.ts'
import { suppress } from '../packages/backend-core/src/lib/suppressions.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace } from './helpers/db.ts'

after(async () => { await disconnect() })
beforeEach(async () => { await resetDb() })

// A mailer stub that records every recipient and (optionally) throws to
// simulate an SMTP rejection. Shape matches services/mail.ts `sendMail`.
function recordingMailer(opts: { throwOn?: (to: string) => boolean } = {}) {
  const sent: string[] = []
  const fn = async (to: string, _subject: string, _html: string) => {
    sent.push(to)
    if (opts.throwOn?.(to)) throw new Error('550 mailbox unavailable')
    return { messageId: `<test-${sent.length}@acaos.test>` }
  }
  return { fn: fn as unknown as typeof import('../packages/backend-core/src/services/mail.ts').sendMail, sent }
}

async function seedCampaign(workspaceId: string) {
  return prisma.campaign.create({
    data: { workspaceId, name: 'Q3 Outreach', goalType: 'BOOK_MEETINGS' },
  })
}

// A lead that is ready to send: has an email, an eligible stage, and a draft
// (so the AI-generation branch is never taken).
async function seedSendableLead(
  workspaceId: string,
  campaignId: string,
  email: string,
) {
  const lead = await prisma.lead.create({
    data: { workspaceId, campaignId, businessName: 'Acme', email, stage: 'RESEARCHED' },
  })
  await prisma.outreachDraft.create({
    data: { leadId: lead.id, workspaceId, subject: 'Hi', emailBody: 'Hello there' },
  })
  return lead
}

async function seedSmtp(workspaceId: string) {
  await prisma.workspaceEmailConfig.create({
    data: { workspaceId, smtpHost: 'smtp.acme.test', smtpFrom: 'sales@acme.test' },
  })
}

test('skips suppressed addresses — never dispatches, never records a send', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await seedSmtp(workspace.id)
  const campaign = await seedCampaign(workspace.id)
  const good = await seedSendableLead(workspace.id, campaign.id, 'reach@buyer.test')
  const blocked = await seedSendableLead(workspace.id, campaign.id, 'stop@buyer.test')
  await suppress(workspace.id, 'stop@buyer.test', 'UNSUBSCRIBED')

  const mailer = recordingMailer()
  const result = await sendCampaignBatch(campaign.id, workspace.id, undefined, undefined, { sendMail: mailer.fn })

  assert.equal(result.sent, 1)
  assert.equal(result.skipped, 1)
  assert.equal(result.failed, 0)
  // The suppressed recipient must never reach the mailer.
  assert.deepEqual(mailer.sent, ['reach@buyer.test'])
  // No OutreachSent row for the suppressed lead; the good one is SENT.
  assert.equal(await prisma.outreachSent.count({ where: { leadId: blocked.id } }), 0)
  const goodSend = await prisma.outreachSent.findFirst({ where: { leadId: good.id } })
  assert.equal(goodSend!.status, 'SENT')
  const goodLead = await prisma.lead.findUnique({ where: { id: good.id } })
  assert.equal(goodLead!.stage, 'OUTREACH_SENT')
})

test('idempotent: a lead already sent for this campaign is not re-sent', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await seedSmtp(workspace.id)
  const campaign = await seedCampaign(workspace.id)
  const lead = await seedSendableLead(workspace.id, campaign.id, 'reach@buyer.test')
  // Pre-existing delivered send for this (campaign, lead).
  await prisma.outreachSent.create({
    data: { workspaceId: workspace.id, campaignId: campaign.id, leadId: lead.id,
      toEmail: 'reach@buyer.test', subject: 'Hi', body: 'x', status: 'SENT' },
  })

  const mailer = recordingMailer()
  const result = await sendCampaignBatch(campaign.id, workspace.id, undefined, undefined, { sendMail: mailer.fn })

  assert.equal(result.sent, 0)
  assert.equal(result.skipped, 1)
  assert.deepEqual(mailer.sent, [], 'no second dispatch for an already-sent lead')
  // Still exactly one send row for the pair (the outbox unique constraint holds).
  assert.equal(await prisma.outreachSent.count({ where: { campaignId: campaign.id, leadId: lead.id } }), 1)
})

test('fail-closed: an SMTP rejection marks the claim FAILED and does not advance the lead', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await seedSmtp(workspace.id)
  const campaign = await seedCampaign(workspace.id)
  const lead = await seedSendableLead(workspace.id, campaign.id, 'reach@buyer.test')

  const mailer = recordingMailer({ throwOn: () => true })
  const result = await sendCampaignBatch(campaign.id, workspace.id, undefined, undefined, { sendMail: mailer.fn })

  assert.equal(result.sent, 0)
  assert.equal(result.failed, 1)
  assert.deepEqual(mailer.sent, ['reach@buyer.test'], 'the send was attempted exactly once')
  // The claim row is retained as FAILED (fail-closed: never auto-resent), with
  // the error recorded for operator review.
  const claim = await prisma.outreachSent.findFirst({ where: { leadId: lead.id } })
  assert.equal(claim!.status, 'FAILED')
  assert.match(claim!.lastError ?? '', /mailbox unavailable/)
  // The lead is NOT advanced — it stays eligible for a deliberate retry.
  const after = await prisma.lead.findUnique({ where: { id: lead.id } })
  assert.equal(after!.stage, 'RESEARCHED')
})

test('mission stop: a PAUSED mission halts the batch before any dispatch', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await seedSmtp(workspace.id)
  const campaign = await seedCampaign(workspace.id)
  await seedSendableLead(workspace.id, campaign.id, 'reach@buyer.test')
  // This campaign is the execution arm of a paused mission.
  await prisma.mission.create({
    data: { workspaceId: workspace.id, name: 'Paused', goalType: 'BOOK_MEETINGS', status: 'PAUSED', campaignId: campaign.id },
  })

  const mailer = recordingMailer()
  const result = await sendCampaignBatch(campaign.id, workspace.id, undefined, undefined, { sendMail: mailer.fn })

  assert.equal(result.sent, 0)
  assert.deepEqual(mailer.sent, [], 'a paused mission must not dispatch anything')
  assert.equal(await prisma.outreachSent.count({ where: { campaignId: campaign.id } }), 0)
})
