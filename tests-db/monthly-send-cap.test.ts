// DB-tier tests for the opt-in monthly send ceiling (a coarse backstop to the
// daily cap). Enforced as a batch fast-path in sendCampaignBatch and a defer in
// sendFollowupTask. null monthlySendLimit → unchanged behaviour.

import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { sendCampaignBatch, sendFollowupTask } from '../apps/worker/src/processors.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace } from './helpers/db.ts'

after(async () => { await disconnect() })
beforeEach(async () => { await resetDb() })

function recordingMailer() {
  const sent: string[] = []
  const fn = async (to: string) => { sent.push(to); return { messageId: `<m-${sent.length}@acaos.test>` } }
  return { fn: fn as unknown as typeof import('../packages/backend-core/src/services/mail.ts').sendMail, sent }
}
async function seedSmtp(workspaceId: string) {
  await prisma.workspaceEmailConfig.create({ data: { workspaceId, smtpHost: 'smtp.acme.test', smtpFrom: 'sales@acme.test' } })
}
async function seedLead(workspaceId: string, campaignId: string, email: string) {
  const lead = await prisma.lead.create({ data: { workspaceId, campaignId, businessName: 'B', email, stage: 'RESEARCHED' } })
  await prisma.outreachDraft.create({ data: { leadId: lead.id, workspaceId, subject: 'Hi', emailBody: 'Hello there' } })
}
// Sends already made this month count toward the ceiling.
async function seedSentThisMonth(workspaceId: string, campaignId: string, n: number) {
  for (let i = 0; i < n; i++) {
    await prisma.outreachSent.create({ data: { workspaceId, campaignId, toEmail: `past${i}@x.test`, subject: 'Hi', body: 'x', status: 'SENT', sentAt: new Date() } })
  }
}

test('campaign: the batch halts once the monthly ceiling is reached', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await seedSmtp(workspace.id)
  await prisma.workspaceICP.create({
    data: { workspaceId: workspace.id, approvalMode: false, dailySendLimit: 1000, monthlySendLimit: 3,
      targetIndustries: [], targetGeos: [], excludedIndustries: [] },
  })
  const campaign = await prisma.campaign.create({ data: { workspaceId: workspace.id, name: 'C', goalType: 'BOOK_MEETINGS' } })
  await seedSentThisMonth(workspace.id, campaign.id, 3) // already at the monthly ceiling
  await seedLead(workspace.id, campaign.id, 'new@buyer.test')

  const mailer = recordingMailer()
  const result = await sendCampaignBatch(campaign.id, workspace.id, undefined, undefined, { sendMail: mailer.fn })

  assert.equal(result.sent, 0)
  assert.equal(result.skippedByReason.MONTHLY_CAP, 1)
  assert.deepEqual(mailer.sent, [])
})

test('campaign: under the monthly ceiling it sends normally', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await seedSmtp(workspace.id)
  await prisma.workspaceICP.create({
    data: { workspaceId: workspace.id, approvalMode: false, dailySendLimit: 1000, monthlySendLimit: 100,
      targetIndustries: [], targetGeos: [], excludedIndustries: [] },
  })
  const campaign = await prisma.campaign.create({ data: { workspaceId: workspace.id, name: 'C', goalType: 'BOOK_MEETINGS' } })
  await seedSentThisMonth(workspace.id, campaign.id, 2)
  await seedLead(workspace.id, campaign.id, 'new@buyer.test')

  const mailer = recordingMailer()
  const result = await sendCampaignBatch(campaign.id, workspace.id, undefined, undefined, { sendMail: mailer.fn })
  assert.equal(result.sent, 1)
})

test('campaign: no monthly limit configured → unchanged (sends)', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await seedSmtp(workspace.id)
  await prisma.workspaceICP.create({
    data: { workspaceId: workspace.id, approvalMode: false, dailySendLimit: 1000,
      targetIndustries: [], targetGeos: [], excludedIndustries: [] },
  })
  const campaign = await prisma.campaign.create({ data: { workspaceId: workspace.id, name: 'C', goalType: 'BOOK_MEETINGS' } })
  await seedSentThisMonth(workspace.id, campaign.id, 50)
  await seedLead(workspace.id, campaign.id, 'new@buyer.test')

  const mailer = recordingMailer()
  const result = await sendCampaignBatch(campaign.id, workspace.id, undefined, undefined, { sendMail: mailer.fn })
  assert.equal(result.sent, 1)
})

test('follow-up: defers (parked at SCHEDULED) when the monthly ceiling is hit', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await seedSmtp(workspace.id)
  await prisma.workspaceICP.create({
    data: { workspaceId: workspace.id, approvalMode: false, dailySendLimit: 1000, monthlySendLimit: 3,
      targetIndustries: [], targetGeos: [], excludedIndustries: [] },
  })
  const campaign = await prisma.campaign.create({ data: { workspaceId: workspace.id, name: 'Seq', goalType: 'BOOK_MEETINGS', autoFollowupsEnabled: true } })
  await seedSentThisMonth(workspace.id, campaign.id, 3)
  await prisma.outreachSequenceStep.create({ data: { campaignId: campaign.id, stepNumber: 2, delayDays: 3, subject: 'S2', body: 'follow', isActive: true } })
  const lead = await prisma.lead.create({ data: { workspaceId: workspace.id, campaignId: campaign.id, businessName: 'Acme', email: 'reach@buyer.test', stage: 'OUTREACH_SENT' } })
  const task = await prisma.followupTask.create({ data: { workspaceId: workspace.id, campaignId: campaign.id, leadId: lead.id, stepNumber: 2, status: 'SCHEDULED', scheduledFor: new Date(Date.now() - 60000) } })

  const mailer = recordingMailer()
  const res = await sendFollowupTask(task.id, { sendMail: mailer.fn })

  assert.equal(res.status, 'SKIPPED')
  assert.equal(res.reason, 'MONTHLY_CAP')
  assert.deepEqual(mailer.sent, [])
  assert.equal((await prisma.followupTask.findUnique({ where: { id: task.id } }))!.status, 'SCHEDULED')
})
