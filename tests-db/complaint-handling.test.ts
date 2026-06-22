// DB-tier tests for complaint (ARF feedback-loop) handling: applyComplaints
// suppresses with reason COMPLAINT, records the UnsubscribeEvent(source=COMPLAINT)
// the reputation breaker reads, and cancels pending follow-ups — but only for
// addresses we actually sent to.

import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { applyComplaints } from '../packages/backend-core/src/services/mail.ts'
import { isSuppressed } from '../packages/backend-core/src/lib/suppressions.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace } from './helpers/db.ts'

after(async () => { await disconnect() })
beforeEach(async () => { await resetDb() })

async function seedSend(workspaceId: string, toEmail: string) {
  const campaign = await prisma.campaign.create({ data: { workspaceId, name: 'C', goalType: 'BOOK_MEETINGS', autoFollowupsEnabled: true } })
  const lead = await prisma.lead.create({ data: { workspaceId, campaignId: campaign.id, businessName: 'Acme', email: toEmail, stage: 'OUTREACH_SENT' } })
  const send = await prisma.outreachSent.create({ data: { workspaceId, campaignId: campaign.id, leadId: lead.id, toEmail, subject: 'Hi', body: 'x', status: 'SENT', sentAt: new Date() } })
  return { campaign, lead, send }
}

test('complaint: suppresses (COMPLAINT), records the event, cancels pending follow-ups', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const { campaign, lead, send } = await seedSend(workspace.id, 'angry@buyer.test')
  // A pending follow-up that the complaint must cancel.
  await prisma.followupTask.create({ data: { workspaceId: workspace.id, campaignId: campaign.id, leadId: lead.id, stepNumber: 2, status: 'SCHEDULED', scheduledFor: new Date(Date.now() + 86400000) } })

  const n = await applyComplaints(workspace.id, ['angry@buyer.test'])
  assert.equal(n, 1)
  assert.equal(await isSuppressed(workspace.id, 'angry@buyer.test'), true)
  const sup = await prisma.suppression.findFirst({ where: { workspaceId: workspace.id, emailKey: 'angry@buyer.test' } })
  assert.equal(sup!.reason, 'COMPLAINT')

  const ev = await prisma.unsubscribeEvent.findFirst({ where: { workspaceId: workspace.id, source: 'COMPLAINT' } })
  assert.ok(ev, 'a COMPLAINT UnsubscribeEvent is recorded (the reputation breaker reads it)')
  assert.equal(ev!.outreachSentId, send.id)

  const task = await prisma.followupTask.findFirst({ where: { leadId: lead.id } })
  assert.equal(task!.status, 'CANCELLED')
  assert.equal(task!.cancelledReason, 'COMPLAINT')
})

test('complaint feeds the reputation signal: complaintRate reflects the event', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await seedSend(workspace.id, 'angry@buyer.test')
  // Seed enough SENT ledger events to clear the min-sample, then one complaint.
  await prisma.contactEvent.createMany({ data: Array.from({ length: 60 }, (_, i) => ({ workspaceId: workspace.id, emailKey: `s${i}@x.test`, type: 'SENT' as const })) })
  await applyComplaints(workspace.id, ['angry@buyer.test'])

  const { evaluateSenderReputation } = await import('../packages/backend-core/src/lib/senderReputation.ts')
  const v = await evaluateSenderReputation(workspace.id)
  assert.equal(v.complaints, 1)
  assert.ok(v.complaintRate > 0)
})

test('safety: a complaint for an address we never sent to is ignored', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const n = await applyComplaints(workspace.id, ['stranger@elsewhere.test'])
  assert.equal(n, 0)
  assert.equal(await isSuppressed(workspace.id, 'stranger@elsewhere.test'), false)
  assert.equal(await prisma.unsubscribeEvent.count({ where: { workspaceId: workspace.id } }), 0)
})
