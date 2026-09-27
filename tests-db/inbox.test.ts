// Database-backed test for GET /api/inbox: returns REPLIED sends with their
// AI-derived reply metadata, supports classification filtering, and is
// tenant-scoped. Exercises the reply-metadata columns added in the Inbox data
// layer end-to-end through a real DB.

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { Router } from 'express'
import { inboxRouter, createInboxReplySendHandler } from '../apps/api/src/routes/inbox.ts'
import { requireAuth, requireVerifiedForMutation } from '../apps/api/src/middleware/auth.ts'
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

// POST /api/inbox/reply/:replyId/send. The route is re-mounted with a stubbed
// sendMail (the handler factory's injection seam) so the full happy path —
// workspace SMTP, threading headers, ledger, idempotency — runs against the real
// DB without an SMTP server.
type SentMail = { to: string; subject: string; html: string; cfg: unknown; opts: { text?: string; headers?: Record<string, string> } | undefined }
let sent: SentMail[] = []
let failNext: (Error & { code?: string; responseCode?: number }) | null = null
// Runs after the provider "accepts" — used to break the DB exactly between SMTP
// acceptance and finalize.
let afterAccept: (() => Promise<void>) | null = null
const stubSendMail = (async (to: string, subject: string, html: string, cfg?: unknown, opts?: SentMail['opts']) => {
  if (failNext) { const e = failNext; failNext = null; throw e }
  sent.push({ to, subject, html, cfg, opts })
  if (afterAccept) { const f = afterAccept; afterAccept = null; await f() }
  return { messageId: `<reply-${sent.length}@acme.test>` }
}) as unknown as NonNullable<Parameters<typeof createInboxReplySendHandler>[0]>['sendMail']

let sendServer: TestServer
before(async () => {
  const r = Router()
  r.use(requireAuth)
  r.use(requireVerifiedForMutation)
  r.post('/reply/:replyId/send', createInboxReplySendHandler({ sendMail: stubSendMail }))
  sendServer = await startTestServer('/api/inbox', r)
})
after(async () => { await sendServer.close() })
beforeEach(async () => { sent = []; failNext = null; afterAccept = null; await dropFailureTriggers() })

// Real DB failures, injected with Postgres triggers (no production seam needed).
async function failWrites(table: 'ContactEvent' | 'InboxReplySend', op: 'INSERT' | 'UPDATE') {
  await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION acaos_test_fail() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$ LANGUAGE plpgsql`)
  await prisma.$executeRawUnsafe(`CREATE TRIGGER "acaos_test_fail_${table}_${op}" BEFORE ${op} ON "${table}" FOR EACH ROW EXECUTE FUNCTION acaos_test_fail()`)
}
async function dropFailureTriggers() {
  for (const t of ['ContactEvent_INSERT', 'InboxReplySend_UPDATE']) {
    const table = t.split('_')[0]
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "acaos_test_fail_${t}" ON "${table}"`)
  }
}
after(async () => { await dropFailureTriggers() })

const OUTCOME_UNKNOWN = /may already have been delivered/i
const IN_FLIGHT = /already being sent/i

async function ageOpenSends(workspaceId: string) {
  await prisma.inboxReplySend.updateMany({ where: { workspaceId, status: 'SENDING' }, data: { attemptedAt: new Date(Date.now() - 10 * 60_000) } })
}

function resolveReq(userId: string, replyId: string, sendId: string, payload: Record<string, unknown>) {
  return server.request(`/api/inbox/reply/${replyId}/sends/${sendId}/resolve`, { method: 'POST', headers: jsonAuth(userId), body: JSON.stringify(payload) })
}

async function withMailbox(workspaceId: string) {
  await prisma.workspaceEmailConfig.create({ data: { workspaceId, smtpHost: 'smtp.acme.test', smtpFrom: 'sales@acme.test' } })
}

function sendReq(userId: string, replyId: string, payload: Record<string, unknown>, srv: TestServer = sendServer) {
  return srv.request(`/api/inbox/reply/${replyId}/send`, { method: 'POST', headers: jsonAuth(userId), body: JSON.stringify(payload) })
}

