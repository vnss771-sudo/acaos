// Database-backed behavioral tests for sendFollowupTask — the automatic
// follow-up sender (Sprint 7). It reuses the claim-first outbox mechanics of
// sendCampaignBatch for a single FollowupTask: atomic SCHEDULED→PROCESSING claim,
// per-step outbox row (sequenceStep), contact-policy re-check at send time, and a
// ContactEvent + CampaignDailyStats write in the same transaction as the SENT flip.
// A stubbed mailer (deps seam) keeps SMTP out of the test.

import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { sendFollowupTask } from '../apps/worker/src/processors.ts'
import { suppress } from '../packages/backend-core/src/lib/suppressions.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace } from './helpers/db.ts'

after(async () => { await disconnect() })
beforeEach(async () => { await resetDb() })

// Mailer stub matching services/mail.ts `sendMail(to, subject, html, cfg, opts)`.
function recordingMailer(opts: { throwOn?: (to: string) => boolean } = {}) {
  const sent: string[] = []
  const fn = async (to: string) => {
    sent.push(to)
    if (opts.throwOn?.(to)) throw new Error('550 mailbox unavailable')
    return { messageId: `<fu-${sent.length}@acaos.test>` }
  }
  return { fn: fn as unknown as typeof import('../packages/backend-core/src/services/mail.ts').sendMail, sent }
}

async function seedSmtp(workspaceId: string) {
  await prisma.workspaceEmailConfig.create({
    data: { workspaceId, smtpHost: 'smtp.acme.test', smtpFrom: 'sales@acme.test' },
  })
}
async function seedCampaign(workspaceId: string, autoFollowupsEnabled = true) {
  return prisma.campaign.create({ data: { workspaceId, name: 'Seq', goalType: 'BOOK_MEETINGS', autoFollowupsEnabled } })
}
async function seedStep(campaignId: string, stepNumber: number, delayDays: number, isActive = true) {
  return prisma.outreachSequenceStep.create({ data: { campaignId, stepNumber, delayDays, subject: `Step ${stepNumber}`, body: `follow up ${stepNumber}`, isActive } })
}
async function seedLead(workspaceId: string, campaignId: string, email = 'reach@buyer.test', stage = 'OUTREACH_SENT') {
  return prisma.lead.create({ data: { workspaceId, campaignId, businessName: 'Acme', email, stage } })
}
async function seedDueTask(workspaceId: string, campaignId: string, leadId: string, stepNumber = 2) {
  return prisma.followupTask.create({
    data: { workspaceId, campaignId, leadId, stepNumber, status: 'SCHEDULED', scheduledFor: new Date(Date.now() - 60_000) },
  })
}

test('SENT: dispatches a due step, claims a step-2 outbox row, writes ledger + stats', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await seedSmtp(workspace.id)
  const campaign = await seedCampaign(workspace.id, true)
  await seedStep(campaign.id, 2, 3)
  const lead = await seedLead(workspace.id, campaign.id)
  const task = await seedDueTask(workspace.id, campaign.id, lead.id, 2)

  const mailer = recordingMailer()
  const res = await sendFollowupTask(task.id, { sendMail: mailer.fn })

  assert.equal(res.status, 'SENT')
  assert.deepEqual(mailer.sent, ['reach@buyer.test'])

  const send = await prisma.outreachSent.findFirst({ where: { campaignId: campaign.id, leadId: lead.id, sequenceStep: 2 } })
  assert.ok(send, 'a step-2 outbox row exists')
  assert.equal(send!.status, 'SENT')
  assert.ok(send!.sentAt)

  const after = await prisma.followupTask.findUnique({ where: { id: task.id } })
  assert.equal(after!.status, 'SENT')
  assert.equal(after!.outreachSentId, send!.id)

  // Ledger + read-model written in the same flip.
  const events = await prisma.contactEvent.findMany({ where: { leadId: lead.id, type: 'SENT' } })
  assert.equal(events.length, 1)
  assert.equal(events[0].outreachSentId, send!.id)
  const stats = await prisma.campaignDailyStats.findFirst({ where: { campaignId: campaign.id } })
  assert.equal(stats!.sent, 1)

  // Lead's last-contacted advanced.
  const leadAfter = await prisma.lead.findUnique({ where: { id: lead.id } })
  assert.ok(leadAfter!.lastContactedAt)
})

test('SENT chains: a sent step schedules the next active step', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await seedSmtp(workspace.id)
  const campaign = await seedCampaign(workspace.id, true)
  await seedStep(campaign.id, 2, 3)
  await seedStep(campaign.id, 3, 4)
  const lead = await seedLead(workspace.id, campaign.id)
  const task = await seedDueTask(workspace.id, campaign.id, lead.id, 2)

  const mailer = recordingMailer()
  await sendFollowupTask(task.id, { sendMail: mailer.fn })

  const next = await prisma.followupTask.findFirst({ where: { campaignId: campaign.id, leadId: lead.id, stepNumber: 3 } })
  assert.ok(next, 'step 3 was scheduled after step 2 sent')
  assert.equal(next!.status, 'SCHEDULED')
})

test('CANCELLED: a campaign with auto-followups disabled cancels the task, never sends', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await seedSmtp(workspace.id)
  const campaign = await seedCampaign(workspace.id, false)
  await seedStep(campaign.id, 2, 3)
  const lead = await seedLead(workspace.id, campaign.id)
  const task = await seedDueTask(workspace.id, campaign.id, lead.id, 2)

  const mailer = recordingMailer()
  const res = await sendFollowupTask(task.id, { sendMail: mailer.fn })

  assert.equal(res.status, 'CANCELLED')
  assert.deepEqual(mailer.sent, [], 'a disabled campaign must not dispatch')
  const after = await prisma.followupTask.findUnique({ where: { id: task.id } })
  assert.equal(after!.status, 'CANCELLED')
  assert.equal(after!.cancelledReason, 'CAMPAIGN_PAUSED')
  assert.equal(await prisma.outreachSent.count({ where: { leadId: lead.id } }), 0)
})

