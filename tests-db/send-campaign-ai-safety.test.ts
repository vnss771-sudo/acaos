// DB-tier behavioral tests for the AI-generation branches of sendCampaignBatch
// that the existing send-campaign.test.ts AI section does NOT cover. The existing
// file pins the two refund paths (malformed parse, thrown generation). These add
// the three remaining money/safety invariants on the same claim→generate→dispatch
// path:
//
//   1. POLICY_REVIEW — generated copy that trips a content/grounding policy must be
//      parked as a draft for human review and NEVER auto-sent; and because the AI
//      call did produce usable output, its quota is legitimately consumed (NOT
//      refunded). This is the safety-critical "never auto-send flagged copy" gate.
//
//   2. AI_LIMIT — when the workspace is already at its monthly AI quota, the claim
//      that was reserved BEFORE generation must be released (no orphaned `SENDING`
//      row silently consuming the daily cap), generation must never be invoked, and
//      nothing is dispatched or charged.
//
//   3. Refund actually FREES quota — the existing refund tests assert post-batch
//      usage == 0, which cannot distinguish "incremented then refunded" from "never
//      incremented". Seeding the workspace to exactly one call below its limit and
//      failing two generations proves the refund returns quota to the pool: a broken
//      refund would let the first lead's increment exhaust the quota and bounce the
//      second to AI_LIMIT.
//
// All run against a live DB with the mailer + generator injected via the deps seam,
// so no real SMTP or OpenAI call happens.

import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { sendCampaignBatch } from '../apps/worker/src/processors.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace } from './helpers/db.ts'

after(async () => { await disconnect() })
beforeEach(async () => { await resetDb() })

// ── Harness (mirrors send-campaign.test.ts) ─────────────────────────────────────

function recordingMailer() {
  const sent: string[] = []
  const fn = async (to: string) => {
    sent.push(to)
    return { messageId: `<test-${sent.length}@acaos.test>` }
  }
  return { fn: fn as unknown as typeof import('../packages/backend-core/src/services/mail.ts').sendMail, sent }
}

type GenFn = typeof import('../packages/backend-core/src/services/openai.ts').generateOutreach

/** A generation stub that records how many times it was actually invoked. */
function countingGen(impl: () => Promise<string> | string) {
  const state = { calls: 0 }
  const fn = (async () => { state.calls++; return impl() }) as unknown as GenFn
  return { fn, state }
}

async function seedSmtp(workspaceId: string) {
  await prisma.workspaceEmailConfig.create({
    data: { workspaceId, smtpHost: 'smtp.acme.test', smtpFrom: 'sales@acme.test' },
  })
}

async function seedCampaign(workspaceId: string) {
  return prisma.campaign.create({ data: { workspaceId, name: 'Q3 Outreach', goalType: 'BOOK_MEETINGS' } })
}

/** A lead with NO draft so the AI-generation branch is taken. */
async function seedDraftlessLead(workspaceId: string, campaignId: string, email: string) {
  return prisma.lead.create({ data: { workspaceId, campaignId, businessName: 'Acme', email, stage: 'RESEARCHED' } })
}

