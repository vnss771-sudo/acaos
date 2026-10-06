// Database-backed behavioral tests for sendCampaignBatch — the most
// safety-critical worker path (SMTP dispatch, suppression, outbox idempotency,
// fail-closed claims, mission-stop). Previously covered only by static
// source-grep gates (operational-chaos-safety-gates.test.ts), which pass even
// when the behavior is broken. These exercise the real logic against a live DB
// with a stubbed mailer (injected via the deps seam) so no real SMTP is needed.

import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { sendCampaignBatch } from './helpers/workerJobs.ts'
import { suppress } from '../packages/backend-core/src/lib/suppressions.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace } from './helpers/db.ts'

after(async () => { await disconnect() })
beforeEach(async () => { await resetDb() })

// A mailer stub that records every recipient and (optionally) throws to
// simulate an SMTP rejection. Shape matches services/mail.ts `sendMail`.
function recordingMailer(opts: { throwOn?: (to: string) => boolean } = {}) {
  const sent: string[] = []
  const fn = async (to: string, _subject: string, _html: string) => {
    sent.push(to)
    if (opts.throwOn?.(to)) throw new Error('550 mailbox unavailable')
    return { messageId: `<test-${sent.length}@acaos.test>` }
  }
  return { fn: fn as unknown as typeof import('../packages/backend-core/src/services/mail.ts').sendMail, sent }
}

async function seedCampaign(workspaceId: string) {
  return prisma.campaign.create({
    data: { workspaceId, name: 'Q3 Outreach', goalType: 'BOOK_MEETINGS' },
  })
}

// A lead that is ready to send: has an email, an eligible stage, and a draft
// (so the AI-generation branch is never taken).
async function seedSendableLead(
  workspaceId: string,
  campaignId: string,
  email: string,
) {
  const lead = await prisma.lead.create({
    data: { workspaceId, campaignId, businessName: 'Acme', email, stage: 'RESEARCHED' },
  })
  await prisma.outreachDraft.create({
    data: { leadId: lead.id, workspaceId, subject: 'Hi', emailBody: 'Hello there' },
  })
  return lead
}

async function seedSmtp(workspaceId: string) {
  await prisma.workspaceEmailConfig.create({
    data: { workspaceId, smtpHost: 'smtp.acme.test', smtpFrom: 'sales@acme.test' },
  })
}

test('skips suppressed addresses — never dispatches, never records a send', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await seedSmtp(workspace.id)
  const campaign = await seedCampaign(workspace.id)
  const good = await seedSendableLead(workspace.id, campaign.id, 'reach@buyer.test')
  const blocked = await seedSendableLead(workspace.id, campaign.id, 'stop@buyer.test')
  await suppress(workspace.id, 'stop@buyer.test', 'UNSUBSCRIBED')

  const mailer = recordingMailer()
  const result = await sendCampaignBatch(campaign.id, workspace.id, undefined, undefined, { sendMail: mailer.fn })

  assert.equal(result.sent, 1)
  assert.equal(result.skipped, 1)
  assert.equal(result.failed, 0)
  // The suppressed recipient must never reach the mailer.
  assert.deepEqual(mailer.sent, ['reach@buyer.test'])
  // No OutreachSent row for the suppressed lead; the good one is SENT.
  assert.equal(await prisma.outreachSent.count({ where: { leadId: blocked.id } }), 0)
  const goodSend = await prisma.outreachSent.findFirst({ where: { leadId: good.id } })
  assert.equal(goodSend!.status, 'SENT')
  // Every delivered message is scored for relevance at send time (pre-outcome).
  assert.equal(typeof goodSend!.messageRelevanceScore, 'number')
  assert.equal(goodSend!.messageRelevanceVersion, 1)
  assert.ok(Array.isArray(goodSend!.messageRelevanceReasons))
  const goodLead = await prisma.lead.findUnique({ where: { id: good.id } })
  assert.equal(goodLead!.stage, 'OUTREACH_SENT')
})