test('reply/send: sends the user-written body from the workspace mailbox, threaded, with ledger + audit', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  await withMailbox(workspace.id)
  const reply = await seedReply(workspace.id, { messageId: '<orig-1@acme.test>' })
  // The mailbox sync recorded the prospect's reply and matched it to this send.
  await prisma.processedEmail.create({
    data: { workspaceId: workspace.id, uid: 7, messageId: '<prospect-1@lead.test>', fromAddress: 'lead@x.test', matchedOutreachSentId: reply.id },
  })

  const res = await sendReq(user.id, reply.id, { workspaceId: workspace.id, body: 'Does Tuesday at 10 work?\nThanks, Sam', idempotencyKey: 'key-happy-path-1' })
  assert.equal(res.status, 200)
  assert.equal(res.body.success, true)

  assert.equal(sent.length, 1)
  const m = sent[0]
  assert.equal(m.to, 'lead@x.test')
  assert.equal(m.subject, 'Re: Intro')
  // The body is exactly what the user wrote — never the internal suggested action.
  assert.equal(m.opts?.text, 'Does Tuesday at 10 work?\nThanks, Sam')
  assert.equal(m.html, '<div>Does Tuesday at 10 work?<br>Thanks, Sam</div>')
  assert.ok(!m.html.includes('Propose three slots'))
  // Workspace SMTP config, not the platform default.
  assert.equal((m.cfg as { smtpFrom?: string }).smtpFrom, 'sales@acme.test')
  assert.equal(m.opts?.headers?.['In-Reply-To'], '<prospect-1@lead.test>')
  assert.equal(m.opts?.headers?.References, '<orig-1@acme.test> <prospect-1@lead.test>')

  const row = await prisma.inboxReplySend.findFirstOrThrow({ where: { workspaceId: workspace.id } })
  assert.equal(row.status, 'SENT')
  assert.equal(row.messageId, '<reply-1@acme.test>')
  assert.equal(row.actorUserId, user.id)

  const ev = await prisma.contactEvent.findFirstOrThrow({ where: { workspaceId: workspace.id, type: 'SENT' } })
  assert.equal(ev.outreachSentId, reply.id)
  assert.equal(ev.campaignId, null, 'inbox replies must not count as campaign sends')
  assert.ok(await prisma.auditEvent.findFirst({ where: { type: 'inbox.reply_sent', entityId: reply.id } }))
})

test('reply/send: a second reply on the thread references our earlier reply', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  await withMailbox(workspace.id)
  const reply = await seedReply(workspace.id, { messageId: '<orig-2@acme.test>' })

  assert.equal((await sendReq(user.id, reply.id, { workspaceId: workspace.id, body: 'first', idempotencyKey: 'key-thread-a' })).status, 200)
  assert.equal((await sendReq(user.id, reply.id, { workspaceId: workspace.id, body: 'second', idempotencyKey: 'key-thread-b' })).status, 200)
  assert.equal(sent.length, 2)
  assert.equal(sent[1].opts?.headers?.References, '<orig-2@acme.test> <reply-1@acme.test>')
})

test('reply/send: the same idempotency key never sends twice', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  await withMailbox(workspace.id)
  const reply = await seedReply(workspace.id)
  const payload = { workspaceId: workspace.id, body: 'Hi there', idempotencyKey: 'key-double-tap' }

  const [a, b] = await Promise.all([sendReq(user.id, reply.id, payload), sendReq(user.id, reply.id, payload)])
  const statuses = [a.status, b.status].sort()
  // One wins; the racer either sees it in flight (409) or already sent (200 duplicate).
  assert.ok(statuses[0] === 200 && (statuses[1] === 200 || statuses[1] === 409), `got ${statuses}`)
  const retry = await sendReq(user.id, reply.id, payload)
  assert.equal(retry.status, 200)
  assert.equal(retry.body.duplicate, true)
  assert.equal(sent.length, 1)
  assert.equal(await prisma.inboxReplySend.count(), 1)
})

test('reply/send: a failed attempt can be retried with the same key', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  await withMailbox(workspace.id)
  const reply = await seedReply(workspace.id)
  const payload = { workspaceId: workspace.id, body: 'Hi', idempotencyKey: 'key-retry-after-fail' }

  failNext = Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' })
  const first = await sendReq(user.id, reply.id, payload)
  assert.equal(first.status, 503)
  assert.equal((await prisma.inboxReplySend.findFirstOrThrow()).status, 'FAILED')
  assert.equal(await prisma.contactEvent.count(), 0)

  const second = await sendReq(user.id, reply.id, payload)
  assert.equal(second.status, 200)
  assert.equal(sent.length, 1)
  assert.equal((await prisma.inboxReplySend.findFirstOrThrow()).status, 'SENT')
})

