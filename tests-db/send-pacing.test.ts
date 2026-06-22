// DB-tier test: per-domain send pacing clamps sends to a single recipient domain
// in sendCampaignBatch. Opt-in via PER_DOMAIN_DAILY_CAP; disabled → unchanged.

import { test, beforeEach, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { sendCampaignBatch } from '../apps/worker/src/processors.ts'
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
  // Two gmail sends already went out today (a prior run).
  for (let i = 0; i < 2; i++) {
    await prisma.outreachSent.create({ data: { workspaceId: workspace.id, campaignId: campaign.id, toEmail: `prior${i}@gmail.com`, subject: 'Hi', body: 'x', status: 'SENT', sentAt: new Date() } })
  }
  await seedLead(workspace.id, campaign.id, 'new@gmail.com')

  const mailer = recordingMailer()
  const result = await sendCampaignBatch(campaign.id, workspace.id, undefined, undefined, { sendMail: mailer.fn })

  assert.equal(result.sent, 0, 'the domain already hit its cap today')
  assert.equal(result.skippedByReason.DOMAIN_PACED, 1)
  assert.deepEqual(mailer.sent, [])
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