test('operator drain: a send-suppressed workspace dispatches nothing (isolated kill-switch)', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await seedSmtp(workspace.id)
  const campaign = await seedCampaign(workspace.id)
  await seedSendableLead(workspace.id, campaign.id, 'reach@buyer.test')
  await seedSendableLead(workspace.id, campaign.id, 'reach2@buyer.test')
  // Operator flips the per-workspace drain switch.
  await prisma.workspace.update({ where: { id: workspace.id }, data: { sendSuppressed: true, sendSuppressedReason: 'abuse review' } })

  const mailer = recordingMailer()
  const result = await sendCampaignBatch(campaign.id, workspace.id, undefined, undefined, { sendMail: mailer.fn })

  // Nothing dispatched, nothing recorded — the whole batch is halted before any lead work.
  assert.equal(result.sent, 0)
  assert.equal(mailer.sent.length, 0)
  assert.equal(await prisma.outreachSent.count({ where: { campaignId: campaign.id } }), 0)
})

test('pagination: sends across multiple pages and enforces the cap across pages', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await seedSmtp(workspace.id)
  const campaign = await seedCampaign(workspace.id)
  // Five sendable leads, paged two at a time → three pages.
  for (let n = 0; n < 5; n++) {
    await seedSendableLead(workspace.id, campaign.id, `reach${n}@buyer.test`)
  }

  const mailer = recordingMailer()
  const result = await sendCampaignBatch(campaign.id, workspace.id, undefined, undefined, { sendMail: mailer.fn, pageSize: 2 })

  // All five send despite the tiny page size — paging walks every page.
  assert.equal(result.sent, 5)
  assert.equal(mailer.sent.length, 5)
  assert.equal(await prisma.outreachSent.count({ where: { campaignId: campaign.id, status: 'SENT' } }), 5)
})

test('pagination: a daily cap reached mid-paging stops and tallies the remainder', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await seedSmtp(workspace.id)
  // Cap of 2/day; six eligible leads paged two at a time.
  await prisma.workspaceICP.create({
    data: { workspaceId: workspace.id, approvalMode: false, dailySendLimit: 2, targetIndustries: [], targetGeos: [], excludedIndustries: [] },
  })
  const campaign = await seedCampaign(workspace.id)
  for (let n = 0; n < 6; n++) {
    await seedSendableLead(workspace.id, campaign.id, `cap${n}@buyer.test`)
  }

  const mailer = recordingMailer()
  const result = await sendCampaignBatch(campaign.id, workspace.id, undefined, undefined, { sendMail: mailer.fn, pageSize: 2 })

  // Only the cap's worth is dispatched; the rest are tallied skipped, and the
  // accounting still sums to the total eligible.
  assert.equal(result.sent, 2)
  assert.equal(mailer.sent.length, 2)
  assert.equal(result.sent + result.skipped + result.failed, 6)
})

test('skip accounting: breaks skipped down by reason (suppressed + invalid email)', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await seedSmtp(workspace.id)
  const campaign = await seedCampaign(workspace.id)
  const good = await seedSendableLead(workspace.id, campaign.id, 'reach@buyer.test')
  await seedSendableLead(workspace.id, campaign.id, 'stop@buyer.test')
  await suppress(workspace.id, 'stop@buyer.test', 'UNSUBSCRIBED')
  // A lead whose email is structurally invalid → INVALID_EMAIL, never dispatched.
  const badLead = await prisma.lead.create({
    data: { workspaceId: workspace.id, campaignId: campaign.id, businessName: 'Bad', email: 'not-an-email', stage: 'RESEARCHED' },
  })
  await prisma.outreachDraft.create({ data: { leadId: badLead.id, workspaceId: workspace.id, subject: 'Hi', emailBody: 'Hello there' } })

  const mailer = recordingMailer()
  const result = await sendCampaignBatch(campaign.id, workspace.id, undefined, undefined, { sendMail: mailer.fn })

  assert.equal(result.sent, 1)
  assert.equal(result.skipped, 2)
  assert.equal(result.skippedByReason.SUPPRESSED, 1)
  assert.equal(result.skippedByReason.INVALID_EMAIL, 1)
  // The breakdown sums to the total skipped.
  const sum = Object.values(result.skippedByReason).reduce((a, b) => a + b, 0)
  assert.equal(sum, result.skipped)
  // Only the valid, non-suppressed recipient was dispatched.
  assert.deepEqual(mailer.sent, ['reach@buyer.test'])
  assert.equal((await prisma.outreachSent.findFirst({ where: { leadId: good.id } }))!.status, 'SENT')
})