// ── Delivery-outcome ambiguity (SMTP accepted, DB did not finalize) ──────────

test('reply/send: SMTP accepted but the finalize transaction failed → still 200, recorded SENT, never re-sent', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  await withMailbox(workspace.id)
  const reply = await seedReply(workspace.id)
  afterAccept = () => failWrites('ContactEvent', 'INSERT')

  const res = await sendReq(user.id, reply.id, { workspaceId: workspace.id, body: 'Hi', idempotencyKey: 'key-finalize-fails' })
  // The email went out; an error here would invite a duplicate retry.
  assert.equal(res.status, 200)
  const row = await prisma.inboxReplySend.findFirstOrThrow()
  assert.equal(row.status, 'SENT', 'fallback status write must still record the send')
  assert.equal(row.messageId, '<reply-1@acme.test>')

  const retry = await sendReq(user.id, reply.id, { workspaceId: workspace.id, body: 'Hi', idempotencyKey: 'key-finalize-fails' })
  assert.equal(retry.body.duplicate, true)
  assert.equal(sent.length, 1)
})

test('reply/send: a reply stuck SENDING after SMTP acceptance blocks new keys until a person resolves it', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  await withMailbox(workspace.id)
  const reply = await seedReply(workspace.id)
  // Every DB write after acceptance fails: the claim can't leave SENDING.
  afterAccept = async () => { await failWrites('ContactEvent', 'INSERT'); await failWrites('InboxReplySend', 'UPDATE') }

  const first = await sendReq(user.id, reply.id, { workspaceId: workspace.id, body: 'Tuesday works', idempotencyKey: 'key-stuck-a' })
  assert.equal(first.status, 200, 'SMTP accepted it — report success, not an error')
  await dropFailureTriggers()
  assert.equal((await prisma.inboxReplySend.findFirstOrThrow()).status, 'SENDING')

  // A new compose session (new key) inside the in-flight window: blocked.
  const soon = await sendReq(user.id, reply.id, { workspaceId: workspace.id, body: 'Tuesday works', idempotencyKey: 'key-stuck-b' })
  assert.equal(soon.status, 409)
  assert.match(soon.body.error, IN_FLIGHT)

  // Past the window the outcome is unknown: still blocked, with guidance.
  await ageOpenSends(workspace.id)
  const later = await sendReq(user.id, reply.id, { workspaceId: workspace.id, body: 'Tuesday works', idempotencyKey: 'key-stuck-c' })
  assert.equal(later.status, 409)
  assert.match(later.body.error, OUTCOME_UNKNOWN)
  assert.equal(sent.length, 1, 'no second physical send, whatever key is used')

  // The inbox surfaces it for resolution.
  const list = await server.request(`/api/inbox?workspaceId=${workspace.id}`, { headers: { Authorization: bearer(user.id) } })
  const pending = list.body.replies[0].pendingSend
  assert.equal(pending.outcomeUnknown, true)
  assert.equal(pending.bodyPreview, 'Tuesday works')

  // The user checks their Sent folder: it went out.
  const resolved = await resolveReq(user.id, reply.id, pending.id, { workspaceId: workspace.id, outcome: 'sent' })
  assert.equal(resolved.status, 200)
  assert.equal((await prisma.inboxReplySend.findUniqueOrThrow({ where: { id: pending.id } })).status, 'SENT')
  assert.equal(await prisma.contactEvent.count({ where: { workspaceId: workspace.id, type: 'SENT' } }), 1)
  assert.ok(await prisma.auditEvent.findFirst({ where: { type: 'inbox.reply_send_resolved', entityId: reply.id } }))

  // Unblocked: a genuinely new reply can go out.
  const next = await sendReq(user.id, reply.id, { workspaceId: workspace.id, body: 'Following up', idempotencyKey: 'key-stuck-d' })
  assert.equal(next.status, 200)
  assert.equal(sent.length, 2)
})

