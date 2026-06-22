// DB-tier tests for the sender-reputation circuit breaker: the ledger-backed
// evaluateSenderReputation, and the campaign + follow-up send gates in observe vs.
// enforce mode. The guard reads the ContactEvent ledger (SENT/BOUNCED) and
// UnsubscribeEvent (COMPLAINT) over a trailing window. We shrink minSends via env
// so a small seed can trip the threshold, and restore env after each test.

import { test, beforeEach, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateSenderReputation } from '../packages/backend-core/src/lib/senderReputation.ts'
import { sendCampaignBatch, sendFollowupTask } from '../apps/worker/src/processors.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace } from './helpers/db.ts'

after(async () => { await disconnect() })
beforeEach(async () => { await resetDb() })

// Restore any reputation env we touch so tests stay independent.
const savedEnv: Record<string, string | undefined> = {}
function setEnv(key: string, value: string) {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key]
  process.env[key] = value
}
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  for (const k of Object.keys(savedEnv)) delete savedEnv[k]
})

function recordingMailer() {
  const sent: string[] = []
  const fn = async (to: string) => { sent.push(to); return { messageId: `<r-${sent.length}@acaos.test>` } }
  return { fn: fn as unknown as typeof import('../packages/backend-core/src/services/mail.ts').sendMail, sent }
}
async function seedSmtp(workspaceId: string) {
  await prisma.workspaceEmailConfig.create({ data: { workspaceId, smtpHost: 'smtp.acme.test', smtpFrom: 'sales@acme.test' } })
}
async function seedLedger(workspaceId: string, sends: number, bounces: number) {
  const rows = []
  for (let i = 0; i < sends; i++) rows.push({ workspaceId, emailKey: `s${i}@x.test`, type: 'SENT' as const })
  for (let i = 0; i < bounces; i++) rows.push({ workspaceId, emailKey: `b${i}@x.test`, type: 'BOUNCED' as const })
  if (rows.length) await prisma.contactEvent.createMany({ data: rows })
}

test('evaluate: computes trailing bounce rate from the ledger', async () => {
  const { workspace } = await seedUserWithWorkspace()
  setEnv('REPUTATION_MIN_SENDS', '10')
  await seedLedger(workspace.id, 12, 3) // 3/12 = 25% bounce

  const v = await evaluateSenderReputation(workspace.id)
  assert.equal(v.totalSends, 12)
  assert.equal(v.bounces, 3)
  assert.equal(v.healthy, false)
  assert.equal(v.reason, 'BOUNCE_RATE_HIGH')
})

test('evaluate: events older than the window are excluded', async () => {
  const { workspace } = await seedUserWithWorkspace()
  setEnv('REPUTATION_MIN_SENDS', '5')
  setEnv('REPUTATION_WINDOW_DAYS', '7')
  // Old bounces (30 days ago) must not count against a healthy recent window.
  const old = new Date(Date.now() - 30 * 86400000)
  await prisma.contactEvent.createMany({
    data: Array.from({ length: 10 }, (_, i) => ({ workspaceId: workspace.id, emailKey: `old${i}@x.test`, type: 'BOUNCED' as const, occurredAt: old })),
  })
  await seedLedger(workspace.id, 10, 0) // recent: all clean

  const v = await evaluateSenderReputation(workspace.id)
  assert.equal(v.bounces, 0, 'old bounces are outside the window')
  assert.equal(v.healthy, true)
})

test('campaign enforce: a degraded workspace halts the whole batch, no dispatch', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await seedSmtp(workspace.id)
  setEnv('REPUTATION_GUARD_MODE', 'enforce')
  setEnv('REPUTATION_MIN_SENDS', '10')
  await seedLedger(workspace.id, 12, 3) // 25% bounce → unhealthy

  const campaign = await prisma.campaign.create({ data: { workspaceId: workspace.id, name: 'C', goalType: 'BOOK_MEETINGS' } })
  const lead = await prisma.lead.create({ data: { workspaceId: workspace.id, campaignId: campaign.id, businessName: 'Acme', email: 'reach@buyer.test', stage: 'RESEARCHED' } })
  await prisma.outreachDraft.create({ data: { leadId: lead.id, workspaceId: workspace.id, subject: 'Hi', emailBody: 'Hello there' } })

  const mailer = recordingMailer()
  const result = await sendCampaignBatch(campaign.id, workspace.id, undefined, undefined, { sendMail: mailer.fn })

  assert.equal(result.sent, 0)
  assert.equal(result.skippedByReason.REPUTATION_BLOCKED, 1)
  assert.deepEqual(mailer.sent, [], 'a degraded sender must not dispatch in enforce mode')
  assert.equal(await prisma.outreachSent.count({ where: { campaignId: campaign.id } }), 0)
})