test('contact ledger: a successful send appends a SENT ContactEvent (normalized key)', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await seedSmtp(workspace.id)
  const campaign = await seedCampaign(workspace.id)
  const lead = await seedSendableLead(workspace.id, campaign.id, 'Reach@Buyer.TEST')

  const mailer = recordingMailer()
  await sendCampaignBatch(campaign.id, workspace.id, undefined, undefined, { sendMail: mailer.fn })

  const events = await prisma.contactEvent.findMany({ where: { workspaceId: workspace.id, leadId: lead.id } })
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'SENT')
  assert.equal(events[0].campaignId, campaign.id)
  assert.equal(events[0].emailKey, 'reach@buyer.test', 'ledger emailKey is normalized')
  // The ledger row is tied to the outbox send.
  const send = await prisma.outreachSent.findFirst({ where: { leadId: lead.id } })
  assert.equal(events[0].outreachSentId, send!.id)
})

test('claim timestamps: SENT carries claimedAt + sentAt, no failedAt', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await seedSmtp(workspace.id)
  const campaign = await seedCampaign(workspace.id)
  const lead = await seedSendableLead(workspace.id, campaign.id, 'reach@buyer.test')

  const mailer = recordingMailer()
  await sendCampaignBatch(campaign.id, workspace.id, undefined, undefined, { sendMail: mailer.fn })

  const send = await prisma.outreachSent.findFirst({ where: { leadId: lead.id } })
  assert.equal(send!.status, 'SENT')
  assert.ok(send!.claimedAt, 'claimedAt is set at claim time')
  assert.ok(send!.sentAt, 'sentAt is set on SMTP accept')
  assert.equal(send!.failedAt, null, 'a successful send has no failedAt')
  // The claim was reserved no later than the send was accepted.
  assert.ok(send!.claimedAt.getTime() <= send!.sentAt.getTime())
})

test('claim timestamps: an SMTP rejection records failedAt and keeps claimedAt', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await seedSmtp(workspace.id)
  const campaign = await seedCampaign(workspace.id)
  const lead = await seedSendableLead(workspace.id, campaign.id, 'reach@buyer.test')

  const mailer = recordingMailer({ throwOn: () => true })
  await sendCampaignBatch(campaign.id, workspace.id, undefined, undefined, { sendMail: mailer.fn })

  const send = await prisma.outreachSent.findFirst({ where: { leadId: lead.id } })
  assert.equal(send!.status, 'FAILED')
  assert.ok(send!.claimedAt, 'claimedAt survives a failed dispatch')
  assert.ok(send!.failedAt, 'failedAt records when SMTP rejected the send')
})

