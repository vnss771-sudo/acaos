// Database-backed test for GET /api/inbox: returns REPLIED sends with their
// AI-derived reply metadata, supports classification filtering, and is
// tenant-scoped. Exercises the reply-metadata columns added in the Inbox data
// layer end-to-end through a real DB.

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { inboxRouter } from '../apps/api/src/routes/inbox.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace, startTestServer, bearer, type TestServer } from './helpers/db.ts'

let server: TestServer
before(async () => { server = await startTestServer('/api/inbox', inboxRouter) })
after(async () => { await server.close(); await disconnect() })
beforeEach(async () => { await resetDb() })

async function seedReply(workspaceId: string, over: Record<string, unknown> = {}) {
  return prisma.outreachSent.create({
    data: {
      workspaceId,
      toEmail: 'lead@x.test',
      subject: 'Intro',
      body: 'b',
      status: 'REPLIED',
      repliedAt: new Date(),
      replyIntent: 'INTERESTED',
      replySummary: 'Wants a call next week',
      replyKeyQuote: 'Let us set up a time',
      replySuggestedAction: 'Propose three slots',
      replyUrgency: 'this_week',
      replyConfidence: 88,
      replyIsAutoReply: false,
      ...over,
    },
  })
}

test('returns replied sends with their AI reply metadata + per-class counts', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  await seedReply(workspace.id)
  await seedReply(workspace.id, { replyIntent: 'NOT_INTERESTED', toEmail: 'no@x.test' })
  // A plain SENT (no reply) must NOT appear.
  await prisma.outreachSent.create({ data: { workspaceId: workspace.id, toEmail: 's@x.test', subject: 's', body: 'b', status: 'SENT' } })

  const res = await server.request(`/api/inbox?workspaceId=${workspace.id}`, { headers: { Authorization: bearer(user.id) } })
  assert.equal(res.status, 200)
  assert.equal(res.body.total, 2)
  assert.equal(res.body.replies.length, 2)
  assert.equal(res.body.counts.INTERESTED, 1)
  assert.equal(res.body.counts.NOT_INTERESTED, 1)
  const interested = res.body.replies.find((r: { replyIntent: string }) => r.replyIntent === 'INTERESTED')
  assert.equal(interested.replySummary, 'Wants a call next week')
  assert.equal(interested.replySuggestedAction, 'Propose three slots')
})

test('filters by classification', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  await seedReply(workspace.id)
  await seedReply(workspace.id, { replyIntent: 'NOT_INTERESTED', toEmail: 'no@x.test' })

  const res = await server.request(`/api/inbox?workspaceId=${workspace.id}&classification=INTERESTED`, { headers: { Authorization: bearer(user.id) } })
  assert.equal(res.status, 200)
  assert.equal(res.body.replies.length, 1)
  assert.equal(res.body.replies[0].replyIntent, 'INTERESTED')
})

test('denies access to a workspace the user does not belong to', async () => {
  const a = await seedUserWithWorkspace('a@x.test')
  const b = await seedUserWithWorkspace('b@x.test')
  await seedReply(b.workspace.id)

  const res = await server.request(`/api/inbox?workspaceId=${b.workspace.id}`, { headers: { Authorization: bearer(a.user.id) } })
  assert.equal(res.status, 403)
})
