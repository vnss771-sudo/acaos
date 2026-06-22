// DB-tier tests for the CampaignDailyStats read-model: live SENT increment via the
// worker send path, and full rebuild from the ContactEvent ledger.

import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { sendCampaignBatch } from '../apps/worker/src/processors.ts'
import { rebuildCampaignStats, utcDayStart, incrementCampaignDailyStats } from '../packages/backend-core/src/lib/campaignStats.ts'
import { recordContactEvent } from '../packages/backend-core/src/lib/contactEvents.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace } from './helpers/db.ts'

after(async () => { await disconnect() })
beforeEach(async () => { await resetDb() })

function recordingMailer() {
  const sent: string[] = []
  const fn = (async (to: string) => { sent.push(to); return { messageId: `<${sent.length}@t>` } }) as unknown as typeof import('../packages/backend-core/src/services/mail.ts').sendMail
  return { fn, sent }
}
async function seedSendableLead(workspaceId: string, campaignId: string, email: string) {
  const lead = await prisma.lead.create({ data: { workspaceId, campaignId, businessName: 'Acme', email, stage: 'RESEARCHED' } })
  await prisma.outreachDraft.create({ data: { leadId: lead.id, workspaceId, subject: 'Hi', emailBody: 'Hello there' } })
  return lead
}

test('a successful send increments CampaignDailyStats.sent for today', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await prisma.workspaceEmailConfig.create({ data: { workspaceId: workspace.id, smtpHost: 'smtp.t', smtpFrom: 's@t' } })
  const campaign = await prisma.campaign.create({ data: { workspaceId: workspace.id, name: 'C', goalType: 'BOOK_MEETINGS' } })
  await seedSendableLead(workspace.id, campaign.id, 'a@buyer.test')
  await seedSendableLead(workspace.id, campaign.id, 'b@buyer.test')

  const mailer = recordingMailer()
  const result = await sendCampaignBatch(campaign.id, workspace.id, undefined, undefined, { sendMail: mailer.fn })
  assert.equal(result.sent, 2)

  const today = utcDayStart(new Date())
  const stats = await prisma.campaignDailyStats.findUnique({ where: { campaignId_date: { campaignId: campaign.id, date: today } } })
  assert.equal(stats!.sent, 2)
  assert.equal(stats!.replied, 0)
})

test('rebuildCampaignStats reconstructs counters from the ContactEvent ledger', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const campaign = await prisma.campaign.create({ data: { workspaceId: workspace.id, name: 'C', goalType: 'BOOK_MEETINGS' } })
  // Seed ledger events directly (as the live paths would), across types.
  await recordContactEvent({ workspaceId: workspace.id, email: 'a@b.test', type: 'SENT', campaignId: campaign.id })
  await recordContactEvent({ workspaceId: workspace.id, email: 'b@b.test', type: 'SENT', campaignId: campaign.id })
  await recordContactEvent({ workspaceId: workspace.id, email: 'a@b.test', type: 'REPLIED', campaignId: campaign.id })
  await recordContactEvent({ workspaceId: workspace.id, email: 'c@b.test', type: 'BOUNCED', campaignId: campaign.id })
  // A pre-existing drifted row (wrong count) must be CORRECTED, not double-counted.
  await incrementCampaignDailyStats(prisma, { workspaceId: workspace.id, campaignId: campaign.id, date: new Date(), field: 'sent', by: 99 })

  const { rows } = await rebuildCampaignStats(workspace.id)
  assert.equal(rows, 1)

  const today = utcDayStart(new Date())
  const stats = await prisma.campaignDailyStats.findUnique({ where: { campaignId_date: { campaignId: campaign.id, date: today } } })
  assert.equal(stats!.sent, 2, 'rebuild overwrites the drifted count from the ledger')
  assert.equal(stats!.replied, 1)
  assert.equal(stats!.bounced, 1)
})
