// DB-tier tests for the opt-in send window: a campaign batch halts outside the
// window (leads stay eligible), a follow-up defers (parks back at SCHEDULED), and
// with no window configured behaviour is unchanged. We set a window that is
// guaranteed-closed (00:00–00:00 is misconfigured → open, so we use a 1-hour UTC
// window far from "now") by computing hours around the current UTC hour.

import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { sendCampaignBatch, sendFollowupTask } from '../apps/worker/src/processors.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace } from './helpers/db.ts'

after(async () => { await disconnect() })
beforeEach(async () => { await resetDb() })

function recordingMailer() {
  const sent: string[] = []
  const fn = async (to: string) => { sent.push(to); return { messageId: `<win-${sent.length}@acaos.test>` } }
  return { fn: fn as unknown as typeof import('../packages/backend-core/src/services/mail.ts').sendMail, sent }
}
async function seedSmtp(workspaceId: string) {
  await prisma.workspaceEmailConfig.create({ data: { workspaceId, smtpHost: 'smtp.acme.test', smtpFrom: 'sales@acme.test' } })
}

// A 1-hour UTC window that does NOT contain the current hour (guaranteed closed now).
function closedWindowNow(): { start: number; end: number } {
  const h = new Date().getUTCHours()
  const start = (h + 2) % 24
  return { start, end: start + 1 <= 24 ? start + 1 : 1 }
}
// A wide-open window that DOES contain now.
const OPEN = { start: 0, end: 24 }

test('campaign: outside the window the batch halts and leads stay eligible', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await seedSmtp(workspace.id)
  const w = closedWindowNow()
  await prisma.workspaceICP.create({
    data: { workspaceId: workspace.id, approvalMode: false, dailySendLimit: 50,
      sendWindowStartHour: w.start, sendWindowEndHour: w.end, sendTimezone: 'UTC',
      targetIndustries: [], targetGeos: [], excludedIndustries: [] },
  })
  const campaign = await prisma.campaign.create({ data: { workspaceId: workspace.id, name: 'C', goalType: 'BOOK_MEETINGS' } })
  const lead = await prisma.lead.create({ data: { workspaceId: workspace.id, campaignId: campaign.id, businessName: 'Acme', email: 'reach@buyer.test', stage: 'RESEARCHED' } })
  await prisma.outreachDraft.create({ data: { leadId: lead.id, workspaceId: workspace.id, subject: 'Hi', emailBody: 'Hello there' } })

  const mailer = recordingMailer()
  const result = await sendCampaignBatch(campaign.id, workspace.id, undefined, undefined, { sendMail: mailer.fn })

  assert.equal(result.sent, 0)
  assert.equal(result.skippedByReason.OUTSIDE_SEND_WINDOW, 1)
  assert.deepEqual(mailer.sent, [])
  assert.equal(await prisma.outreachSent.count({ where: { leadId: lead.id } }), 0)
  // Lead is not advanced — still eligible for the next launch.
  assert.equal((await prisma.lead.findUnique({ where: { id: lead.id } }))!.stage, 'RESEARCHED')
})

test('campaign: inside an open window it sends normally', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await seedSmtp(workspace.id)
  await prisma.workspaceICP.create({
    data: { workspaceId: workspace.id, approvalMode: false, dailySendLimit: 50,
      sendWindowStartHour: OPEN.start, sendWindowEndHour: OPEN.end, sendTimezone: 'UTC',
      targetIndustries: [], targetGeos: [], excludedIndustries: [] },
  })
  const campaign = await prisma.campaign.create({ data: { workspaceId: workspace.id, name: 'C', goalType: 'BOOK_MEETINGS' } })
  const lead = await prisma.lead.create({ data: { workspaceId: workspace.id, campaignId: campaign.id, businessName: 'Acme', email: 'reach@buyer.test', stage: 'RESEARCHED' } })
  await prisma.outreachDraft.create({ data: { leadId: lead.id, workspaceId: workspace.id, subject: 'Hi', emailBody: 'Hello there' } })

  const mailer = recordingMailer()
  const result = await sendCampaignBatch(campaign.id, workspace.id, undefined, undefined, { sendMail: mailer.fn })
  assert.equal(result.sent, 1)
})

test('campaign: no window configured → unchanged (sends)', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await seedSmtp(workspace.id)
  await prisma.workspaceICP.create({
    data: { workspaceId: workspace.id, approvalMode: false, dailySendLimit: 50,
      targetIndustries: [], targetGeos: [], excludedIndustries: [] },
  })
  const campaign = await prisma.campaign.create({ data: { workspaceId: workspace.id, name: 'C', goalType: 'BOOK_MEETINGS' } })
  const lead = await prisma.lead.create({ data: { workspaceId: workspace.id, campaignId: campaign.id, businessName: 'Acme', email: 'reach@buyer.test', stage: 'RESEARCHED' } })
  await prisma.outreachDraft.create({ data: { leadId: lead.id, workspaceId: workspace.id, subject: 'Hi', emailBody: 'Hello there' } })

  const mailer = recordingMailer()
  const result = await sendCampaignBatch(campaign.id, workspace.id, undefined, undefined, { sendMail: mailer.fn })
  assert.equal(result.sent, 1)
})

test('follow-up: outside the window the task defers (parked back at SCHEDULED)', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await seedSmtp(workspace.id)
  const w = closedWindowNow()
  await prisma.workspaceICP.create({
    data: { workspaceId: workspace.id, approvalMode: false, dailySendLimit: 50,
      sendWindowStartHour: w.start, sendWindowEndHour: w.end, sendTimezone: 'UTC',
      targetIndustries: [], targetGeos: [], excludedIndustries: [] },
  })
  const campaign = await prisma.campaign.create({ data: { workspaceId: workspace.id, name: 'Seq', goalType: 'BOOK_MEETINGS', autoFollowupsEnabled: true } })
  await prisma.outreachSequenceStep.create({ data: { campaignId: campaign.id, stepNumber: 2, delayDays: 3, subject: 'S2', body: 'follow', isActive: true } })
  const lead = await prisma.lead.create({ data: { workspaceId: workspace.id, campaignId: campaign.id, businessName: 'Acme', email: 'reach@buyer.test', stage: 'OUTREACH_SENT' } })
  const task = await prisma.followupTask.create({ data: { workspaceId: workspace.id, campaignId: campaign.id, leadId: lead.id, stepNumber: 2, status: 'SCHEDULED', scheduledFor: new Date(Date.now() - 60000) } })

  const mailer = recordingMailer()
  const res = await sendFollowupTask(task.id, { sendMail: mailer.fn })

  assert.equal(res.status, 'SKIPPED')
  assert.equal(res.reason, 'OUTSIDE_SEND_WINDOW')
  assert.deepEqual(mailer.sent, [])
  // Parked back at SCHEDULED so the next scan retries it once the window reopens.
  assert.equal((await prisma.followupTask.findUnique({ where: { id: task.id } }))!.status, 'SCHEDULED')
})
