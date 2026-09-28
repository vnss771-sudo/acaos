// Engagement observation windows (lib/engagementObservation.ts) against real
// Postgres: classification, idempotency, late replies, learning consumption.

import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { prisma, resetDb, disconnect, seedUserWithWorkspace } from './helpers/db.ts'
import { observeEngagementOutcomes, noResponseAfterDays } from '../packages/backend-core/src/lib/engagementObservation.ts'

after(async () => { await disconnect() })
beforeEach(async () => { await resetDb(); delete process.env.NO_RESPONSE_AFTER_DAYS })

const DAY = 86_400_000
const T0 = new Date('2026-09-01T00:00:00Z')
const day = (n: number) => new Date(T0.getTime() + n * DAY)

let n = 0
async function seedSend(workspaceId: string, extra: Record<string, unknown> = {}) {
  const email = `p${++n}@x.test`
  const lead = await prisma.lead.create({ data: { workspaceId, businessName: 'Acme', email, stage: 'OUTREACH_SENT', score: 60 } })
  const send = await prisma.outreachSent.create({
    data: { workspaceId, leadId: lead.id, toEmail: email, subject: 's', body: 'b', status: 'SENT', sentAt: T0, ...extra },
  })
  return { lead, send, email }
}
const reload = (id: string) => prisma.outreachSent.findUniqueOrThrow({ where: { id } })

test('the observation window is configurable and validated', () => {
  assert.equal(noResponseAfterDays(), 21)
  process.env.NO_RESPONSE_AFTER_DAYS = '7'
  assert.equal(noResponseAfterDays(), 7)
  process.env.NO_RESPONSE_AFTER_DAYS = '0'
  assert.equal(noResponseAfterDays(), 21)
})

test('nothing is classified before the window closes', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const { send } = await seedSend(workspace.id)
  assert.equal((await observeEngagementOutcomes(day(20))).observed, 0)
  assert.equal((await reload(send.id)).engagementOutcome, null)
})

test('day 0 sent → day 10 opened → day 21 NO_RESPONSE → day 25 reply: both facts are kept', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const { send, email } = await seedSend(workspace.id)
  // Day 10: an open (not a response) is on the ledger.
  await prisma.contactEvent.create({ data: { workspaceId: workspace.id, emailKey: email, outreachSentId: send.id, type: 'OPENED', occurredAt: day(10) } })

  await observeEngagementOutcomes(day(21))
  let row = await reload(send.id)
  assert.equal(row.engagementOutcome, 'NO_RESPONSE', 'an open is not a response')
  assert.equal(row.observationWindowDays, 21)
  assert.deepEqual(row.observationDueAt, day(21))
  assert.deepEqual(row.observedAt, day(21))
  assert.deepEqual(row.sentAt, T0)

  // Day 25: the reply arrives (as mail.ts records it) and the sweep runs again.
  await prisma.outreachSent.update({ where: { id: send.id }, data: { status: 'REPLIED', repliedAt: day(25) } })
  await observeEngagementOutcomes(day(26))
  row = await reload(send.id)
  assert.equal(row.engagementOutcome, 'NO_RESPONSE', 'the historical observation is not rewritten')
  assert.deepEqual(row.repliedAt, day(25), 'the later reply is retained as a subsequent event')
  assert.ok(row.repliedAt! > row.observationDueAt!, 'response latency is recoverable')
})

