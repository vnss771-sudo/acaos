// DB-tier test: the opt-in domain-warmup ramp clamps the effective send cap in
// sendCampaignBatch. A workspace that just started warming sends only the day-1
// ceiling even though its dailySendLimit is higher; a workspace past the ramp (or
// with no warmup) sends up to its full limit.

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
  const fn = async (to: string) => { sent.push(to); return { messageId: `<w-${sent.length}@acaos.test>` } }
  return { fn: fn as unknown as typeof import('../packages/backend-core/src/services/mail.ts').sendMail, sent }
}
async function seedSmtp(workspaceId: string) {
  await prisma.workspaceEmailConfig.create({ data: { workspaceId, smtpHost: 'smtp.acme.test', smtpFrom: 'sales@acme.test' } })
}
async function seedLeads(workspaceId: string, campaignId: string, n: number) {
  for (let i = 0; i < n; i++) {
    const lead = await prisma.lead.create({ data: { workspaceId, campaignId, businessName: `B${i}`, email: `reach${i}@buyer.test`, stage: 'RESEARCHED' } })
    await prisma.outreachDraft.create({ data: { leadId: lead.id, workspaceId, subject: 'Hi', emailBody: 'Hello there' } })
  }
}

test('warmup day 1: caps sends at the first ramp entry, not the full dailySendLimit', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await seedSmtp(workspace.id)
  setEnv('WARMUP_SCHEDULE', '3,10,50') // day-1 cap = 3
  // High dailySendLimit, but warmup started today → day-1 cap governs.
  await prisma.workspaceICP.create({
    data: { workspaceId: workspace.id, approvalMode: false, dailySendLimit: 50, warmupStartedAt: new Date(),
      targetIndustries: [], targetGeos: [], excludedIndustries: [] },
  })
  const campaign = await prisma.campaign.create({ data: { workspaceId: workspace.id, name: 'C', goalType: 'BOOK_MEETINGS' } })
  await seedLeads(workspace.id, campaign.id, 6)

  const mailer = recordingMailer()
  const result = await sendCampaignBatch(campaign.id, workspace.id, undefined, undefined, { sendMail: mailer.fn, pageSize: 2 })

  assert.equal(result.sent, 3, 'only the day-1 warmup ceiling is dispatched')
  assert.equal(mailer.sent.length, 3)
  // The remainder is tallied as a daily-cap skip (not dropped).
  assert.equal(result.sent + result.skipped + result.failed, 6)
})

test('warmup complete: a workspace past the ramp sends up to its full limit', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await seedSmtp(workspace.id)
  setEnv('WARMUP_SCHEDULE', '3,10,50') // 3-day ramp
  await prisma.workspaceICP.create({
    data: { workspaceId: workspace.id, approvalMode: false, dailySendLimit: 50,
      warmupStartedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000), // 10 days ago → ramp done
      targetIndustries: [], targetGeos: [], excludedIndustries: [] },
  })
  const campaign = await prisma.campaign.create({ data: { workspaceId: workspace.id, name: 'C', goalType: 'BOOK_MEETINGS' } })
  await seedLeads(workspace.id, campaign.id, 5)

  const mailer = recordingMailer()
  const result = await sendCampaignBatch(campaign.id, workspace.id, undefined, undefined, { sendMail: mailer.fn, pageSize: 2 })

  assert.equal(result.sent, 5, 'a completed ramp no longer constrains the cap')
  assert.equal(mailer.sent.length, 5)
})

test('no warmup: unchanged behaviour (full limit applies)', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await seedSmtp(workspace.id)
  setEnv('WARMUP_SCHEDULE', '3,10,50')
  await prisma.workspaceICP.create({
    data: { workspaceId: workspace.id, approvalMode: false, dailySendLimit: 50, warmupStartedAt: null,
      targetIndustries: [], targetGeos: [], excludedIndustries: [] },
  })
  const campaign = await prisma.campaign.create({ data: { workspaceId: workspace.id, name: 'C', goalType: 'BOOK_MEETINGS' } })
  await seedLeads(workspace.id, campaign.id, 5)

  const mailer = recordingMailer()
  const result = await sendCampaignBatch(campaign.id, workspace.id, undefined, undefined, { sendMail: mailer.fn, pageSize: 2 })

  assert.equal(result.sent, 5, 'with no warmupStartedAt the ramp is a no-op')
})