test('idempotent: a lead already sent for this campaign is not re-sent', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await seedSmtp(workspace.id)
  const campaign = await seedCampaign(workspace.id)
  const lead = await seedSendableLead(workspace.id, campaign.id, 'reach@buyer.test')
  // Pre-existing delivered send for this (campaign, lead).
  await prisma.outreachSent.create({
    data: { workspaceId: workspace.id, campaignId: campaign.id, leadId: lead.id,
      toEmail: 'reach@buyer.test', subject: 'Hi', body: 'x', status: 'SENT' },
  })

  const mailer = recordingMailer()
  const result = await sendCampaignBatch(campaign.id, workspace.id, undefined, undefined, { sendMail: mailer.fn })

  assert.equal(result.sent, 0)
  assert.equal(result.skipped, 1)
  assert.deepEqual(mailer.sent, [], 'no second dispatch for an already-sent lead')
  // Still exactly one send row for the pair (the outbox unique constraint holds).
  assert.equal(await prisma.outreachSent.count({ where: { campaignId: campaign.id, leadId: lead.id } }), 1)
})

test('fail-closed: an SMTP rejection marks the claim FAILED and does not advance the lead', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await seedSmtp(workspace.id)
  const campaign = await seedCampaign(workspace.id)
  const lead = await seedSendableLead(workspace.id, campaign.id, 'reach@buyer.test')

  const mailer = recordingMailer({ throwOn: () => true })
  const result = await sendCampaignBatch(campaign.id, workspace.id, undefined, undefined, { sendMail: mailer.fn })

  assert.equal(result.sent, 0)
  assert.equal(result.failed, 1)
  assert.deepEqual(mailer.sent, ['reach@buyer.test'], 'the send was attempted exactly once')
  // The claim row is retained as FAILED (fail-closed: never auto-resent), with
  // the error recorded for operator review.
  const claim = await prisma.outreachSent.findFirst({ where: { leadId: lead.id } })
  assert.equal(claim!.status, 'FAILED')
  assert.match(claim!.lastError ?? '', /mailbox unavailable/)
  // Relevance is scored BEFORE dispatch, so even a send SMTP rejected carries it.
  assert.equal(typeof claim!.messageRelevanceScore, 'number')
  // The lead is NOT advanced — it stays eligible for a deliberate retry.
  const after = await prisma.lead.findUnique({ where: { id: lead.id } })
  assert.equal(after!.stage, 'RESEARCHED')
  // FAILED atomicity: the failure is recorded in the ledger AND the daily stats,
  // consistent with the FAILED outbox row (one transaction).
  const ev = await prisma.contactEvent.findFirst({ where: { leadId: lead.id, type: 'FAILED' } })
  assert.ok(ev, 'a FAILED ContactEvent is appended atomically with the FAILED claim')
  const stats = await prisma.campaignDailyStats.findFirst({ where: { campaignId: campaign.id } })
  assert.equal(stats!.failed, 1, 'the daily failed counter is incremented in the same transaction')
})

test('mission stop: a PAUSED mission halts the batch before any dispatch', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await seedSmtp(workspace.id)
  const campaign = await seedCampaign(workspace.id)
  await seedSendableLead(workspace.id, campaign.id, 'reach@buyer.test')
  // This campaign is the execution arm of a paused mission.
  await prisma.mission.create({
    data: { workspaceId: workspace.id, name: 'Paused', goalType: 'BOOK_MEETINGS', status: 'PAUSED', campaignId: campaign.id },
  })

  const mailer = recordingMailer()
  const result = await sendCampaignBatch(campaign.id, workspace.id, undefined, undefined, { sendMail: mailer.fn })

  assert.equal(result.sent, 0)
  assert.deepEqual(mailer.sent, [], 'a paused mission must not dispatch anything')
  assert.equal(await prisma.outreachSent.count({ where: { campaignId: campaign.id } }), 0)
})

