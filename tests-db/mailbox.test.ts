// Database-backed tests for recordProcessedReply (ROB-2): the integrity-critical
// part of mailbox sync — advancing a lead and recording the processed email
// atomically — verified without an IMAP server.

import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { recordProcessedReply } from '../apps/api/src/services/mail.ts'
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
    lead: { id: lead.id, stage: lead.stage },
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
    lead: { id: lead.id, stage: lead.stage },
  })
  assert.equal(advanced, false)
  assert.equal((await prisma.lead.findUnique({ where: { id: lead.id } }))!.stage, 'CLOSED')
  assert.equal(await prisma.processedEmail.count({ where: { uid: 102 } }), 1)
})

test('records the email with no matching lead', async () => {
  const { advanced } = await recordProcessedReply({
    uid: 103, messageId: null, fromAddress: 'stranger@x.test', lead: null,
  })
  assert.equal(advanced, false)
  assert.equal(await prisma.processedEmail.count({ where: { uid: 103 } }), 1)
})

test('is idempotent on uid (re-running does not error or double-advance)', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const lead = await seedLead(workspace.id, 'OUTREACH_SENT')
  const args = { uid: 104, messageId: '<m4@x>', fromAddress: 'replier@x.test', lead: { id: lead.id, stage: 'OUTREACH_SENT' } }

  await recordProcessedReply(args)
  await recordProcessedReply(args) // second run — must not throw on the unique uid

  assert.equal(await prisma.processedEmail.count({ where: { uid: 104 } }), 1)
})