test('reply/resolve: "not sent" frees the thread; an in-flight claim cannot be resolved', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  await withMailbox(workspace.id)
  const reply = await seedReply(workspace.id)
  const open = await prisma.inboxReplySend.create({
    data: { workspaceId: workspace.id, outreachSentId: reply.id, idempotencyKey: 'key-open-1', toEmail: 'lead@x.test', subject: 'Re: Intro', body: 'x' },
  })

  const early = await resolveReq(user.id, reply.id, open.id, { workspaceId: workspace.id, outcome: 'not_sent' })
  assert.equal(early.status, 409, 'a live request may still finish')

  await ageOpenSends(workspace.id)
  const res = await resolveReq(user.id, reply.id, open.id, { workspaceId: workspace.id, outcome: 'not_sent' })
  assert.equal(res.status, 200)
  assert.equal(res.body.status, 'FAILED')
  assert.equal(await prisma.contactEvent.count(), 0, 'not-sent writes no SENT ledger event')
  // Contradicting an existing resolution is refused; repeating it is a no-op.
  assert.equal((await resolveReq(user.id, reply.id, open.id, { workspaceId: workspace.id, outcome: 'sent' })).status, 409)
  assert.equal((await resolveReq(user.id, reply.id, open.id, { workspaceId: workspace.id, outcome: 'not_sent' })).status, 200)

  const send = await sendReq(user.id, reply.id, { workspaceId: workspace.id, body: 'Hi again', idempotencyKey: 'key-open-2' })
  assert.equal(send.status, 200)
  assert.equal(sent.length, 1)
})

test('reply/resolve: tenant-scoped', async () => {
  const a = await seedUserWithWorkspace('a4@x.test')
  const b = await seedUserWithWorkspace('b4@x.test')
  const reply = await seedReply(b.workspace.id)
  const open = await prisma.inboxReplySend.create({
    data: { workspaceId: b.workspace.id, outreachSentId: reply.id, idempotencyKey: 'key-tenant', toEmail: 'lead@x.test', subject: 'Re: Intro', body: 'x', attemptedAt: new Date(0) },
  })
  assert.equal((await resolveReq(a.user.id, reply.id, open.id, { workspaceId: b.workspace.id, outcome: 'sent' })).status, 403)
  assert.equal((await resolveReq(a.user.id, reply.id, open.id, { workspaceId: a.workspace.id, outcome: 'sent' })).status, 404)
  assert.equal((await prisma.inboxReplySend.findUniqueOrThrow({ where: { id: open.id } })).status, 'SENDING')
})

test('reply/send: concurrent sends with DIFFERENT keys on one thread → exactly one goes out', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  await withMailbox(workspace.id)
  const reply = await seedReply(workspace.id)

  // Hold the provider "call" open so every request overlaps the first claim.
  afterAccept = () => new Promise(r => setTimeout(r, 300))
  const results = await Promise.all(['k-par-1', 'k-par-2', 'k-par-3'].map(k =>
    sendReq(user.id, reply.id, { workspaceId: workspace.id, body: 'Hi', idempotencyKey: `key-${k}` })))
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409, 409])
  assert.equal(sent.length, 1)
  assert.equal(await prisma.inboxReplySend.count({ where: { status: 'SENDING' } }), 0)
})

test('reply/send: CR/LF in the stored subject never reaches the header; long subjects are capped', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  await withMailbox(workspace.id)
  const reply = await seedReply(workspace.id, { subject: 'Intro\r\nBcc: victim@evil.test\r\n' + 'x'.repeat(2000) })

  const res = await sendReq(user.id, reply.id, { workspaceId: workspace.id, body: 'hi', idempotencyKey: 'key-crlf-subject' })
  assert.equal(res.status, 200)
  const subject = sent[0].subject
  assert.ok(!/[\r\n]/.test(subject))
  assert.ok(subject.startsWith('Re: Intro Bcc: victim@evil.test'))
  assert.ok(subject.length <= 998)
})

test('reply/send: References stays well-formed over a long thread', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  await withMailbox(workspace.id)
  const reply = await seedReply(workspace.id, { messageId: '<orig-long@acme.test>' })
  for (let i = 0; i < 25; i++) {
    await prisma.processedEmail.create({
      data: { workspaceId: workspace.id, uid: 100 + i, messageId: i === 3 ? 'bad id with spaces' : `<in-${i}@lead.test>`, fromAddress: 'lead@x.test', matchedOutreachSentId: reply.id, processedAt: new Date(Date.now() - (25 - i) * 60_000) },
    })
  }
  const res = await sendReq(user.id, reply.id, { workspaceId: workspace.id, body: 'hi', idempotencyKey: 'key-long-thread' })
  assert.equal(res.status, 200)
  const h = sent[0].opts!.headers!
  const refs = h.References.split(' ')
  assert.equal(refs[0], '<orig-long@acme.test>')
  assert.ok(refs.every(r => /^<[^<>\s]+>$/.test(r)), 'malformed ids dropped')
  assert.equal(new Set(refs).size, refs.length)
  assert.match(h['In-Reply-To'], /^<in-\d+@lead\.test>$/)
})