test('policy review: a draft flagged POLICY_REVIEW is never auto-sent', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await seedSmtp(workspace.id)
  const campaign = await seedCampaign(workspace.id)
  // Non-approval workspace so the send path uses the latest draft as-is.
  await prisma.workspaceICP.create({
    data: { workspaceId: workspace.id, approvalMode: false, targetIndustries: [], targetGeos: [], excludedIndustries: [] },
  })
  const lead = await prisma.lead.create({
    data: { workspaceId: workspace.id, campaignId: campaign.id, businessName: 'Acme', email: 'reach@buyer.test', stage: 'RESEARCHED' },
  })
  // The lead's only draft was set aside by the policy checker.
  await prisma.outreachDraft.create({
    data: {
      leadId: lead.id, workspaceId: workspace.id,
      subject: 'Guaranteed results', emailBody: 'This is a GUARANTEED win for you.',
      status: 'POLICY_REVIEW',
      policyViolations: { violations: [{ code: 'RISKY_LANGUAGE', message: 'guarantee' }] },
    },
  })

  const mailer = recordingMailer()
  const result = await sendCampaignBatch(campaign.id, workspace.id, undefined, undefined, { sendMail: mailer.fn })

  // The flagged lead is skipped, never dispatched, and no send row is created.
  assert.equal(result.sent, 0)
  assert.equal(result.skipped, 1)
  assert.deepEqual(mailer.sent, [], 'a POLICY_REVIEW draft must never be sent')
  assert.equal(await prisma.outreachSent.count({ where: { leadId: lead.id } }), 0)
  // The lead is not advanced — it stays eligible once a human resolves the review.
  const after = await prisma.lead.findUnique({ where: { id: lead.id } })
  assert.equal(after!.stage, 'RESEARCHED')
  // No duplicate draft was generated for the flagged lead.
  assert.equal(await prisma.outreachDraft.count({ where: { leadId: lead.id } }), 1)
})

// ── AI generation failure paths (via the generateOutreach injection seam) ──────
// A lead with NO draft + non-approval workspace forces the AI-generation branch.
type GenFn = typeof import('../packages/backend-core/src/services/openai.ts').generateOutreach
function genStub(impl: () => Promise<string> | string): GenFn {
  return (async () => impl()) as unknown as GenFn
}
async function seedDraftlessLead(workspaceId: string, campaignId: string, email: string) {
  return prisma.lead.create({ data: { workspaceId, campaignId, businessName: 'Acme', email, stage: 'RESEARCHED' } })
}
async function aiOutreachUsed(workspaceId: string): Promise<number> {
  const rows = await prisma.usageRecord.findMany({ where: { workspaceId, action: 'AI_OUTREACH' } })
  return rows.reduce((n, r) => n + (r as { count: number }).count, 0)
}

test('AI generation: a malformed draft is skipped (AI_GENERATION_FAILED) and the reserved AI call is refunded', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await seedSmtp(workspace.id)
  const campaign = await seedCampaign(workspace.id)
  await seedDraftlessLead(workspace.id, campaign.id, 'reach@buyer.test')

  const mailer = recordingMailer()
  const result = await sendCampaignBatch(campaign.id, workspace.id, undefined, undefined, {
    sendMail: mailer.fn,
    generateOutreach: genStub(() => '{}'), // valid JSON, but missing subject/email → strict parse fails
  })

  assert.equal(result.sent, 0)
  assert.equal(result.skippedByReason.AI_GENERATION_FAILED, 1)
  assert.deepEqual(mailer.sent, [], 'a malformed draft must never be dispatched')
  // The claim was released (no lingering SENDING row) and the AI call refunded.
  assert.equal(await prisma.outreachSent.count({ where: { campaignId: campaign.id } }), 0)
  assert.equal(await aiOutreachUsed(workspace.id), 0, 'reserved AI usage is refunded on a failed generation')
})

test('AI generation: a thrown generation error fails the lead and refunds the AI call', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await seedSmtp(workspace.id)
  const campaign = await seedCampaign(workspace.id)
  await seedDraftlessLead(workspace.id, campaign.id, 'reach@buyer.test')

  const mailer = recordingMailer()
  const result = await sendCampaignBatch(campaign.id, workspace.id, undefined, undefined, {
    sendMail: mailer.fn,
    generateOutreach: genStub(() => { throw new Error('OpenAI exploded') }),
  })

  assert.equal(result.sent, 0)
  assert.equal(result.failed, 1)
  assert.deepEqual(mailer.sent, [], 'no SMTP attempt when generation throws')
  assert.equal(await aiOutreachUsed(workspace.id), 0, 'reserved AI usage is refunded on a thrown generation')
})

