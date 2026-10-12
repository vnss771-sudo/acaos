// D2 (database tier): Spam Act 2003 enforcement in the campaign worker, the follow-up
// sender and the consent API. Australian sending is DISABLED by default; these tests
// prove it fails closed, that valid evidence only helps once the flag is explicitly
// on, and that non-Australian workspaces are untouched.

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { sendCampaignBatch } from './helpers/workerJobs.ts'
import { sendFollowupTask } from '../apps/worker/src/processors.ts'
import { workspaceRouter } from '../apps/api/src/routes/workspaces/index.ts'
import { getSendReadiness } from '../apps/api/src/lib/sendReadiness.ts'
import {
  prisma, resetDb, disconnect, seedUserWithWorkspace, allowAutonomousSending,
  startTestServer, bearer, type TestServer,
} from './helpers/db.ts'

let server: TestServer
before(async () => { server = await startTestServer('/api/workspaces', workspaceRouter) })
after(async () => { await server.close(); await disconnect() })
beforeEach(async () => { await resetDb() })

function mailer() {
  const sent: string[] = []
  const fn = async (to: string) => { sent.push(to); return { messageId: `<au-${sent.length}@acaos.test>` } }
  return { fn: fn as unknown as typeof import('../packages/backend-core/src/services/mail.ts').sendMail, sent }
}

async function setup(email: string, ws: Record<string, unknown> = { targetsAustralia: true }) {
  const { user, workspace } = await seedUserWithWorkspace()
  await prisma.workspaceEmailConfig.create({ data: { workspaceId: workspace.id, smtpHost: 'smtp.acme.test', smtpFrom: 'sales@acme.test' } })
  await allowAutonomousSending(workspace.id)
  await prisma.workspace.update({ where: { id: workspace.id }, data: ws })
  const campaign = await prisma.campaign.create({ data: { workspaceId: workspace.id, name: 'AU', goalType: 'BOOK_MEETINGS', autoFollowupsEnabled: true } })
  const lead = await prisma.lead.create({ data: { workspaceId: workspace.id, campaignId: campaign.id, businessName: 'Acme', email, stage: 'RESEARCHED' } })
  await prisma.outreachDraft.create({ data: { leadId: lead.id, workspaceId: workspace.id, subject: 'Hi', emailBody: 'Hello there' } })
  return { user, workspace, campaign, lead }
}

async function withAuFlag<T>(on: boolean, fn: () => Promise<T>): Promise<T> {
  const saved = process.env.AU_COMMERCIAL_SENDING_ENABLED
  if (on) process.env.AU_COMMERCIAL_SENDING_ENABLED = 'true'; else delete process.env.AU_COMMERCIAL_SENDING_ENABLED
  try { return await fn() } finally {
    if (saved === undefined) delete process.env.AU_COMMERCIAL_SENDING_ENABLED; else process.env.AU_COMMERCIAL_SENDING_ENABLED = saved
  }
}

const goodEvidence = (workspaceId: string, emailKey: string) => prisma.consentRecord.create({
  data: {
    workspaceId, emailKey, basis: 'inferred_conspicuous_publication', source: 'manual',
    evidenceUrl: 'https://acme.example/contact', evidenceAt: new Date('2026-09-01'), addressType: 'role',
    optOutStatementAbsent: true, roleRelevant: true,
  },
})

test('campaign: AU workspace is blocked (AU_SENDING_DISABLED) by default, even with valid evidence on file', async () => {
  await withAuFlag(false, async () => {
    const { workspace, campaign } = await setup('a@buyer.test')
    await goodEvidence(workspace.id, 'a@buyer.test')
    const m = mailer()
    const r = await sendCampaignBatch(campaign.id, workspace.id, undefined, undefined, { sendMail: m.fn })
    assert.equal(r.sent, 0)
    assert.deepEqual(m.sent, [])
    assert.equal(r.skippedByReason.AU_SENDING_DISABLED, 1)
  })
})

test('campaign: flag on + no evidence / legitimate_interest / thin evidence → AU_CONSENT_REQUIRED, never sent', async () => {
  await withAuFlag(true, async () => {
    const { workspace, campaign, lead } = await setup('a@buyer.test')
    await prisma.workspace.update({ where: { id: workspace.id }, data: { lawfulBasis: 'legitimate_interest' } })
    await prisma.consentRecord.create({ data: { workspaceId: workspace.id, emailKey: 'a@buyer.test', basis: 'legitimate_interest', source: 'manual' } })
    await prisma.consentRecord.create({ data: { workspaceId: workspace.id, emailKey: 'a@buyer.test', basis: 'inferred_conspicuous_publication', source: 'manual', evidenceUrl: 'https://acme.example/c', evidenceAt: new Date('2026-09-01') } })
    const m = mailer()
    const r = await sendCampaignBatch(campaign.id, workspace.id, undefined, undefined, { sendMail: m.fn })
    assert.equal(r.sent, 0)
    assert.deepEqual(m.sent, [])
    assert.equal(r.skippedByReason.AU_CONSENT_REQUIRED, 1)
    const audit = await prisma.auditEvent.findFirst({ where: { workspaceId: workspace.id, type: 'consent.enforcement.skipped', entityId: lead.id } })
    assert.equal((audit!.metadata as { reason?: string }).reason, 'targets_australia')
  })
})

