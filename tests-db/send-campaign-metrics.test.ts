// DB-tier test that the send-outcome metric is wired end-to-end into the real
// sendCampaignBatch path — not just that the counter renders in isolation (that's
// covered by tests/worker-metrics.test.ts). The send pipeline enforces the
// cap/policy/AI-limit invariants but previously only logged them; this proves the
// `acaos_send_outcomes_total` counter actually reflects what a batch did, so an
// operator can see WHY leads didn't send without log-diving.
//
// Runs against a live DB with the mailer + generator injected via the deps seam.

import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { sendCampaignBatch } from '../apps/worker/src/processors.ts'
import { resetWorkerMetrics, renderWorkerMetrics } from '../apps/worker/src/lib/metrics.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace } from './helpers/db.ts'

after(async () => { await disconnect() })
beforeEach(async () => { await resetDb(); resetWorkerMetrics() })

function recordingMailer() {
  const sent: string[] = []
  const fn = async (to: string) => {
    sent.push(to)
    return { messageId: `<test-${sent.length}@acaos.test>` }
  }
  return { fn: fn as unknown as typeof import('../packages/backend-core/src/services/mail.ts').sendMail, sent }
}

type GenFn = typeof import('../packages/backend-core/src/services/openai.ts').generateOutreach
function gen(impl: () => string): GenFn {
  return (async () => impl()) as unknown as GenFn
}

async function seedSmtp(workspaceId: string) {
  await prisma.workspaceEmailConfig.create({
    data: { workspaceId, smtpHost: 'smtp.acme.test', smtpFrom: 'sales@acme.test' },
  })
}
async function seedCampaign(workspaceId: string) {
  return prisma.campaign.create({ data: { workspaceId, name: 'Q3 Outreach', goalType: 'BOOK_MEETINGS' } })
}
async function seedDraftlessLead(workspaceId: string, campaignId: string, email: string) {
  return prisma.lead.create({ data: { workspaceId, campaignId, businessName: 'Acme', email, stage: 'RESEARCHED' } })
}

test('send-outcome metric reflects a real batch: one sent, one parked POLICY_REVIEW', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await seedSmtp(workspace.id)
  const campaign = await seedCampaign(workspace.id)
  // Lead A: a valid, policy-clean draft is generated → sent.
  await seedDraftlessLead(workspace.id, campaign.id, 'a@buyer.test')
  // Lead B: copy too short for the 30-char body minimum → parked POLICY_REVIEW.
  await seedDraftlessLead(workspace.id, campaign.id, 'b@buyer.test')

  let n = 0
  const mailer = recordingMailer()
  const result = await sendCampaignBatch(campaign.id, workspace.id, undefined, undefined, {
    sendMail: mailer.fn,
    // First lead clears policy; second trips BODY_TOO_SHORT.
    generateOutreach: gen(() => (++n === 1)
      ? JSON.stringify({ subject: 'Quick intro for Acme', email: 'Hi there — we help teams like Acme ship outreach faster. Worth a quick chat?' })
      : JSON.stringify({ subject: 'Hello again', email: 'Too short.' })),
  })

  // Sanity: the batch did what we set up (the metric must mirror exactly this).
  assert.equal(result.sent, 1)
  assert.equal(result.skippedByReason.POLICY_REVIEW, 1)

  const out = renderWorkerMetrics()
  assert.match(out, /acaos_send_outcomes_total\{queue="send-campaign",outcome="sent"\} 1/)
  assert.match(out, /acaos_send_outcomes_total\{queue="send-campaign",outcome="POLICY_REVIEW"\} 1/)
})