test('AI generation: a valid generated draft sends and persists the draft', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await seedSmtp(workspace.id)
  const campaign = await seedCampaign(workspace.id)
  const lead = await seedDraftlessLead(workspace.id, campaign.id, 'reach@buyer.test')

  const mailer = recordingMailer()
  const result = await sendCampaignBatch(campaign.id, workspace.id, undefined, undefined, {
    sendMail: mailer.fn,
    generateOutreach: genStub(() => JSON.stringify({
      subject: 'Quick question for Acme',
      email: 'Noticed Acme runs multiple crews — how are you handling dispatch as you grow?',
      followup: 'Just circling back on the above — worth a quick chat?',
    })),
  })

  assert.equal(result.sent, 1)
  assert.deepEqual(mailer.sent, ['reach@buyer.test'])
  assert.equal((await prisma.outreachSent.findFirst({ where: { leadId: lead.id } }))!.status, 'SENT')
  assert.equal(await prisma.outreachDraft.count({ where: { leadId: lead.id } }), 1, 'the generated draft is persisted')
  assert.equal(await aiOutreachUsed(workspace.id), 1, 'a successful generation consumes one AI call')
})

// --- selection tracking ---

test('selection tracking: each considered lead is recorded with decision, reason and score-at-selection', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await seedSmtp(workspace.id)
  await prisma.workspaceICP.create({
    data: { workspaceId: workspace.id, approvalMode: false, targetIndustries: ['HVAC'], targetGeos: [], excludedIndustries: [] },
  })
  const campaign = await seedCampaign(workspace.id)
  const good = await seedSendableLead(workspace.id, campaign.id, 'reach@buyer.test')
  await prisma.lead.update({ where: { id: good.id }, data: { score: 83 } })
  const blocked = await seedSendableLead(workspace.id, campaign.id, 'stop@buyer.test')
  await suppress(workspace.id, 'stop@buyer.test', 'UNSUBSCRIBED')
  const broken = await seedSendableLead(workspace.id, campaign.id, 'boom@buyer.test')

  await sendCampaignBatch(campaign.id, workspace.id, undefined, undefined, { sendMail: recordingMailer({ throwOn: (to) => to === 'boom@buyer.test' }).fn })

  const run = await prisma.outreachSelectionRun.findFirstOrThrow({ where: { campaignId: campaign.id }, include: { selections: true } })
  assert.equal(run.orderBy, 'id_asc')
  assert.match(run.icpFingerprint, /^[0-9a-f]{64}$/)
  assert.ok(run.finishedAt)
  assert.deepEqual((run.totals as { sent: number; skipped: number; failed: number }), { sent: 1, skipped: 1, failed: 1, skippedByReason: (run.totals as { skippedByReason: unknown }).skippedByReason, holdoutPercent: 0 })
  const by = Object.fromEntries(run.selections.map(s => [s.leadId, s]))
  assert.equal(by[good.id].decision, 'SELECTED')
  assert.equal(by[good.id].leadScore, 83)
  assert.ok(by[good.id].outreachSentId, 'selected rows link to the send')
  assert.equal(by[blocked.id].decision, 'EXCLUDED')
  assert.equal(by[blocked.id].reason, 'SUPPRESSED')
  assert.equal(by[broken.id].decision, 'FAILED')
})

