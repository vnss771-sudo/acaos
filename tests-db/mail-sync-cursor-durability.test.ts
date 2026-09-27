// Database-backed regression test for mailbox-sync cursor durability. The sync
// used to persist lastSyncedUid = max inspected UID BEFORE recording the
// messages it had fetched, so a transient DB failure while recording a real
// reply advanced the cursor past it and the reply was never fetched again.
// The cursor must only move once every fetched message has been durably
// recorded. Drives the real syncMailboxOnce against the real DB with a fake
// IMAP client (no network) and an injectable recordProcessedReply.

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { syncMailboxOnce, recordProcessedReply } from '../packages/backend-core/src/services/mail.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace } from './helpers/db.ts'

const ENV_KEYS = ['IMAP_HOST', 'IMAP_USER', 'IMAP_PASS'] as const
const savedEnv: Record<string, string | undefined> = {}
before(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k]
  process.env.IMAP_HOST = 'imap.acme.test'
  process.env.IMAP_USER = 'sales@acme.test'
  process.env.IMAP_PASS = 'x'
})
after(async () => {
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k] }
  await disconnect()
})
beforeEach(async () => { await resetDb() })

type FakeMsg = { uid: number; from: string; subject: string; text: string; messageId: string }

// Minimal stand-in for imapflow's ImapFlow: serves `messages` for any fetch range
// at/above the requested start UID, records flag updates, never touches the network.
function fakeImap(messages: FakeMsg[]) {
  return class FakeImapFlow {
    mailbox = { uidValidity: 7, uidNext: Math.max(0, ...messages.map(m => m.uid)) + 1, exists: messages.length }
    async connect() {}
    async mailboxOpen() {}
    async *fetch(range: string) {
      const start = Number(range.split(':')[0])
      for (const m of messages) {
        if (m.uid < start) continue
        yield {
          uid: m.uid,
          envelope: { messageId: m.messageId, inReplyTo: null, from: [{ address: m.from }], subject: m.subject },
          source: Buffer.from(`Subject: ${m.subject}\n\n${m.text}`),
        }
      }
    }
    async messageFlagsAdd() {}
    async logout() {}
    close() {}
  }
}

async function cursorOf(workspaceId: string) {
  const row = await prisma.workspaceEmailConfig.findUnique({ where: { workspaceId }, select: { lastSyncedUid: true } })
  return row?.lastSyncedUid ?? null
}

test('a persistence failure leaves the cursor in place, and the next sync records the reply', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await prisma.workspaceEmailConfig.create({ data: { workspaceId: workspace.id, lastSyncedUid: 99, lastUidValidity: 7 } })
  const ImapFlow = fakeImap([
    { uid: 100, from: 'lead@x.test', subject: 'Re: Intro', text: 'Yes, happy to talk next week.', messageId: '<m100@x.test>' },
  ])

  // 1st sync: fetching works, but recording the reply fails (e.g. Postgres blip).
  const failing = (async () => { throw new Error('connection terminated unexpectedly') }) as typeof recordProcessedReply
  await assert.rejects(syncMailboxOnce(null, workspace.id, { ImapFlow, recordProcessedReply: failing }), /connection terminated/)
  assert.equal(await cursorOf(workspace.id), 99, 'cursor must not advance past a message that was not persisted')
  assert.equal(await prisma.processedEmail.count(), 0)

  // 2nd sync: the same UID is fetched again and durably recorded; only now does the cursor move.
  await syncMailboxOnce(null, workspace.id, { ImapFlow })
  const rows = await prisma.processedEmail.findMany({ where: { workspaceId: workspace.id } })
  assert.deepEqual(rows.map(r => r.uid), [100])
  assert.equal(await cursorOf(workspace.id), 100)
})

test('a failure part-way through a batch never skips the unrecorded tail, and re-fetching does not duplicate', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await prisma.workspaceEmailConfig.create({ data: { workspaceId: workspace.id, lastSyncedUid: 99, lastUidValidity: 7 } })
  const ImapFlow = fakeImap([
    { uid: 100, from: 'a@x.test', subject: 'Re: Intro', text: 'Sounds good, send times.', messageId: '<m100@x.test>' },
    { uid: 101, from: 'b@x.test', subject: 'Re: Intro', text: 'Not right now, thanks.', messageId: '<m101@x.test>' },
  ])

  // Record UID 100 for real, then fail on UID 101.
  const failOn101 = (async (p: Parameters<typeof recordProcessedReply>[0]) => {
    if (p.uid === 101) throw new Error('deadlock detected')
    return recordProcessedReply(p)
  }) as typeof recordProcessedReply
  await assert.rejects(syncMailboxOnce(null, workspace.id, { ImapFlow, recordProcessedReply: failOn101 }), /deadlock/)
  assert.equal(await cursorOf(workspace.id), 99)

  await syncMailboxOnce(null, workspace.id, { ImapFlow })
  const uids = (await prisma.processedEmail.findMany({ where: { workspaceId: workspace.id }, orderBy: { uid: 'asc' } })).map(r => r.uid)
  assert.deepEqual(uids, [100, 101], 'UID 101 recovered; UID 100 not recorded twice')
  assert.equal(await cursorOf(workspace.id), 101)
})

test('a clean sync with nothing to record still advances the cursor', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await prisma.workspaceEmailConfig.create({ data: { workspaceId: workspace.id, lastSyncedUid: 99, lastUidValidity: 7 } })
  // Too short to be a reply → inspected but intentionally not recorded.
  const ImapFlow = fakeImap([{ uid: 100, from: 'a@x.test', subject: 'hi', text: 'ok', messageId: '<m100@x.test>' }])

  await syncMailboxOnce(null, workspace.id, { ImapFlow })
  assert.equal(await cursorOf(workspace.id), 100)
})
