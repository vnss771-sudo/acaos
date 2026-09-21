// DB-tier test: per-domain send pacing clamps sends to a single recipient domain
// in sendCampaignBatch. Opt-in via PER_DOMAIN_DAILY_CAP; disabled → unchanged.

import { test, beforeEach, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { sendCampaignBatch, sendFollowupTask } from '../apps/worker/src/processors.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace } from './helpers/db.ts'

after(async () => { await disconnect() })
beforeEach(async () => { await resetDb() })

const savedEnv: Record<string, string | undefined> = {}
function setEnv(k: string, v: string) { if (!(k in savedEnv)) savedEnv[k] = process.env[k]; process.env[k] = v }
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  for (const k of Object.keys(savedEnv)) delete savedEnv[k]
})

function recordingMailer() {
  const sent: string[] = []
  const fn = async (to: string) => { sent.push(to); return { messageId: `<p-${sent.length}@acaos.test>` } }
  return { fn: fn as unknown as typeof import('../packages/backend-core/src/services/mail.ts').sendMail, sent }
}
async function seedSmtp(workspaceId: string) {
  await prisma.workspaceEmailConfig.create({ data: { workspaceId, smtpHost: 'smtp.acme.test', smtpFrom: 'sales@acme.test' } })
}
async function seedLead(workspaceId: string, campaignId: string, email: string) {
  const lead = await prisma.lead.create({ data: { workspaceId, campaignId, businessName: 'B', email, stage: 'RESEARCHED' } })
  await prisma.outreachDraft.create({ data: { leadId: lead.id, workspaceId, subject: 'Hi', emailBody: 'Hello there' } })
}

test('per-domain cap: only the cap-worth of one domain sends; other domains unaffected', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await seedSmtp(workspace.id)
  setEnv('PER_DOMAIN_DAILY_CAP', '2')
  const campaign = await prisma.campaign.create({ data: { workspaceId: workspace.id, name: 'C', goalType: 'BOOK_MEETINGS' } })
  // 4 gmail recipients + 1 outlook.
  for (let i = 0; i < 4; i++) await seedLead(workspace.id, campaign.id, `g${i}@gmail.com`)
  await seedLead(workspace.id, campaign.id, 'one@outlook.com')

  const mailer = recordingMailer()
  const result = await sendCampaignBatch(campaign.id, workspace.id, undefined, undefined, { sendMail: mailer.fn })

  // 2 gmail (the cap) + 1 outlook = 3 sent; 2 gmail paced.
  assert.equal(result.sent, 3)
  assert.equal(result.skippedByReason.DOMAIN_PACED, 2)
  assert.equal(mailer.sent.filter(e => e.endsWith('@gmail.com')).length, 2)
  assert.equal(mailer.sent.filter(e => e.endsWith('@outlook.com')).length, 1)
})

test('per-domain cap: counts sends already made today toward the cap', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await seedSmtp(workspace.id)
  setEnv('PER_DOMAIN_DAILY_CAP', '2')
  const campaign = await prisma.campaign.create({ data: { workspaceId: workspace.id, name: 'C', goalType: 'BOOK_MEETINGS' } })
  // Two gmail sends already went out today (a prior run). Real sends carry
  // toEmailDomain (set at claim time / backfilled), which the indexed seed reads.
  for (let i = 0; i < 2; i++) {
    await prisma.outreachSent.create({ data: { workspaceId: workspace.id, campaignId: campaign.id, toEmail: `prior${i}@gmail.com`, toEmailDomain: 'gmail.com', subject: 'Hi', body: 'x', status: 'SENT', sentAt: new Date() } })
  }
  await seedLead(workspace.id, campaign.id, 'new@gmail.com')

  const mailer = recordingMailer()
  const result = await sendCampaignBatch(campaign.id, workspace.id, undefined, undefined, { sendMail: mailer.fn })

  assert.equal(result.sent, 0, 'the domain already hit its cap today')
  assert.equal(result.skippedByReason.DOMAIN_PACED, 1)
  assert.deepEqual(mailer.sent, [])
})

test('claim persists toEmailDomain so pacing reads an indexed aggregate', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await seedSmtp(workspace.id)
  const campaign = await prisma.campaign.create({ data: { workspaceId: workspace.id, name: 'C', goalType: 'BOOK_MEETINGS' } })
  await seedLead(workspace.id, campaign.id, 'Reach@Gmail.com')

  const mailer = recordingMailer()
  await sendCampaignBatch(campaign.id, workspace.id, undefined, undefined, { sendMail: mailer.fn })

  const send = await prisma.outreachSent.findFirst({ where: { campaignId: campaign.id } })
  assert.equal(send!.toEmailDomain, 'gmail.com', 'domain is extracted + lowercased at claim time')
})

