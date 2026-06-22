/**
 * Operational chaos safety gates for ACAOS.
 *
 * Static failure-mode tests: they inspect the source for production safety
 * invariants that matter under crashes/retries:
 * - campaign email sends must be idempotent
 * - worker retries must not duplicate outbound messages
 * - queue jobs should have deterministic idempotency keys
 * - suppression/approval safeguards must run before dispatch
 *
 * A failing gate marks a production-hardening item, not a broken test.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const schema = fs.readFileSync(path.join(root, 'packages/db/prisma/schema.prisma'), 'utf8')
const processors = fs.readFileSync(path.join(root, 'apps/worker/src/processors.ts'), 'utf8')
const campaignsRoute = fs.readFileSync(path.join(root, 'apps/api/src/routes/campaigns.ts'), 'utf8')
const queues = fs.readFileSync(path.join(root, 'packages/backend-core/src/lib/queues.ts'), 'utf8')

function modelBlock(name: string) {
  const re = new RegExp(`model\\s+${name}\\s+\\{([\\s\\S]*?)\\n\\}`, 'm')
  const m = schema.match(re)
  assert.ok(m, `Missing Prisma model: ${name}`)
  return m![1]
}

test('operational chaos: OutreachSent must uniquely identify campaign+lead+step sends', () => {
  const outreach = modelBlock('OutreachSent')
  // Outbox idempotency is per (campaign, lead, sequenceStep): a sequence may send
  // to a lead more than once, but each step stays at-most-once. campaignId+leadId
  // must still anchor the composite (in either order, with the step).
  const hasCompositeUnique =
    /@@unique\s*\(\s*\[\s*campaignId\s*,\s*leadId\s*,\s*sequenceStep\s*\]/.test(outreach)
    || /@@unique\s*\(\s*\[\s*campaignId\s*,\s*leadId\s*\]/.test(outreach)
  assert.ok(hasCompositeUnique, 'Missing @@unique([campaignId, leadId, sequenceStep]).')
})

test('operational chaos: send flow should reserve an outbox row before SMTP dispatch', () => {
  const sendMailIdx = processors.indexOf('await sendMailFn(')
  // Receiver-agnostic: the claim now runs inside an advisory-locked transaction
  // as `tx.outreachSent.create` (atomic cap reservation + outbox claim), so match
  // `.outreachSent.create` rather than the `prisma.`-bound form.
  const createIdx = processors.indexOf('.outreachSent.create')
  assert.notEqual(sendMailIdx, -1, 'Could not locate sendMail call')
  assert.notEqual(createIdx, -1, 'Could not locate outreachSent.create')
  assert.ok(createIdx < sendMailIdx, 'SMTP send happens before the outbox row is reserved.')
})

test('operational chaos: OutreachSent should support PENDING/SENDING/FAILED states', () => {
  const outreach = modelBlock('OutreachSent')
  assert.ok(/PENDING|SENDING/.test(outreach), 'No PENDING/SENDING outbox state.')
  assert.ok(/FAILED/.test(outreach), 'No FAILED status for auditable/retryable failures.')
})

test('operational chaos: send-campaign queue should use deterministic jobId/dedup key', () => {
  const fn = queues.slice(queues.indexOf('export async function enqueueSendCampaign'))
  assert.ok(/jobId\s*:/.test(fn), 'enqueueSendCampaign lacks a deterministic jobId.')
})

test('operational chaos: suppression check must happen before sendMail', () => {
  const suppressionIdx = processors.indexOf('bulkCheckSuppression')
  const sendMailIdx = processors.indexOf('await sendMailFn(')
  assert.ok(suppressionIdx !== -1 && sendMailIdx !== -1, 'Could not locate suppression or sendMail')
  assert.ok(suppressionIdx < sendMailIdx, 'Suppression check must run before SMTP dispatch')
})

test('operational chaos: approval mode is enforced before campaign enqueue', () => {
  const sendRoute = campaignsRoute.slice(campaignsRoute.indexOf("'/:id/send'"))
  const approvalIdx = sendRoute.indexOf('approvalMode')
  const approvedBodyIdx = sendRoute.indexOf('approved')
  const enqueueIdx = sendRoute.indexOf('enqueueSendCampaign')
  assert.ok(approvalIdx !== -1 && approvedBodyIdx !== -1 && enqueueIdx !== -1, 'Could not locate approval/enqueue flow')
  assert.ok(approvalIdx < enqueueIdx && approvedBodyIdx < enqueueIdx, 'Approval check must happen before enqueue')
})

test('operational chaos: reserved AI usage is refunded when generation fails', () => {
  // Quota must only be spent on usable output: after reserving an AI call
  // (checkAndIncrementAiUsage) the worker must refund it on both non-success
  // paths — an unusable/empty draft and a thrown generation error — or failed
  // generations silently burn a workspace's monthly AI allowance.
  const reserveIdx = processors.indexOf("checkAndIncrementAiUsage(workspaceId, 'AI_OUTREACH')")
  const refundIdx = processors.indexOf("refundAiUsage(workspaceId, 'AI_OUTREACH')")
  const refundCount = processors.split("refundAiUsage(workspaceId, 'AI_OUTREACH')").length - 1
  assert.notEqual(reserveIdx, -1, 'Could not locate the AI-usage reserve')
  assert.notEqual(refundIdx, -1, 'Missing AI-usage refund on generation failure')
  assert.ok(refundIdx > reserveIdx, 'Refund must come after the reserve')
  assert.ok(refundCount >= 2, 'Both failure paths (empty draft + thrown error) must refund')
})

test('operational chaos: worker must skip unapproved leads before any AI generation', () => {
  // Regression guard for the approval-mode bypass: the send loop fetches APPROVED
  // drafts only, so a lead with no included draft must be SKIPPED — never sent
  // with freshly generated copy. The skip guard must therefore sit in the
  // draft-generation branch and run BEFORE generateOutreach, or the entire
  // approval gate is bypassed at send time.
  const draftCheckIdx = processors.indexOf('if (lead.outreachDrafts[0])')
  // The guard reads `approvalRequired` (the workspace's approvalMode OR forced on
  // by SAFE_LAUNCH_MODE) and records a NO_APPROVED_DRAFT skip — same invariant.
  const skipGuardIdx = processors.indexOf("if (approvalRequired) { skip('NO_APPROVED_DRAFT'); continue }")
  // The call is dispatched via the injectable `generateOutreachFn` seam (tests stub
  // it); match that form rather than the bare generator name.
  const generateIdx = processors.indexOf('generateOutreachFn(')
  assert.notEqual(draftCheckIdx, -1, 'Could not locate the draft-presence check')
  assert.notEqual(skipGuardIdx, -1, 'Missing approval-mode skip guard in the draft-generation branch')
  assert.notEqual(generateIdx, -1, 'Could not locate generateOutreach call')
  assert.ok(draftCheckIdx < skipGuardIdx, 'Skip guard must be inside the no-approved-draft branch')
  assert.ok(skipGuardIdx < generateIdx, 'Unapproved leads must be skipped before AI generation runs')
})

test('operational chaos: messageId is unique for reply correlation', () => {
  const outreach = modelBlock('OutreachSent')
  assert.match(outreach, /messageId\s+String\?\s+@unique/, 'messageId must remain unique for reply correlation')
})

// ── Send safety gates: enforced server-side before enqueue/dispatch ────────────
test('operational chaos: paused/complete mission blocks send before enqueue', () => {
  const route = campaignsRoute.slice(campaignsRoute.indexOf("'/:id/send'"))
  const missionIdx = route.indexOf('prisma.mission.findUnique')
  const pausedIdx = route.indexOf("mission?.status === 'PAUSED'")
  const completeIdx = route.indexOf("mission?.status === 'COMPLETE'")
  const enqueueIdx = route.indexOf('enqueueSendCampaign')
  assert.ok(missionIdx !== -1 && pausedIdx !== -1 && completeIdx !== -1 && enqueueIdx !== -1, 'mission stop gate missing')
  assert.ok(missionIdx < enqueueIdx && pausedIdx < enqueueIdx && completeIdx < enqueueIdx, 'mission gate must run before enqueue')
})

test('operational chaos: daily send cap counts delivered SENT rows only', () => {
  const route = campaignsRoute.slice(campaignsRoute.indexOf("'/:id/send'"))
  const dailyIdx = route.indexOf('dailySendLimit')
  const statusIdx = route.indexOf("status: 'SENT'")
  const enqueueIdx = route.indexOf('enqueueSendCampaign')
  assert.ok(dailyIdx !== -1 && statusIdx !== -1 && enqueueIdx !== -1, 'daily cap sent-only guard missing')
  assert.ok(statusIdx < enqueueIdx, 'daily cap must filter status SENT before enqueue')
})

test('operational chaos: worker re-checks mission stop before SMTP dispatch', () => {
  // The send worker paginates eligible leads (for…of page); the mission-stop
  // re-check must still run inside that loop before any SMTP dispatch so an
  // operator pause halts the batch (mid-page, and certainly before the next page).
  const loopIdx = processors.indexOf('for (const lead of page)')
  const blockIdx = processors.indexOf('await getMissionSendBlockReason(campaignId)', loopIdx)
  const sendMailIdx = processors.indexOf('await sendMailFn(', loopIdx)
  assert.ok(loopIdx !== -1 && blockIdx !== -1 && sendMailIdx !== -1, 'worker mission stop check missing')
  assert.ok(blockIdx < sendMailIdx, 'worker must check mission status before SMTP dispatch')
})

test('operational chaos: approval mode requires an approved draft before enqueue', () => {
  const route = campaignsRoute.slice(campaignsRoute.indexOf("'/:id/send'"))
  const approvalIdx = route.indexOf('approvalMode')
  const draftIdx = route.indexOf("outreachDrafts: { some: { status: 'APPROVED' } }")
  const enqueueIdx = route.indexOf('enqueueSendCampaign')
  assert.ok(approvalIdx !== -1 && draftIdx !== -1 && enqueueIdx !== -1, 'approved-draft gate missing')
  assert.ok(draftIdx < enqueueIdx, 'approved-draft gate must run before enqueue')
})

// ── OutreachIntent bridge (Stage 1: schema) ────────────────────────────────────
test('schema: OutreachIntent bridge exists with recommendation link + evidence snapshot', () => {
  const m = modelBlock('OutreachIntent')
  assert.match(m, /recommendationId\s+String\?\s+@unique/, 'one intent per recommendation')
  assert.match(m, /status\s+OutreachIntentStatus/, 'has lifecycle status')
  assert.match(m, /evidenceSnapshot\s+Json\?/, 'carries an evidence snapshot')
  assert.match(m, /prospectId/, 'links to the prospect')
  assert.match(schema, /enum OutreachIntentStatus/, 'status enum defined')
})

test('schema: OutreachSent carries intelligence provenance (Stage 5)', () => {
  const m = modelBlock('OutreachSent')
  assert.match(m, /outreachIntentId\s+String\?/, 'send links to its intent')
  assert.match(m, /evidenceSnapshot\s+Json\?/, 'send snapshots the evidence')
})

test('worker: send stamps a linked approved intent and advances it to SENT', () => {
  // The approved-intent lookup is batched: one query loads OutreachIntents with
  // status APPROVED for the batch's leadIds, then each lead resolves its intent
  // from that map. The safety intent (only APPROVED intents are linked, and a
  // linked intent is stamped on the send + flipped to SENT) is unchanged.
  assert.ok(/status:\s*'APPROVED'/.test(processors), 'looks up the approved intent for the lead')
  assert.ok(processors.includes('linkedIntentByLeadId.get(lead.id)'), 'resolves the per-lead approved intent from the batch map')
  assert.ok(processors.includes('outreachIntentId: linkedIntent.id'), 'stamps intent provenance on the send')
  const flipIdx = processors.indexOf("prisma.outreachIntent.update({ where: { id: linkedIntent.id }, data: { status: 'SENT' }")
  // The claim now runs as `tx.outreachSent.create` inside the advisory-locked
  // transaction; match the receiver-agnostic form.
  const createIdx = processors.indexOf('.outreachSent.create')
  assert.ok(flipIdx !== -1 && createIdx !== -1 && createIdx < flipIdx, 'intent flips to SENT after the send claim')
})
