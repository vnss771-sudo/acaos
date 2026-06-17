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
const queues = fs.readFileSync(path.join(root, 'apps/api/src/lib/queues.ts'), 'utf8')

function modelBlock(name: string) {
  const re = new RegExp(`model\\s+${name}\\s+\\{([\\s\\S]*?)\\n\\}`, 'm')
  const m = schema.match(re)
  assert.ok(m, `Missing Prisma model: ${name}`)
  return m![1]
}

test('operational chaos: OutreachSent must uniquely identify campaign+lead sends', () => {
  const outreach = modelBlock('OutreachSent')
  const hasCompositeUnique = /@@unique\s*\(\s*\[\s*campaignId\s*,\s*leadId\s*\]/.test(outreach)
    || /@@unique\s*\(\s*\[\s*leadId\s*,\s*campaignId\s*\]/.test(outreach)
  assert.ok(hasCompositeUnique, 'Missing @@unique([campaignId, leadId]).')
})

test('operational chaos: send flow should reserve an outbox row before SMTP dispatch', () => {
  const sendMailIdx = processors.indexOf('await sendMail(')
  const createIdx = processors.indexOf('prisma.outreachSent.create')
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
  const sendMailIdx = processors.indexOf('await sendMail(')
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
  const loopIdx = processors.indexOf('for (let i = 0; i < leads.length; i++)')
  const blockIdx = processors.indexOf('await getMissionSendBlockReason(campaignId)', loopIdx)
  const sendMailIdx = processors.indexOf('await sendMail(', loopIdx)
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