test('per-domain cap holds under concurrency: two batches racing the same domain never collectively exceed it', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await seedSmtp(workspace.id)
  setEnv('PER_DOMAIN_DAILY_CAP', '2')
  // Two separate campaigns (e.g. one launched while a follow-up scan is mid-run)
  // sending to the same recipient domain concurrently — the scenario the
  // in-memory-only pre-check couldn't protect against; only the advisory-locked
  // reserveDomainSendSlot inside the claim transaction can.
  const campaignA = await prisma.campaign.create({ data: { workspaceId: workspace.id, name: 'A', goalType: 'BOOK_MEETINGS' } })
  const campaignB = await prisma.campaign.create({ data: { workspaceId: workspace.id, name: 'B', goalType: 'BOOK_MEETINGS' } })
  for (let i = 0; i < 3; i++) await seedLead(workspace.id, campaignA.id, `a${i}@gmail.com`)
  for (let i = 0; i < 3; i++) await seedLead(workspace.id, campaignB.id, `b${i}@gmail.com`)

  const mailer = recordingMailer()
  const [resultA, resultB] = await Promise.all([
    sendCampaignBatch(campaignA.id, workspace.id, undefined, undefined, { sendMail: mailer.fn }),
    sendCampaignBatch(campaignB.id, workspace.id, undefined, undefined, { sendMail: mailer.fn }),
  ])

  assert.equal(resultA.sent + resultB.sent, 2, 'the two concurrent batches collectively respect the cap, not 2 each')
  const totalGmailSent = await prisma.outreachSent.count({ where: { workspaceId: workspace.id, toEmailDomain: 'gmail.com', status: { in: ['SENT', 'SENDING'] } } })
  assert.equal(totalGmailSent, 2)
})

async function seedFollowupCampaign(workspaceId: string) {
  return prisma.campaign.create({ data: { workspaceId, name: 'Seq', goalType: 'BOOK_MEETINGS', autoFollowupsEnabled: true } })
}
async function seedFollowupStep(campaignId: string, stepNumber: number) {
  return prisma.outreachSequenceStep.create({ data: { campaignId, stepNumber, delayDays: 3, subject: `Step ${stepNumber}`, body: `follow up ${stepNumber}` } })
}
async function seedFollowupLead(workspaceId: string, campaignId: string, email: string) {
  return prisma.lead.create({ data: { workspaceId, campaignId, businessName: 'B', email, stage: 'OUTREACH_SENT' } })
}
async function seedDueTask(workspaceId: string, campaignId: string, leadId: string, stepNumber = 2) {
  return prisma.followupTask.create({
    data: { workspaceId, campaignId, leadId, stepNumber, status: 'SCHEDULED', scheduledFor: new Date(Date.now() - 60_000) },
  })
}

test('per-domain cap: a due follow-up whose domain already hit the cap defers (pre-check)', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await seedSmtp(workspace.id)
  setEnv('PER_DOMAIN_DAILY_CAP', '1')
  const campaign = await seedFollowupCampaign(workspace.id)
  await seedFollowupStep(campaign.id, 2)
  // The domain already sent its cap-worth today.
  await prisma.outreachSent.create({ data: { workspaceId: workspace.id, campaignId: campaign.id, toEmail: 'prior@gmail.com', toEmailDomain: 'gmail.com', subject: 'Hi', body: 'x', status: 'SENT', sentAt: new Date() } })
  const lead = await seedFollowupLead(workspace.id, campaign.id, 'new@gmail.com')
  const task = await seedDueTask(workspace.id, campaign.id, lead.id, 2)

  const mailer = recordingMailer()
  const res = await sendFollowupTask(task.id, { sendMail: mailer.fn })

  assert.equal(res.status, 'SKIPPED')
  assert.equal(res.reason, 'DOMAIN_PACED')
  assert.deepEqual(mailer.sent, [])
  const after = await prisma.followupTask.findUnique({ where: { id: task.id } })
  assert.equal(after!.status, 'SCHEDULED', 'parked back to retry on a later scan')
})

test('per-domain cap: a follow-up racing a concurrent claim for the same domain is caught by the transaction recheck', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await seedSmtp(workspace.id)
  setEnv('PER_DOMAIN_DAILY_CAP', '1')
  const campaign = await seedFollowupCampaign(workspace.id)
  await seedFollowupStep(campaign.id, 2)
  // Nothing sent yet today, so both tasks pass the in-memory pre-check;
  // only the advisory-locked reserveDomainSendSlot inside the claim
  // transaction can stop the second one from also sending.
  const leadA = await seedFollowupLead(workspace.id, campaign.id, 'a@gmail.com')
  const leadB = await seedFollowupLead(workspace.id, campaign.id, 'b@gmail.com')
  const taskA = await seedDueTask(workspace.id, campaign.id, leadA.id, 2)
  const taskB = await seedDueTask(workspace.id, campaign.id, leadB.id, 2)

  const mailer = recordingMailer()
  const [resA, resB] = await Promise.all([
    sendFollowupTask(taskA.id, { sendMail: mailer.fn }),
    sendFollowupTask(taskB.id, { sendMail: mailer.fn }),
  ])

  const statuses = [resA.status, resB.status].sort()
  assert.deepEqual(statuses, ['SENT', 'SKIPPED'])
  const skipped = resA.status === 'SKIPPED' ? resA : resB
  assert.equal(skipped.reason, 'DOMAIN_PACED')
  const totalGmailSent = await prisma.outreachSent.count({ where: { workspaceId: workspace.id, toEmailDomain: 'gmail.com', status: { in: ['SENT', 'SENDING'] } } })
  assert.equal(totalGmailSent, 1)
})

test('disabled by default: no cap env → all send (unchanged behaviour)', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await seedSmtp(workspace.id)
  // PER_DOMAIN_DAILY_CAP not set.
  const campaign = await prisma.campaign.create({ data: { workspaceId: workspace.id, name: 'C', goalType: 'BOOK_MEETINGS' } })
  for (let i = 0; i < 4; i++) await seedLead(workspace.id, campaign.id, `g${i}@gmail.com`)

  const mailer = recordingMailer()
  const result = await sendCampaignBatch(campaign.id, workspace.id, undefined, undefined, { sendMail: mailer.fn })

  assert.equal(result.sent, 4)
  assert.equal(result.skippedByReason.DOMAIN_PACED, 0)
})