/** Current quota window key, byte-for-byte identical to limits.ts currentMonth(). */
function currentMonth(): string {
  const d = new Date()
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

/** Total AI_OUTREACH calls charged this month (what the customer is billed for). */
async function aiOutreachUsed(workspaceId: string): Promise<number> {
  const rows = await prisma.usageRecord.findMany({ where: { workspaceId, action: 'AI_OUTREACH' } })
  return rows.reduce((n, r) => n + (r as { count: number }).count, 0)
}

/** Pre-spend `count` AI calls this month (seeded under AI_RESEARCH — the limit sums
 *  all AI actions, but keeping it off AI_OUTREACH leaves the outreach counter clean
 *  so the assertions read the outreach charge directly). */
async function seedAiUsage(workspaceId: string, count: number) {
  await prisma.usageRecord.create({
    data: { workspaceId, action: 'AI_RESEARCH', month: currentMonth(), count },
  })
}

// ── 1. POLICY_REVIEW: flagged copy is parked, never sent, and NOT refunded ──────

test('AI generation: policy-violating copy is parked as POLICY_REVIEW, never sent, and the AI call is NOT refunded', async () => {
  const { workspace } = await seedUserWithWorkspace() // free plan, 15 AI calls/mo
  await seedSmtp(workspace.id)
  const campaign = await seedCampaign(workspace.id)
  const lead = await seedDraftlessLead(workspace.id, campaign.id, 'reach@buyer.test')

  const mailer = recordingMailer()
  // Valid JSON (parse succeeds) but the body is below the default 30-char minimum →
  // checkDraftPolicy returns BODY_TOO_SHORT → the POLICY_REVIEW branch.
  const gen = countingGen(() => JSON.stringify({ subject: 'Quick hello', email: 'Hey there.' }))
  const result = await sendCampaignBatch(campaign.id, workspace.id, undefined, undefined, {
    sendMail: mailer.fn,
    generateOutreach: gen.fn,
  })

  assert.equal(result.sent, 0)
  assert.equal(result.skippedByReason.POLICY_REVIEW, 1)
  assert.deepEqual(mailer.sent, [], 'copy that tripped a policy must never be dispatched')

  // The draft is persisted for human review, marked POLICY_REVIEW.
  const draft = await prisma.outreachDraft.findFirst({ where: { leadId: lead.id } })
  assert.ok(draft, 'a draft is persisted for review')
  assert.equal(draft!.status, 'POLICY_REVIEW')

  // The outbox claim is released — no orphaned SENDING row, no SENT row.
  assert.equal(await prisma.outreachSent.count({ where: { campaignId: campaign.id } }), 0)

  // Money invariant: the generation SUCCEEDED (it produced copy), so the quota is
  // legitimately spent — unlike the parse-fail/throw paths, there is no refund here.
  assert.equal(await aiOutreachUsed(workspace.id), 1, 'a usable-but-held draft consumes the AI call (no refund)')
})

// ── 2. AI_LIMIT: quota exhausted → claim released, generation never invoked ──────

test('AI generation: at the monthly AI limit the lead is skipped AI_LIMIT, the claim is released, and generation is never invoked', async () => {
  const { workspace } = await seedUserWithWorkspace() // free plan: 15/mo
  await seedSmtp(workspace.id)
  const campaign = await seedCampaign(workspace.id)
  await seedDraftlessLead(workspace.id, campaign.id, 'reach@buyer.test')
  await seedAiUsage(workspace.id, 15) // already at the free-plan ceiling

  const mailer = recordingMailer()
  // If generation were reached this would send; it must NOT be reached.
  const gen = countingGen(() => JSON.stringify({
    subject: 'Should never run',
    email: 'This body is long enough to pass policy but should never be generated.',
  }))
  const result = await sendCampaignBatch(campaign.id, workspace.id, undefined, undefined, {
    sendMail: mailer.fn,
    generateOutreach: gen.fn,
  })

  assert.equal(result.sent, 0)
  assert.equal(result.skippedByReason.AI_LIMIT, 1)
  assert.equal(gen.state.calls, 0, 'the quota check must short-circuit before any AI call')
  assert.deepEqual(mailer.sent, [], 'nothing is dispatched when the AI quota is exhausted')
  // The claim reserved before the quota check must be rolled back — otherwise a
  // stranded SENDING row would consume the daily cap forever.
  assert.equal(await prisma.outreachSent.count({ where: { campaignId: campaign.id } }), 0, 'no orphaned SENDING claim')
  assert.equal(await aiOutreachUsed(workspace.id), 0, 'no outreach call is charged when blocked at the limit')
})

// ── 3. The refund actually returns quota to the pool ────────────────────────────

test('AI generation: a refunded failure frees quota for the next lead (refund returns a unit to the pool, not just nets to zero)', async () => {
  const { workspace } = await seedUserWithWorkspace() // free plan: 15/mo
  await seedSmtp(workspace.id)
  const campaign = await seedCampaign(workspace.id)
  await seedDraftlessLead(workspace.id, campaign.id, 'a@buyer.test')
  await seedDraftlessLead(workspace.id, campaign.id, 'b@buyer.test')
  await seedAiUsage(workspace.id, 14) // exactly one call below the limit

  const mailer = recordingMailer()
  // Both generations return valid JSON missing subject/email → strict parse fails →
  // AI_GENERATION_FAILED + refund for each.
  const gen = countingGen(() => '{}')
  const result = await sendCampaignBatch(campaign.id, workspace.id, undefined, undefined, {
    sendMail: mailer.fn,
    generateOutreach: gen.fn,
  })

  // The discriminator: with a WORKING refund, the first lead's reservation is
  // returned, so the second lead still has quota and also reaches generation —
  // both end AI_GENERATION_FAILED, none AI_LIMIT. A BROKEN refund would leave the
  // first increment in place, exhausting the quota and bouncing the second lead to
  // AI_LIMIT (1 + 1 instead of 2 + 0).
  assert.equal(result.skippedByReason.AI_GENERATION_FAILED, 2, 'both leads reach generation — refund freed the quota')
  assert.equal(result.skippedByReason.AI_LIMIT, 0, 'no lead is starved of quota by an un-refunded reservation')
  assert.equal(gen.state.calls, 2, 'generation is attempted for both leads')
  assert.equal(result.sent, 0)
  assert.deepEqual(mailer.sent, [])
  assert.equal(await aiOutreachUsed(workspace.id), 0, 'both reservations are refunded; outreach charge nets to zero')
})