test('classification: reply in window, bounce, unsubscribe, complaint', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const replied = await seedSend(workspace.id, { status: 'REPLIED', repliedAt: day(3) })
  const bouncedStatus = await seedSend(workspace.id, { status: 'BOUNCED' })
  const bouncedEvent = await seedSend(workspace.id)
  await prisma.contactEvent.create({ data: { workspaceId: workspace.id, emailKey: bouncedEvent.email, type: 'BOUNCED', occurredAt: day(0) } })
  const unsub = await seedSend(workspace.id)
  await prisma.unsubscribeEvent.create({ data: { workspaceId: workspace.id, emailKey: unsub.email, source: 'LINK', occurredAt: day(2) } })
  const complaint = await seedSend(workspace.id)
  await prisma.unsubscribeEvent.create({ data: { workspaceId: workspace.id, emailKey: complaint.email, source: 'COMPLAINT', occurredAt: day(1) } })
  const failed = await seedSend(workspace.id, { status: 'FAILED' })

  await observeEngagementOutcomes(day(22))
  assert.equal((await reload(replied.send.id)).engagementOutcome, 'REPLIED')
  assert.equal((await reload(bouncedStatus.send.id)).engagementOutcome, 'BOUNCED', 'bounce is not NO_RESPONSE')
  assert.equal((await reload(bouncedEvent.send.id)).engagementOutcome, 'BOUNCED')
  assert.equal((await reload(unsub.send.id)).engagementOutcome, 'UNSUBSCRIBED', 'unsubscribe is not NO_RESPONSE')
  assert.equal((await reload(complaint.send.id)).engagementOutcome, 'COMPLAINT')
  assert.equal((await reload(failed.send.id)).engagementOutcome, null, 'undelivered sends are never observed')
})

test('events outside the window do not count (an unsubscribe on day 30 leaves NO_RESPONSE)', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const s = await seedSend(workspace.id)
  await prisma.unsubscribeEvent.create({ data: { workspaceId: workspace.id, emailKey: s.email, source: 'LINK', occurredAt: day(30) } })
  await observeEngagementOutcomes(day(31))
  assert.equal((await reload(s.send.id)).engagementOutcome, 'NO_RESPONSE')
})

test('idempotent: repeated and concurrent runs classify once and learn once', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const { send } = await seedSend(workspace.id)
  const runs = await Promise.all([observeEngagementOutcomes(day(22)), observeEngagementOutcomes(day(22))])
  await observeEngagementOutcomes(day(40))
  assert.equal(runs[0].observed + runs[1].observed, 1)
  assert.equal((await reload(send.id)).engagementOutcome, 'NO_RESPONSE')
  assert.equal(await prisma.scoringOutcome.count({ where: { workspaceId: workspace.id } }), 1)
})

test('learning consumes NO_RESPONSE / UNSUBSCRIBED / COMPLAINT as not-replied, never BOUNCED', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await seedSend(workspace.id)
  const u = await seedSend(workspace.id)
  await prisma.unsubscribeEvent.create({ data: { workspaceId: workspace.id, emailKey: u.email, source: 'ONE_CLICK', occurredAt: day(1) } })
  await seedSend(workspace.id, { status: 'BOUNCED' })
  await seedSend(workspace.id, { status: 'REPLIED', repliedAt: day(2) })

  await observeEngagementOutcomes(day(22))
  const samples = await prisma.scoringOutcome.findMany({ where: { workspaceId: workspace.id } })
  assert.deepEqual(samples.map(s => s.replyIntent).sort(), ['NO_RESPONSE', 'UNSUBSCRIBED'])
  assert.ok(samples.every(s => s.replied === false && s.messageRelevance === 0.5))
})

test('a shorter configured window closes sooner', async () => {
  process.env.NO_RESPONSE_AFTER_DAYS = '7'
  const { workspace } = await seedUserWithWorkspace()
  const { send } = await seedSend(workspace.id)
  await observeEngagementOutcomes(day(8))
  const row = await reload(send.id)
  assert.equal(row.engagementOutcome, 'NO_RESPONSE')
  assert.equal(row.observationWindowDays, 7)
})

test('a lagging sweep still judges by the window: reply on day 23, first sweep on day 24 → NO_RESPONSE', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const { send } = await seedSend(workspace.id, { status: 'REPLIED', repliedAt: day(23) })
  await observeEngagementOutcomes(day(24))
  const row = await reload(send.id)
  assert.equal(row.engagementOutcome, 'NO_RESPONSE', 'the reply came after the window closed')
  assert.deepEqual(row.repliedAt, day(23))
})
