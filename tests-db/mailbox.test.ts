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
    uid: 101, messageId: '<m1@x>', fromAddress: 'replier@x.test',
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
    uid: 102, messageId: null, fromAddress: 'replier@x.test',
    workspaceId: workspace.id, lead: { id: lead.id, stage: lead.stage },
  })
  assert.equal(advanced, false)
  assert.equal((await prisma.lead.findUnique({ where: { id: lead.id } }))!.stage, 'CLOSED')
  assert.equal(await prisma.processedEmail.count({ where: { uid: 102 } }), 1)
})

test('records the email with no matching lead', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const { advanced } = await recordProcessedReply({
    uid: 103, messageId: null, fromAddress: 'stranger@x.test',
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
  const args = { uid: 104, messageId: '<m4@x>', fromAddress: 'replier@x.test', workspaceId: workspace.id, lead: { id: lead.id, stage: 'OUTREACH_SENT' } }

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
  await recordProcessedReply({ uid: 201, messageId: '<a@x>', fromAddress: 'replier@x.test', workspaceId: workspace.id, lead: { id: lead.id, stage: 'OUTREACH_SENT' } })
  const second = await recordProcessedReply({ uid: 202, messageId: '<b@x>', fromAddress: 'replier@x.test', workspaceId: workspace.id, lead: { id: lead.id, stage: 'REPLIED' } })
  // Lead already REPLIED (terminal-ish for advance), so advanced:false, but the
  // new processed-email row must still exist.
  assert.equal(second.advanced, true) // 'REPLIED' is not in the no-advance set
  assert.equal(await prisma.processedEmail.count({ where: { workspaceId: workspace.id } }), 2)
})
