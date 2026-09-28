// Pre-send message relevance storage + its use as the learning feature.
import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { prisma, resetDb, disconnect, seedUserWithWorkspace } from './helpers/db.ts'
import { recordSendRelevance } from '../packages/backend-core/src/lib/messageRelevance.ts'
import { observeEngagementOutcomes } from '../packages/backend-core/src/lib/engagementObservation.ts'
import { applyReplyAnalysis } from '../apps/worker/src/processors.ts'

after(async () => { await disconnect() })
beforeEach(async () => { await resetDb() })

async function seed(extra: Record<string, unknown> = {}) {
  const { workspace } = await seedUserWithWorkspace()
  const lead = await prisma.lead.create({
    data: { workspaceId: workspace.id, businessName: 'Ironclad', category: 'Engineering', email: 'a@x.test', stage: 'OUTREACH_SENT', score: 60, aiSummary: 'hiring welders' },
  })
  const send = await prisma.outreachSent.create({
    data: { workspaceId: workspace.id, leadId: lead.id, toEmail: 'a@x.test', subject: 'Welders', body: 'Hi Ironclad, you are hiring welders?', status: 'SENT', ...extra },
  })
  return { workspace, lead, send }
}

test('scored once at send time; later research edits never rewrite it', async () => {
  const { lead, send } = await seed()
  const first = await recordSendRelevance(send.id)
  assert.ok(first)
  await prisma.lead.update({ where: { id: lead.id }, data: { aiSummary: 'totally different research', category: 'Retail' } })
  assert.equal(await recordSendRelevance(send.id), null, 'write-once')
  const row = await prisma.outreachSent.findUniqueOrThrow({ where: { id: send.id } })
  assert.equal(row.messageRelevanceScore, first!.score)
  assert.equal(row.messageRelevanceVersion, 1)
})

test('reply learning records the replied-to message\'s stored pre-send score (not a reply-derived value)', async () => {
  const { lead } = await seed({ status: 'REPLIED', repliedAt: new Date(), messageRelevanceScore: 0.37 })
  await applyReplyAnalysis(lead.id, { classification: 'INTERESTED', confidence: 90, isAutoReply: false })
  const sample = await prisma.scoringOutcome.findFirstOrThrow({ where: { leadId: lead.id } })
  assert.equal(sample.replied, true)
  assert.equal(sample.messageRelevance, 0.37)
})

test('NO_RESPONSE learning records the same stored pre-send score', async () => {
  const { lead } = await seed({ sentAt: new Date('2026-01-01T00:00:00Z'), messageRelevanceScore: 0.62 })
  await observeEngagementOutcomes(new Date('2026-02-01T00:00:00Z'))
  const sample = await prisma.scoringOutcome.findFirstOrThrow({ where: { leadId: lead.id } })
  assert.equal(sample.replied, false)
  assert.equal(sample.messageRelevance, 0.62)
})

test('sends from before relevance scoring fall back to the neutral default', async () => {
  const { lead } = await seed({ status: 'REPLIED', repliedAt: new Date() })
  await applyReplyAnalysis(lead.id, { classification: 'INTERESTED', confidence: 90, isAutoReply: false })
  assert.equal((await prisma.scoringOutcome.findFirstOrThrow({ where: { leadId: lead.id } })).messageRelevance, 0.5)
})

test('the eventual reply cannot change the stored relevance: positive vs negative reply, identical score', async () => {
  const a = await seed()
  const b = await seed()
  await recordSendRelevance(a.send.id)
  await recordSendRelevance(b.send.id)
  const before = (id: string) => prisma.outreachSent.findUniqueOrThrow({ where: { id } }).then(r => r.messageRelevanceScore)
  const [sa, sb] = [await before(a.send.id), await before(b.send.id)]
  assert.equal(sa, sb, 'identical inputs → identical score')

  await prisma.outreachSent.update({ where: { id: a.send.id }, data: { status: 'REPLIED', repliedAt: new Date() } })
  await prisma.outreachSent.update({ where: { id: b.send.id }, data: { status: 'REPLIED', repliedAt: new Date() } })
  await applyReplyAnalysis(a.lead.id, { classification: 'INTERESTED', confidence: 95, isAutoReply: false })
  await applyReplyAnalysis(b.lead.id, { classification: 'NOT_INTERESTED', confidence: 95, isAutoReply: false })
  await recordSendRelevance(a.send.id)
  await recordSendRelevance(b.send.id)

  assert.equal(await before(a.send.id), sa)
  assert.equal(await before(b.send.id), sb)
  const samples = await prisma.scoringOutcome.findMany({ where: { leadId: { in: [a.lead.id, b.lead.id] } } })
  assert.equal(new Set(samples.map(x => x.messageRelevance)).size, 1, 'both learning samples carry the same pre-send value')
})
