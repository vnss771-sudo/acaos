// DB-tier tests for follow-up scheduling + cancellation (the sequencing
// foundation; auto-send worker is separate). Scheduling is idempotent via the
// @@unique([campaignId, leadId, stepNumber]) constraint; a reply cancels pending
// follow-ups in the same transaction as recording the reply.

import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { scheduleNextFollowup, cancelPendingFollowups } from '../packages/backend-core/src/services/followups.ts'
import { recordProcessedReply } from '../packages/backend-core/src/services/mail.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace } from './helpers/db.ts'

after(async () => { await disconnect() })
beforeEach(async () => { await resetDb() })

async function seedCampaign(workspaceId: string, autoFollowupsEnabled = true) {
  return prisma.campaign.create({ data: { workspaceId, name: 'Seq', goalType: 'BOOK_MEETINGS', autoFollowupsEnabled } })
}
async function seedStep(campaignId: string, stepNumber: number, delayDays: number) {
  return prisma.outreachSequenceStep.create({ data: { campaignId, stepNumber, delayDays, body: 'follow up', isActive: true } })
}
async function seedLead(workspaceId: string, campaignId: string) {
  return prisma.lead.create({ data: { workspaceId, campaignId, businessName: 'Acme', email: 'r@x.test', stage: 'OUTREACH_SENT' } })
}

test('scheduleNextFollowup creates a task at sentAt + delayDays when enabled', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const campaign = await seedCampaign(workspace.id, true)
  await seedStep(campaign.id, 2, 3)
  const lead = await seedLead(workspace.id, campaign.id)

  const sentAt = new Date('2026-06-15T09:00:00Z')
  const id = await scheduleNextFollowup({ workspaceId: workspace.id, campaignId: campaign.id, leadId: lead.id, currentStep: 1, sentAt, autoFollowupsEnabled: true })
  assert.ok(id)

  const task = await prisma.followupTask.findUnique({ where: { id: id! } })
  assert.equal(task!.stepNumber, 2)
  assert.equal(task!.status, 'SCHEDULED')
  assert.equal(task!.scheduledFor.toISOString(), new Date('2026-06-18T09:00:00Z').toISOString())
})

test('scheduleNextFollowup is idempotent (unique campaign/lead/step)', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const campaign = await seedCampaign(workspace.id, true)
  await seedStep(campaign.id, 2, 3)
  const lead = await seedLead(workspace.id, campaign.id)
  const sentAt = new Date()

  const first = await scheduleNextFollowup({ workspaceId: workspace.id, campaignId: campaign.id, leadId: lead.id, currentStep: 1, sentAt, autoFollowupsEnabled: true })
  const second = await scheduleNextFollowup({ workspaceId: workspace.id, campaignId: campaign.id, leadId: lead.id, currentStep: 1, sentAt, autoFollowupsEnabled: true })
  assert.ok(first)
  assert.equal(second, null, 'a duplicate schedule is a no-op')
  assert.equal(await prisma.followupTask.count({ where: { campaignId: campaign.id, leadId: lead.id } }), 1)
})

test('scheduleNextFollowup is a no-op when auto-followups are disabled', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const campaign = await seedCampaign(workspace.id, false)
  await seedStep(campaign.id, 2, 3)
  const lead = await seedLead(workspace.id, campaign.id)

  const id = await scheduleNextFollowup({ workspaceId: workspace.id, campaignId: campaign.id, leadId: lead.id, currentStep: 1, sentAt: new Date(), autoFollowupsEnabled: false })
  assert.equal(id, null)
  assert.equal(await prisma.followupTask.count(), 0)
})

test('cancelPendingFollowups cancels only SCHEDULED tasks', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const campaign = await seedCampaign(workspace.id, true)
  const lead = await seedLead(workspace.id, campaign.id)
  await prisma.followupTask.create({ data: { workspaceId: workspace.id, campaignId: campaign.id, leadId: lead.id, stepNumber: 2, status: 'SCHEDULED', scheduledFor: new Date() } })
  await prisma.followupTask.create({ data: { workspaceId: workspace.id, campaignId: campaign.id, leadId: lead.id, stepNumber: 3, status: 'SENT', scheduledFor: new Date() } })

  const cancelled = await cancelPendingFollowups(prisma, { workspaceId: workspace.id, leadId: lead.id, reason: 'REPLY_RECEIVED' })
  assert.equal(cancelled, 1)
  assert.equal(await prisma.followupTask.count({ where: { leadId: lead.id, status: 'CANCELLED', cancelledReason: 'REPLY_RECEIVED' } }), 1)
  // The already-SENT task is untouched.
  assert.equal(await prisma.followupTask.count({ where: { leadId: lead.id, status: 'SENT' } }), 1)
})

test('a reply cancels pending follow-ups for the lead', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const campaign = await seedCampaign(workspace.id, true)
  const lead = await seedLead(workspace.id, campaign.id)
  await prisma.followupTask.create({ data: { workspaceId: workspace.id, campaignId: campaign.id, leadId: lead.id, stepNumber: 2, status: 'SCHEDULED', scheduledFor: new Date(Date.now() + 86400000) } })

  await recordProcessedReply({ uid: 501, messageId: '<rr@x>', inReplyTo: null, fromAddress: 'r@x.test', workspaceId: workspace.id, lead: { id: lead.id, stage: 'OUTREACH_SENT', email: 'r@x.test' } })

  const task = await prisma.followupTask.findFirst({ where: { leadId: lead.id } })
  assert.equal(task!.status, 'CANCELLED')
  assert.equal(task!.cancelledReason, 'REPLY_RECEIVED')
})
