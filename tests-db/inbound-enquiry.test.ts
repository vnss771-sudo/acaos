// Database-backed tests for inbound job enquiries and reply risk escalation:
// the mailbox-sync persistence (recordProcessedReply) and the analyze-reply
// gate (applyReplyAnalysis), verified without IMAP or OpenAI.

import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { recordProcessedReply } from '../packages/backend-core/src/services/mail.ts'
import { applyReplyAnalysis } from '../apps/worker/src/processors.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace } from './helpers/db.ts'

after(async () => { await disconnect() })
beforeEach(async () => { await resetDb() })

const enquiry = (externalId = 'mid:<e1@x>') => ({
  externalId,
  kind: 'DIRECT_ENQUIRY',
  title: 'Switchboard upgrade quote',
  description: 'Can you quote for a switchboard upgrade?',
  counterpartyName: 'Jo Smith',
  counterpartyEmail: 'jo@gmail.com',
  score: 60,
  matchedTrades: ['electrical'],
  reasons: ['Asks for a quote or price'],
  recommendedAction: 'Reply today',
  contentHash: 'h',
})

test('an unmatched message judged an enquiry lands in Find work as a NEW opportunity', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const r = await recordProcessedReply({
    uid: 1, messageId: '<e1@x>', inReplyTo: null, fromAddress: 'jo@gmail.com',
    workspaceId: workspace.id, lead: null, enquiry: enquiry(),
  })
  assert.equal(r.enquiryCreated, true)
  const opp = await prisma.opportunity.findFirstOrThrow({ where: { workspaceId: workspace.id } })
  assert.equal(opp.source, 'email')
  assert.equal(opp.kind, 'DIRECT_ENQUIRY')
  assert.equal(opp.status, 'NEW')
  assert.equal(opp.counterpartyEmail, 'jo@gmail.com')
  assert.equal(await prisma.processedEmail.count({ where: { workspaceId: workspace.id } }), 1)
})

test('a replayed message (same uid) never creates a second enquiry', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const args = { uid: 2, messageId: '<e2@x>', inReplyTo: null, fromAddress: 'jo@gmail.com', workspaceId: workspace.id, lead: null, enquiry: enquiry('mid:<e2@x>') }
  await recordProcessedReply(args)
  const again = await recordProcessedReply(args)
  assert.equal(again.enquiryCreated ?? false, false)
  assert.equal(await prisma.opportunity.count({ where: { workspaceId: workspace.id } }), 1)
})

test('a message from a known lead is a reply, not an enquiry', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const lead = await prisma.lead.create({ data: { workspaceId: workspace.id, businessName: 'Acme', email: 'jo@gmail.com', stage: 'OUTREACH_SENT' } })
  await recordProcessedReply({
    uid: 3, messageId: '<e3@x>', inReplyTo: null, fromAddress: 'jo@gmail.com',
    workspaceId: workspace.id, lead: { id: lead.id, stage: lead.stage }, enquiry: enquiry('mid:<e3@x>'),
  })
  assert.equal(await prisma.opportunity.count({ where: { workspaceId: workspace.id } }), 0)
})

test('a reply to one of our sends is never an enquiry, and its risk flags are stamped on the send', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const send = await prisma.outreachSent.create({
    data: { workspaceId: workspace.id, toEmail: 'colleague@acme.test', subject: 's', body: 'b', status: 'SENT', messageId: '<out1@us>', sentAt: new Date() },
  })
  await recordProcessedReply({
    uid: 4, messageId: '<e4@x>', inReplyTo: '<out1@us>', fromAddress: 'colleague@acme.test',
    workspaceId: workspace.id, lead: null, riskFlags: ['LEGAL'], enquiry: enquiry('mid:<e4@x>'),
  })
  assert.equal(await prisma.opportunity.count({ where: { workspaceId: workspace.id } }), 0)
  const updated = await prisma.outreachSent.findUniqueOrThrow({ where: { id: send.id } })
  assert.equal(updated.status, 'REPLIED')
  assert.deepEqual(updated.replyRiskFlags, ['LEGAL'])
})

test('an escalated NOT_INTERESTED reply keeps the lead alive and stays out of the scoring model', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const lead = await prisma.lead.create({ data: { workspaceId: workspace.id, businessName: 'Acme', email: 'r@x.test', stage: 'OUTREACH_SENT', score: 60 } })
  const send = await prisma.outreachSent.create({
    data: { workspaceId: workspace.id, leadId: lead.id, toEmail: 'r@x.test', subject: 's', body: 'b', status: 'REPLIED', repliedAt: new Date(), replyRiskFlags: ['COMPLAINT'] },
  })
  await applyReplyAnalysis(lead.id, { classification: 'NOT_INTERESTED', confidence: 95, isAutoReply: false, summary: 'Angry' })

  assert.equal((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).stage, 'REPLIED')
  assert.equal(await prisma.scoringOutcome.count({ where: { leadId: lead.id } }), 0)
  const s = await prisma.outreachSent.findUniqueOrThrow({ where: { id: send.id } })
  assert.equal(s.replyIntent, 'NOT_INTERESTED', 'the AI label is still recorded for the Inbox')
})

test('a non-escalated high-confidence NOT_INTERESTED still marks the lead DEAD (unchanged behaviour)', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const lead = await prisma.lead.create({ data: { workspaceId: workspace.id, businessName: 'Acme', email: 'r@x.test', stage: 'OUTREACH_SENT', score: 60 } })
  await prisma.outreachSent.create({
    data: { workspaceId: workspace.id, leadId: lead.id, toEmail: 'r@x.test', subject: 's', body: 'b', status: 'REPLIED', repliedAt: new Date() },
  })
  await applyReplyAnalysis(lead.id, { classification: 'NOT_INTERESTED', confidence: 95, isAutoReply: false })
  assert.equal((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).stage, 'DEAD')
  assert.equal(await prisma.scoringOutcome.count({ where: { leadId: lead.id } }), 1)
})