test('reply/send: requires a non-empty body — there is no fallback copy', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  await withMailbox(workspace.id)
  const reply = await seedReply(workspace.id)

  for (const body of [undefined, '', '   ']) {
    const res = await sendReq(user.id, reply.id, { workspaceId: workspace.id, body, idempotencyKey: 'key-empty-body' })
    assert.equal(res.status, 400)
  }
  const noKey = await sendReq(user.id, reply.id, { workspaceId: workspace.id, body: 'hi' })
  assert.equal(noKey.status, 400)
  assert.equal(sent.length, 0)
})

test('reply/send: refuses to fall back to the platform mailbox when the workspace has none', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const reply = await seedReply(workspace.id)

  const res = await sendReq(user.id, reply.id, { workspaceId: workspace.id, body: 'hi', idempotencyKey: 'key-no-mailbox' })
  assert.equal(res.status, 409)
  assert.match(res.body.error, /mailbox not configured/i)
  assert.equal(sent.length, 0)
  assert.equal(await prisma.inboxReplySend.count(), 0)
})

test('reply/send: blocks a suppressed (unsubscribed) recipient', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  await withMailbox(workspace.id)
  const reply = await seedReply(workspace.id)
  await prisma.suppression.create({ data: { workspaceId: workspace.id, email: 'lead@x.test', emailKey: 'lead@x.test', reason: 'UNSUBSCRIBED' } })

  const res = await sendReq(user.id, reply.id, { workspaceId: workspace.id, body: 'hi', idempotencyKey: 'key-suppressed' })
  assert.equal(res.status, 409)
  assert.match(res.body.error, /unsubscribed|suppressed/i)
  assert.equal(sent.length, 0)
})

test('reply/send: blocks an operator-suspended workspace', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  await withMailbox(workspace.id)
  await prisma.workspace.update({ where: { id: workspace.id }, data: { sendSuppressed: true } })
  const reply = await seedReply(workspace.id)

  const res = await sendReq(user.id, reply.id, { workspaceId: workspace.id, body: 'hi', idempotencyKey: 'key-ws-suspended' })
  assert.equal(res.status, 403)
  assert.equal(sent.length, 0)
})

test('reply/send: a real (cuid) replyId clears param validation (production router)', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const reply = await seedReply(workspace.id)
  // No workspace mailbox → the first guard after validation/lookup answers 409,
  // proving the cuid param was accepted (it used to be rejected as a non-UUID).
  const res = await sendReq(user.id, reply.id, { workspaceId: workspace.id, body: 'hi', idempotencyKey: 'key-cuid-param' }, server)
  assert.equal(res.status, 409)
})

test('reply/send: 404 for a reply that does not exist', async () => {
  const { user, workspace } = await seedUserWithWorkspace()

  const res = await sendReq(user.id, 'nonexistentcuidxxxx', { workspaceId: workspace.id, body: 'hi', idempotencyKey: 'key-missing' })
  assert.equal(res.status, 404)
})

test('reply/send: 403 when the reply belongs to a different workspace', async () => {
  const a = await seedUserWithWorkspace('a2@x.test')
  const b = await seedUserWithWorkspace('b2@x.test')
  await withMailbox(a.workspace.id)
  const reply = await seedReply(b.workspace.id)

  // `a` is a member of their own workspace (passes userBelongsToWorkspace for
  // the body's workspaceId=a.workspace.id) but the reply itself belongs to b.
  const res = await sendReq(a.user.id, reply.id, { workspaceId: a.workspace.id, body: 'hi', idempotencyKey: 'key-cross-tenant' })
  assert.equal(res.status, 403)
  assert.equal(sent.length, 0)
})

test('reply/send: 400 when the reply has not actually received a reply', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  await withMailbox(workspace.id)
  const reply = await seedReply(workspace.id, { status: 'SENT', repliedAt: null })

  const res = await sendReq(user.id, reply.id, { workspaceId: workspace.id, body: 'hi', idempotencyKey: 'key-not-replied' })
  assert.equal(res.status, 400)
  assert.equal(sent.length, 0)
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
