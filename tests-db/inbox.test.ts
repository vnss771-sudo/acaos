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

function jsonAuth(userId: string) {
  return { Authorization: bearer(userId), 'Content-Type': 'application/json' }
}

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

// POST /api/inbox/reply/:replyId/send. No SMTP_HOST/SMTP_FROM is configured in
// the test environment, so a request that clears every other guard reaches
// "Email service not configured" (503) rather than actually sending — which is
// itself the regression test for the real bug this fixed: OutreachSent.id is a
// Prisma cuid(), not a UUID, and the route param schema used to reject every
// real id with a 400 before any of these checks ran at all.
test('reply/send: a real (cuid) replyId clears param validation and reaches the mail-configured check', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const reply = await seedReply(workspace.id)

  const res = await server.request(`/api/inbox/reply/${reply.id}/send`, {
    method: 'POST',
    headers: jsonAuth(user.id),
    body: JSON.stringify({ workspaceId: workspace.id }),
  })
  assert.equal(res.status, 503)
  assert.match(res.body.error, /not configured/i)
})

test('reply/send: 404 for a reply that does not exist', async () => {
  const { user, workspace } = await seedUserWithWorkspace()

  const res = await server.request(`/api/inbox/reply/nonexistentcuidxxxx/send`, {
    method: 'POST',
    headers: jsonAuth(user.id),
    body: JSON.stringify({ workspaceId: workspace.id }),
  })
  assert.equal(res.status, 404)
})

test('reply/send: 403 when the reply belongs to a different workspace', async () => {
  const a = await seedUserWithWorkspace('a2@x.test')
  const b = await seedUserWithWorkspace('b2@x.test')
  const reply = await seedReply(b.workspace.id)

  // `a` is a member of their own workspace (passes userBelongsToWorkspace for
  // the body's workspaceId=a.workspace.id) but the reply itself belongs to b.
  const res = await server.request(`/api/inbox/reply/${reply.id}/send`, {
    method: 'POST',
    headers: jsonAuth(a.user.id),
    body: JSON.stringify({ workspaceId: a.workspace.id }),
  })
  assert.equal(res.status, 403)
})

test('reply/send: 400 when the reply has not actually received a reply', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const reply = await seedReply(workspace.id, { status: 'SENT', repliedAt: null })

  const res = await server.request(`/api/inbox/reply/${reply.id}/send`, {
    method: 'POST',
    headers: jsonAuth(user.id),
    body: JSON.stringify({ workspaceId: workspace.id }),
  })
  assert.equal(res.status, 400)
})

// PATCH /api/inbox/reply/:replyId/feedback — no mail dependency, so the full
// round trip (including the audit trail the learning loop reads) is testable.
test('reply/feedback: records correct/incorrect/unsure feedback with an audit trail', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const reply = await seedReply(workspace.id)

  const res = await server.request(`/api/inbox/reply/${reply.id}/feedback`, {
    method: 'PATCH',
    headers: jsonAuth(user.id),
    body: JSON.stringify({ workspaceId: workspace.id, feedback: 'incorrect', correctedIntent: 'NOT_INTERESTED' }),
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.success, true)

  const event = await prisma.auditEvent.findFirst({
    where: { type: 'inbox.classification_feedback', entityId: reply.id },
  })
  assert.ok(event, 'expected an audit event for the feedback')
  const metadata = event!.metadata as Record<string, unknown>
  assert.equal(metadata.feedback, 'incorrect')
  assert.equal(metadata.correctedIntent, 'NOT_INTERESTED')
  assert.equal(metadata.originalIntent, 'INTERESTED')
})

test('reply/feedback: 404 for a reply that does not exist', async () => {
  const { user, workspace } = await seedUserWithWorkspace()

  const res = await server.request(`/api/inbox/reply/nonexistentcuidxxxx/feedback`, {
    method: 'PATCH',
    headers: jsonAuth(user.id),
    body: JSON.stringify({ workspaceId: workspace.id, feedback: 'correct' }),
  })
  assert.equal(res.status, 404)
})

test('reply/feedback: 403 when the reply belongs to a different workspace', async () => {
  const a = await seedUserWithWorkspace('a3@x.test')
  const b = await seedUserWithWorkspace('b3@x.test')
  const reply = await seedReply(b.workspace.id)

  const res = await server.request(`/api/inbox/reply/${reply.id}/feedback`, {
    method: 'PATCH',
    headers: jsonAuth(a.user.id),
    body: JSON.stringify({ workspaceId: a.workspace.id, feedback: 'correct' }),
  })
  assert.equal(res.status, 403)
})
