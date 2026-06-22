// Database-backed tests for recordProcessedReply (ROB-2): the integrity-critical
// part of mailbox sync — advancing a lead and recording the processed email
// atomically — verified without an IMAP server.

import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { recordProcessedReply } from '../packages/backend-core/src/services/mail.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace } from './helpers/db.ts'

after(async () => { await disconnect() })
beforeEach(async () => { await resetDb() })

async function seedLead(workspaceId: string, stage = 'NEW', email = 'replier@x.test') {
  return prisma.lead.create({ data: { workspaceId, businessName: 'Acme', email, stage } })
}

test('advances a non-terminal lead to REPLIED and records the processed email', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const lead = await seedLead(workspace.id, 'OUTREACH_SENT')

  const { advanced } = await recordProcessedReply({
    uid: 101, messageId: '<m1@x>', inReplyTo: null, fromAddress: 'replier@x.test',
    workspaceId: workspace.id, lead: { id: lead.id, stage: lead.stage },
  })
  assert.equal(advanced, true)

  const updated = await prisma.lead.findUnique({ where: { id: lead.id } })
  assert.equal(updated!.stage, 'REPLIED')
  assert.ok(updated!.lastContactedAt)
  assert.equal(await prisma.processedEmail.count({ where: { uid: 101 } }), 1)
})

test('records the email but does NOT advance a terminal lead', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const lead = await seedLead(workspace.id, 'CLOSED')

  const { advanced } = await recordProcessedReply({
    uid: 102, messageId: null, inReplyTo: null, fromAddress: 'replier@x.test',
    workspaceId: workspace.id, lead: { id: lead.id, stage: lead.stage },
  })
  assert.equal(advanced, false)
  assert.equal((await prisma.lead.findUnique({ where: { id: lead.id } }))!.stage, 'CLOSED')
  assert.equal(await prisma.processedEmail.count({ where: { uid: 102 } }), 1)
})

test('records the email with no matching lead', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const { advanced } = await recordProcessedReply({
    uid: 103, messageId: null, inReplyTo: null, fromAddress: 'stranger@x.test',
    workspaceId: workspace.id, lead: null,
  })
  assert.equal(advanced, false)
  assert.equal(await prisma.processedEmail.count({ where: { uid: 103 } }), 1)
})

test('is idempotent on uid: a replay reports advanced:false so the caller does not re-enqueue', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const lead = await seedLead(workspace.id, 'OUTREACH_SENT')
  // The caller passes the pre-sync stage on every attempt, so a naive
  // implementation would compute advance=true twice and signal a second AI
  // enqueue. The fix must report advanced:false on the replay.
  const args = { uid: 104, messageId: '<m4@x>', inReplyTo: null, fromAddress: 'replier@x.test', workspaceId: workspace.id, lead: { id: lead.id, stage: 'OUTREACH_SENT' } }

  const first = await recordProcessedReply(args)
  const second = await recordProcessedReply(args) // replay — must not throw

  assert.equal(first.advanced, true)
  assert.equal(second.advanced, false, 'replay must not signal a second advance/enqueue')
  assert.equal(await prisma.processedEmail.count({ where: { uid: 104 } }), 1)
  assert.equal((await prisma.lead.findUnique({ where: { id: lead.id } }))!.stage, 'REPLIED')
})

test('a different uid for the same lead still records and advances (REPLIED stays)', async () => {
  // Guards against the create()-based fix accidentally treating any second call
  // as a duplicate: a genuinely new uid must still be recorded.
  const { workspace } = await seedUserWithWorkspace()
  const lead = await seedLead(workspace.id, 'OUTREACH_SENT')
  await recordProcessedReply({ uid: 201, messageId: '<a@x>', inReplyTo: null, fromAddress: 'replier@x.test', workspaceId: workspace.id, lead: { id: lead.id, stage: 'OUTREACH_SENT' } })
  const second = await recordProcessedReply({ uid: 202, messageId: '<b@x>', inReplyTo: null, fromAddress: 'replier@x.test', workspaceId: workspace.id, lead: { id: lead.id, stage: 'REPLIED' } })
  // Lead already REPLIED (terminal-ish for advance), so advanced:false, but the
  // new processed-email row must still exist.
  assert.equal(second.advanced, true) // 'REPLIED' is not in the no-advance set
  assert.equal(await prisma.processedEmail.count({ where: { workspaceId: workspace.id } }), 2)
})

// ── Reply attribution: a reply must update exactly ONE OutreachSent ──────────

async function seedCampaign(workspaceId: string) {
  return prisma.campaign.create({ data: { workspaceId, name: 'C', goalType: 'BOOK_MEETINGS' } })
}
async function seedSend(workspaceId: string, campaignId: string, leadId: string, messageId: string) {
  return prisma.outreachSent.create({
    data: { workspaceId, campaignId, leadId, toEmail: 'replier@x.test', subject: 'Hi', body: 'x', status: 'SENT', sentAt: new Date(), messageId },
  })
}