test('selection tracking: fingerprints change when targeting or the scoring model changes', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await seedSmtp(workspace.id)
  await prisma.workspaceICP.create({ data: { workspaceId: workspace.id, approvalMode: false, targetIndustries: ['HVAC'], targetGeos: [], excludedIndustries: [] } })
  const campaign = await seedCampaign(workspace.id)
  const mailer = recordingMailer()
  await sendCampaignBatch(campaign.id, workspace.id, undefined, undefined, { sendMail: mailer.fn })
  await prisma.workspaceICP.update({ where: { workspaceId: workspace.id }, data: { targetIndustries: ['Electrical'] } })
  await sendCampaignBatch(campaign.id, workspace.id, undefined, undefined, { sendMail: mailer.fn })
  await prisma.scoringModel.create({ data: { workspaceId: workspace.id, weights: { industry: 1 }, performanceMetrics: {} } })
  await sendCampaignBatch(campaign.id, workspace.id, undefined, undefined, { sendMail: mailer.fn })
  const runs = await prisma.outreachSelectionRun.findMany({ where: { campaignId: campaign.id }, orderBy: { startedAt: 'asc' } })
  assert.equal(runs.length, 3)
  assert.notEqual(runs[0].icpFingerprint, runs[1].icpFingerprint)
  assert.equal(runs[1].icpFingerprint, runs[2].icpFingerprint)
  assert.notEqual(runs[1].modelFingerprint, runs[2].modelFingerprint)
})

test('selection tracking: bulk cut-offs are captured in run totals; mid-run cap leaves unconsidered leads unrecorded', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await seedSmtp(workspace.id)
  await prisma.workspaceICP.create({ data: { workspaceId: workspace.id, approvalMode: false, dailySendLimit: 2, targetIndustries: [], targetGeos: [], excludedIndustries: [] } })
  const campaign = await seedCampaign(workspace.id)
  for (let n = 0; n < 5; n++) await seedSendableLead(workspace.id, campaign.id, `c${n}@buyer.test`)
  await sendCampaignBatch(campaign.id, workspace.id, undefined, undefined, { sendMail: recordingMailer().fn, pageSize: 2 })
  const run = await prisma.outreachSelectionRun.findFirstOrThrow({ where: { campaignId: campaign.id }, include: { selections: true } })
  const totals = run.totals as { sent: number; skipped: number; skippedByReason: Record<string, number> }
  assert.equal(totals.sent, 2)
  assert.equal(totals.skippedByReason.DAILY_CAP, 3)
  assert.equal(run.selections.filter(s => s.decision === 'SELECTED').length, 2)
})