test('campaign observe: a degraded workspace still sends (logs only)', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await seedSmtp(workspace.id)
  setEnv('REPUTATION_GUARD_MODE', 'observe')
  setEnv('REPUTATION_MIN_SENDS', '10')
  await seedLedger(workspace.id, 12, 3) // unhealthy, but observe-only

  const campaign = await prisma.campaign.create({ data: { workspaceId: workspace.id, name: 'C', goalType: 'BOOK_MEETINGS' } })
  const lead = await prisma.lead.create({ data: { workspaceId: workspace.id, campaignId: campaign.id, businessName: 'Acme', email: 'reach@buyer.test', stage: 'RESEARCHED' } })
  await prisma.outreachDraft.create({ data: { leadId: lead.id, workspaceId: workspace.id, subject: 'Hi', emailBody: 'Hello there' } })

  const mailer = recordingMailer()
  const result = await sendCampaignBatch(campaign.id, workspace.id, undefined, undefined, { sendMail: mailer.fn })

  assert.equal(result.sent, 1, 'observe mode never blocks')
  assert.equal(result.skippedByReason.REPUTATION_BLOCKED, 0)
  assert.deepEqual(mailer.sent, ['reach@buyer.test'])
})

test('campaign enforce: a healthy/low-volume workspace is not blocked', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await seedSmtp(workspace.id)
  setEnv('REPUTATION_GUARD_MODE', 'enforce')
  setEnv('REPUTATION_MIN_SENDS', '50')
  // Only a few historical sends with a bounce — under minSends, so no signal.
  await seedLedger(workspace.id, 3, 2)

  const campaign = await prisma.campaign.create({ data: { workspaceId: workspace.id, name: 'C', goalType: 'BOOK_MEETINGS' } })
  const lead = await prisma.lead.create({ data: { workspaceId: workspace.id, campaignId: campaign.id, businessName: 'Acme', email: 'reach@buyer.test', stage: 'RESEARCHED' } })
  await prisma.outreachDraft.create({ data: { leadId: lead.id, workspaceId: workspace.id, subject: 'Hi', emailBody: 'Hello there' } })

  const mailer = recordingMailer()
  const result = await sendCampaignBatch(campaign.id, workspace.id, undefined, undefined, { sendMail: mailer.fn })

  assert.equal(result.sent, 1, 'a low-volume workspace is never blocked by noise')
  assert.deepEqual(mailer.sent, ['reach@buyer.test'])
})

test('follow-up enforce: a degraded workspace blocks the follow-up task', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await seedSmtp(workspace.id)
  setEnv('REPUTATION_GUARD_MODE', 'enforce')
  setEnv('REPUTATION_MIN_SENDS', '10')
  await seedLedger(workspace.id, 12, 3)

  const campaign = await prisma.campaign.create({ data: { workspaceId: workspace.id, name: 'Seq', goalType: 'BOOK_MEETINGS', autoFollowupsEnabled: true } })
  await prisma.outreachSequenceStep.create({ data: { campaignId: campaign.id, stepNumber: 2, delayDays: 3, subject: 'S2', body: 'follow', isActive: true } })
  const lead = await prisma.lead.create({ data: { workspaceId: workspace.id, campaignId: campaign.id, businessName: 'Acme', email: 'reach@buyer.test', stage: 'OUTREACH_SENT' } })
  const task = await prisma.followupTask.create({ data: { workspaceId: workspace.id, campaignId: campaign.id, leadId: lead.id, stepNumber: 2, status: 'SCHEDULED', scheduledFor: new Date(Date.now() - 60000) } })

  const mailer = recordingMailer()
  const res = await sendFollowupTask(task.id, { sendMail: mailer.fn })

  assert.equal(res.status, 'BLOCKED')
  assert.equal(res.reason, 'REPUTATION_BLOCKED')
  assert.deepEqual(mailer.sent, [])
  const after = await prisma.followupTask.findUnique({ where: { id: task.id } })
  assert.equal(after!.status, 'BLOCKED')
})