test('attribution: In-Reply-To matches exactly one send across two campaigns', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const lead = await seedLead(workspace.id, 'OUTREACH_SENT')
  const c1 = await seedCampaign(workspace.id)
  const c2 = await seedCampaign(workspace.id)
  const s1 = await seedSend(workspace.id, c1.id, lead.id, '<send-1@acaos>')
  const s2 = await seedSend(workspace.id, c2.id, lead.id, '<send-2@acaos>')

  // Reply references send-2's Message-ID.
  await recordProcessedReply({
    uid: 301, messageId: '<reply@x>', inReplyTo: '<send-2@acaos>', fromAddress: 'replier@x.test',
    workspaceId: workspace.id, lead: { id: lead.id, stage: 'OUTREACH_SENT' },
  })

  // ONLY send-2 flips to REPLIED; send-1 stays SENT.
  assert.equal((await prisma.outreachSent.findUnique({ where: { id: s2.id } }))!.status, 'REPLIED')
  assert.equal((await prisma.outreachSent.findUnique({ where: { id: s1.id } }))!.status, 'SENT')
  // Attribution + ledger recorded.
  const pe = await prisma.processedEmail.findFirst({ where: { uid: 301 } })
  assert.equal(pe!.matchMethod, 'MESSAGE_ID')
  assert.equal(pe!.matchedOutreachSentId, s2.id)
  const ev = await prisma.contactEvent.findFirst({ where: { outreachSentId: s2.id, type: 'REPLIED' } })
  assert.ok(ev, 'a REPLIED ContactEvent was appended for the attributed send')
})

test('attribution: with no In-Reply-To, only the most recent send for the lead flips', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const lead = await seedLead(workspace.id, 'OUTREACH_SENT')
  const c1 = await seedCampaign(workspace.id)
  const c2 = await seedCampaign(workspace.id)
  const older = await seedSend(workspace.id, c1.id, lead.id, '<old@acaos>')
  // Make the second send strictly newer.
  const newer = await prisma.outreachSent.create({
    data: { workspaceId: workspace.id, campaignId: c2.id, leadId: lead.id, toEmail: 'replier@x.test', subject: 'Hi', body: 'x', status: 'SENT', sentAt: new Date(Date.now() + 1000), messageId: '<new@acaos>' },
  })

  await recordProcessedReply({
    uid: 302, messageId: '<reply2@x>', inReplyTo: null, fromAddress: 'replier@x.test',
    workspaceId: workspace.id, lead: { id: lead.id, stage: 'OUTREACH_SENT' },
  })

  assert.equal((await prisma.outreachSent.findUnique({ where: { id: newer.id } }))!.status, 'REPLIED')
  assert.equal((await prisma.outreachSent.findUnique({ where: { id: older.id } }))!.status, 'SENT')
  const pe = await prisma.processedEmail.findFirst({ where: { uid: 302 } })
  assert.equal(pe!.matchMethod, 'MOST_RECENT_LEAD_SEND')
})

test('attribution: a second reply email does NOT double-count the reply', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const lead = await seedLead(workspace.id, 'OUTREACH_SENT')
  const c1 = await seedCampaign(workspace.id)
  const s1 = await seedSend(workspace.id, c1.id, lead.id, '<send-x@acaos>')

  // First reply flips the send and records one REPLIED ContactEvent + 1 stat.
  await recordProcessedReply({ uid: 401, messageId: '<r1@x>', inReplyTo: '<send-x@acaos>', fromAddress: 'replier@x.test', workspaceId: workspace.id, lead: { id: lead.id, stage: 'OUTREACH_SENT' } })
  // Second reply (new uid) re-attributes to the same, now-REPLIED send.
  await recordProcessedReply({ uid: 402, messageId: '<r2@x>', inReplyTo: '<send-x@acaos>', fromAddress: 'replier@x.test', workspaceId: workspace.id, lead: { id: lead.id, stage: 'REPLIED' } })

  // The send is REPLIED once; exactly ONE REPLIED ContactEvent; reply counted once.
  assert.equal((await prisma.outreachSent.findUnique({ where: { id: s1.id } }))!.status, 'REPLIED')
  assert.equal(await prisma.contactEvent.count({ where: { outreachSentId: s1.id, type: 'REPLIED' } }), 1)
  const today = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()))
  const stats = await prisma.campaignDailyStats.findUnique({ where: { campaignId_date: { campaignId: c1.id, date: today } } })
  assert.equal(stats!.replied, 1, 'a duplicate reply email must not double-count')
})