test('campaign: flag on + complete evidence → the only configuration that sends', async () => {
  await withAuFlag(true, async () => {
    const { workspace, campaign } = await setup('A@Buyer.test')
    await goodEvidence(workspace.id, 'a@buyer.test')
    const m = mailer()
    const r = await sendCampaignBatch(campaign.id, workspace.id, undefined, undefined, { sendMail: m.fn })
    assert.equal(r.sent, 1)
    assert.deepEqual(m.sent, ['A@Buyer.test'])
  })
})

test('follow-up: AU workspace blocked by default, and by missing evidence once the flag is on', async () => {
  const { workspace, campaign, lead } = await setup('f@buyer.test')
  await prisma.outreachSequenceStep.create({ data: { campaignId: campaign.id, stepNumber: 2, delayDays: 3, subject: 'S2', body: 'follow up', isActive: true } })
  const mkTask = () => prisma.followupTask.create({ data: { workspaceId: workspace.id, campaignId: campaign.id, leadId: lead.id, stepNumber: 2, status: 'SCHEDULED', scheduledFor: new Date(Date.now() - 60_000) } })

  const m = mailer()
  const t1 = await mkTask()
  const r1 = await withAuFlag(false, () => sendFollowupTask(t1.id, { sendMail: m.fn }))
  assert.equal(r1.status, 'BLOCKED'); assert.equal(r1.reason, 'AU_SENDING_DISABLED')

  await prisma.followupTask.delete({ where: { id: t1.id } })
  const t2 = await mkTask()
  const r2 = await withAuFlag(true, () => sendFollowupTask(t2.id, { sendMail: m.fn }))
  assert.equal(r2.status, 'BLOCKED'); assert.equal(r2.reason, 'AU_CONSENT_REQUIRED')
  assert.deepEqual(m.sent, [])
  const audit = await prisma.auditEvent.findFirst({ where: { workspaceId: workspace.id, type: 'consent.enforcement.skipped', entityId: lead.id } })
  assert.equal((audit!.metadata as { reason?: string }).reason, 'targets_australia')
})

test('non-AU workspace behaviour is unchanged: sends with no consent record, flag off or on', async () => {
  for (const on of [false, true]) {
    await resetDb()
    await withAuFlag(on, async () => {
      const { workspace, campaign } = await setup('n@buyer.test', { targetsAustralia: false })
      const m = mailer()
      const r = await sendCampaignBatch(campaign.id, workspace.id, undefined, undefined, { sendMail: m.fn })
      assert.equal(r.sent, 1)
      assert.equal(r.skippedByReason.AU_SENDING_DISABLED, 0)
    })
  }
})

test('API: AU-basis consent is rejected without evidence and stored (with hash) when complete; legacy payloads unchanged', async () => {
  const { user, workspace } = await seedUserWithWorkspace('au-api@x.test')
  const post = (body: unknown) => server.request(`/api/workspaces/${workspace.id}/consent`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: bearer(user.id) }, body: JSON.stringify(body),
  })
  const bad = await post({ email: 'p@x.test', basis: 'inferred_conspicuous_publication', source: 'manual', evidenceUrl: 'https://acme.example/c' })
  assert.equal(bad.status, 400)
  assert.match(JSON.stringify(bad.body), /Insufficient Spam Act consent evidence/)
  const liBad = await post({ email: 'p@x.test', basis: 'express', source: 'manual' })
  assert.equal(liBad.status, 400)
  assert.equal(await prisma.consentRecord.count({ where: { workspaceId: workspace.id } }), 0, 'rejected records are never stored')

  const good = await post({
    email: 'P@X.test', basis: 'inferred_conspicuous_publication', source: 'manual', evidenceUrl: 'https://acme.example/contact',
    evidenceAt: '2026-09-01T00:00:00Z', addressType: 'role', optOutStatementAbsent: true, roleRelevant: true,
  })
  assert.equal(good.status, 201, JSON.stringify(good.body))
  const row = await prisma.consentRecord.findFirst({ where: { workspaceId: workspace.id } })
  assert.equal(row!.emailKey, 'p@x.test'); assert.match(row!.evidenceHash ?? '', /^[0-9a-f]{64}$/)

  const legacy = await post({ email: 'l@x.test', basis: 'express_consent', source: 'form' })
  assert.equal(legacy.status, 201)
  const li = await post({ email: 'l2@x.test', basis: 'legitimate_interest', source: 'manual' })
  assert.equal(li.status, 201, 'legitimate_interest is still recordable (ledger), it just never authorises an AU send')
})

test('readiness: an AU workspace is never ready while AU sending is disabled', async () => {
  await withAuFlag(false, async () => {
    const { workspace } = await seedUserWithWorkspace('au-ready@x.test')
    await prisma.workspace.update({ where: { id: workspace.id }, data: { targetsAustralia: true } })
    const r = await getSendReadiness(workspace.id)
    const c = r.checks.find((x) => x.name === 'auCommercialSending')
    assert.ok(c && c.ok === false); assert.equal(r.ready, false)
  })
})