test('selection tracking never blocks sending: a failure to record is logged, the send still goes out', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await seedSmtp(workspace.id)
  const campaign = await seedCampaign(workspace.id)
  await seedSendableLead(workspace.id, campaign.id, 'reach@buyer.test')
  await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION acaos_test_fail_sel() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'selection store down'; END $$ LANGUAGE plpgsql`)
  await prisma.$executeRawUnsafe(`CREATE TRIGGER acaos_test_fail_sel BEFORE INSERT ON "OutreachSelectionRun" FOR EACH ROW EXECUTE FUNCTION acaos_test_fail_sel()`)
  try {
    const result = await sendCampaignBatch(campaign.id, workspace.id, undefined, undefined, { sendMail: recordingMailer().fn })
    assert.equal(result.sent, 1)
  } finally {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS acaos_test_fail_sel ON "OutreachSelectionRun"`)
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS acaos_test_fail_sel()`)
  }
})

// --- held-back comparison group ---

test('holdout: a random share is never contacted, recorded as HELD_OUT, and compared against the contacted group', async () => {
  const { holdoutBucket, compareHoldout } = await import('../packages/backend-core/src/lib/holdout.ts')
  const prev = process.env.LEARNING_HOLDOUT_PERCENT
  process.env.LEARNING_HOLDOUT_PERCENT = '20'
  try {
    const { workspace } = await seedUserWithWorkspace()
    await seedSmtp(workspace.id)
    const campaign = await seedCampaign(workspace.id)
    const leads = []
    for (let n = 0; n < 30; n++) leads.push(await seedSendableLead(workspace.id, campaign.id, `h${n}@buyer.test`))
    const heldIds = new Set(leads.filter(l => holdoutBucket(workspace.id, l.id) < 20).map(l => l.id))
    assert.ok(heldIds.size > 0 && heldIds.size < leads.length, 'fixture has both groups')

    const mailer = recordingMailer()
    const result = await sendCampaignBatch(campaign.id, workspace.id, undefined, undefined, { sendMail: mailer.fn })
    assert.equal(result.skippedByReason.HOLDOUT, heldIds.size)
    assert.equal(result.sent, leads.length - heldIds.size)
    assert.equal(await prisma.outreachSent.count({ where: { leadId: { in: [...heldIds] } } }), 0, 'held-out leads are never contacted')

    const run = await prisma.outreachSelectionRun.findFirstOrThrow({ where: { campaignId: campaign.id }, include: { selections: true } })
    assert.equal((run.totals as { holdoutPercent: number }).holdoutPercent, 20)
    const recordedHeld = run.selections.filter(s => s.decision === 'HELD_OUT')
    assert.deepEqual(new Set(recordedHeld.map(s => s.leadId)), heldIds)
    assert.ok(recordedHeld.every(s => s.reason === 'HOLDOUT'))

    // Stable across runs: a second run still contacts none of them.
    await sendCampaignBatch(campaign.id, workspace.id, undefined, undefined, { sendMail: mailer.fn })
    assert.equal(await prisma.outreachSent.count({ where: { leadId: { in: [...heldIds] } } }), 0)

    // Comparison: one contacted lead books; one held-out lead closes anyway.
    const contactedId = leads.find(l => !heldIds.has(l.id))!.id
    await prisma.lead.update({ where: { id: contactedId }, data: { stage: 'BOOKED' } })
    const c = await compareHoldout(workspace.id)
    assert.equal(c.contacted.leads, leads.length - heldIds.size)
    assert.equal(c.heldOut.leads, heldIds.size)
    assert.equal(c.contacted.converted, 1)
    assert.equal(c.heldOut.converted, 0)
    assert.ok(c.conversionLiftPts! > 0)
  } finally {
    if (prev === undefined) delete process.env.LEARNING_HOLDOUT_PERCENT; else process.env.LEARNING_HOLDOUT_PERCENT = prev
  }
})

test('SENSITIVE_DATA: a draft carrying a card number is never sent and is held for review', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await seedSmtp(workspace.id)
  const campaign = await seedCampaign(workspace.id)
  const good = await seedSendableLead(workspace.id, campaign.id, 'reach@buyer.test')
  const leaky = await prisma.lead.create({
    data: { workspaceId: workspace.id, campaignId: campaign.id, businessName: 'Leaky', email: 'leak@buyer.test', stage: 'RESEARCHED' },
  })
  const draft = await prisma.outreachDraft.create({
    data: { leadId: leaky.id, workspaceId: workspace.id, subject: 'Hi', emailBody: 'Card for the deposit: 4111 1111 1111 1111' },
  })

  const mailer = recordingMailer()
  const result = await sendCampaignBatch(campaign.id, workspace.id, undefined, undefined, { sendMail: mailer.fn })

  assert.deepEqual(mailer.sent, ['reach@buyer.test'])
  assert.equal(result.skippedByReason.SENSITIVE_DATA, 1)
  assert.equal(await prisma.outreachSent.count({ where: { leadId: leaky.id } }), 0, 'no outbox row, nothing claimed')
  const held = await prisma.outreachDraft.findUniqueOrThrow({ where: { id: draft.id } })
  assert.equal(held.status, 'POLICY_REVIEW')
  assert.equal((held.policyViolations as { violations: Array<{ code: string }> }).violations[0].code, 'SENSITIVE_DATA')
  assert.equal((await prisma.outreachSent.findFirst({ where: { leadId: good.id } }))!.status, 'SENT')
})