test('BLOCKED: a suppressed recipient is blocked at send time, never dispatched', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await seedSmtp(workspace.id)
  const campaign = await seedCampaign(workspace.id, true)
  await seedStep(campaign.id, 2, 3)
  const lead = await seedLead(workspace.id, campaign.id, 'stop@buyer.test')
  await suppress(workspace.id, 'stop@buyer.test', 'UNSUBSCRIBED')
  const task = await seedDueTask(workspace.id, campaign.id, lead.id, 2)

  const mailer = recordingMailer()
  const res = await sendFollowupTask(task.id, { sendMail: mailer.fn })

  assert.equal(res.status, 'BLOCKED')
  assert.equal(res.reason, 'SUPPRESSED')
  assert.deepEqual(mailer.sent, [])
  const after = await prisma.followupTask.findUnique({ where: { id: task.id } })
  assert.equal(after!.status, 'BLOCKED')
  assert.equal(await prisma.outreachSent.count({ where: { leadId: lead.id } }), 0)
})

test('BLOCKED: a recipient who already replied is blocked (live thread)', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await seedSmtp(workspace.id)
  const campaign = await seedCampaign(workspace.id, true)
  await seedStep(campaign.id, 2, 3)
  const lead = await seedLead(workspace.id, campaign.id, 'replied@buyer.test')
  // A prior REPLIED ledger event for this recipient.
  await prisma.contactEvent.create({
    data: { workspaceId: workspace.id, leadId: lead.id, campaignId: campaign.id, emailKey: 'replied@buyer.test', type: 'REPLIED' },
  })
  const task = await seedDueTask(workspace.id, campaign.id, lead.id, 2)

  const mailer = recordingMailer()
  const res = await sendFollowupTask(task.id, { sendMail: mailer.fn })

  assert.equal(res.status, 'BLOCKED')
  assert.equal(res.reason, 'ALREADY_REPLIED')
  assert.deepEqual(mailer.sent, [])
})

test('claim guard: a task already out of SCHEDULED is a no-op SKIP (no double send)', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await seedSmtp(workspace.id)
  const campaign = await seedCampaign(workspace.id, true)
  await seedStep(campaign.id, 2, 3)
  const lead = await seedLead(workspace.id, campaign.id)
  // The task is already PROCESSING (claimed by another worker).
  const task = await prisma.followupTask.create({
    data: { workspaceId: workspace.id, campaignId: campaign.id, leadId: lead.id, stepNumber: 2, status: 'PROCESSING', scheduledFor: new Date() },
  })

  const mailer = recordingMailer()
  const res = await sendFollowupTask(task.id, { sendMail: mailer.fn })

  assert.equal(res.status, 'SKIPPED')
  assert.deepEqual(mailer.sent, [], 'a non-SCHEDULED task is never dispatched')
})

test('BLOCKED: no SMTP config blocks the send (does not crash)', async () => {
  const { workspace } = await seedUserWithWorkspace()
  // No seedSmtp — workspace has no email config.
  const campaign = await seedCampaign(workspace.id, true)
  await seedStep(campaign.id, 2, 3)
  const lead = await seedLead(workspace.id, campaign.id)
  const task = await seedDueTask(workspace.id, campaign.id, lead.id, 2)

  const mailer = recordingMailer()
  const res = await sendFollowupTask(task.id, { sendMail: mailer.fn })

  assert.equal(res.status, 'BLOCKED')
  assert.equal(res.reason, 'SMTP_NOT_CONFIGURED')
  assert.deepEqual(mailer.sent, [])
})

test('CANCELLED: an inactive sequence step cancels the task', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await seedSmtp(workspace.id)
  const campaign = await seedCampaign(workspace.id, true)
  await seedStep(campaign.id, 2, 3, false) // inactive
  const lead = await seedLead(workspace.id, campaign.id)
  const task = await seedDueTask(workspace.id, campaign.id, lead.id, 2)

  const mailer = recordingMailer()
  const res = await sendFollowupTask(task.id, { sendMail: mailer.fn })

  assert.equal(res.status, 'CANCELLED')
  assert.equal(res.reason, 'STEP_INACTIVE')
  assert.deepEqual(mailer.sent, [])
})

test('idempotent: a step already in the outbox marks the task SENT without re-sending', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await seedSmtp(workspace.id)
  const campaign = await seedCampaign(workspace.id, true)
  await seedStep(campaign.id, 2, 3)
  const lead = await seedLead(workspace.id, campaign.id)
  // Step 2 was already sent (outbox row exists for the unique campaign+lead+step).
  await prisma.outreachSent.create({
    data: { workspaceId: workspace.id, campaignId: campaign.id, leadId: lead.id, sequenceStep: 2, toEmail: 'reach@buyer.test', subject: 'Step 2', body: 'x', status: 'SENT' },
  })
  const task = await seedDueTask(workspace.id, campaign.id, lead.id, 2)

  const mailer = recordingMailer()
  const res = await sendFollowupTask(task.id, { sendMail: mailer.fn })

  assert.equal(res.status, 'SENT')
  assert.deepEqual(mailer.sent, [], 'the duplicate claim short-circuits before SMTP')
  assert.equal(await prisma.outreachSent.count({ where: { campaignId: campaign.id, leadId: lead.id, sequenceStep: 2 } }), 1)
})
