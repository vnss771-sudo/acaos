/**
 * Operational chaos safety gates for ACAOS.
 *
 * Behavioral tests for the send worker's production safety invariants that
 * matter under crashes/retries — exercised by actually invoking
 * `sendCampaignBatch` (and the pure `sendCampaignJobId`) against a fake Prisma
 * client (see tests/helpers/integration.ts), not by grepping source text. A
 * logic bug in a guard — the function still exists and is still called, but
 * now computes the wrong answer — fails these tests; a static string-match
 * against the source would not have caught it.
 *
 * Covered here (worker-level, defense-in-depth):
 * - campaign email sends are idempotent under a racing/retried claim
 * - the outbox row is reserved before SMTP dispatch, never after
 * - the outbox actually cycles through SENDING → SENT / FAILED at runtime
 * - the SMTP-provider messageId is exactly what's persisted for reply correlation
 * - queue jobs get a deterministic idempotency key
 * - suppressed recipients are never dispatched
 * - AI spend reserved for a generation is refunded on every failure path
 * - unapproved leads are skipped before any AI generation runs
 * - an operator pause halts the rest of an in-flight batch
 * - the atomic daily-cap reservation is the real enforcement, independent of
 *   any earlier forecast
 * - a linked, approved OutreachIntent is stamped onto the send and only
 *   advanced to SENT after the claim succeeds
 *
 * The API-level mirrors of several of these (mission pause, daily-cap
 * forecast, approval-flag/approved-draft requirements before enqueue) are
 * covered as real HTTP behavior in tests/routes-campaigns.test.ts; this file
 * focuses on the worker's own independent re-checks, which is what actually
 * protects against a crash/retry mid-batch.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { sendCampaignBatch } from '../apps/worker/src/processors.ts'
import { sendCampaignJobId } from '../packages/backend-core/src/lib/queues.ts'
import {
  createFakePrisma, installPrisma, resetPrisma,
  type FakePrisma, type FakePrismaSpec, type RecordedCall,
} from './helpers/integration.ts'

const WORKSPACE = 'ws1'
const CAMPAIGN = 'c1'

type LeadFixture = {
  id: string
  email?: string | null
  businessName?: string
  draft?: { subject: string; emailBody: string } | null
}

function leadRow(l: LeadFixture) {
  return {
    id: l.id,
    businessName: l.businessName ?? 'Acme',
    category: null,
    city: null,
    contactName: null,
    email: l.email === undefined ? `${l.id}@example.com` : l.email,
    aiSummary: null,
    outreachAngle: null,
    notes: null,
    outreachDrafts: l.draft ? [l.draft] : [],
  }
}

/**
 * A full, overridable fake-Prisma spec for exercising sendCampaignBatch.
 * `leads` become the page `lead.findMany` returns; everything else is a
 * permissive default (no caps, no suppression, no linked intents) so each
 * test only overrides what it's testing.
 */
function baseSpec(leads: LeadFixture[], overrides: Partial<FakePrismaSpec> = {}): FakePrismaSpec {
  return {
    workspaceEmailConfig: { findUnique: async () => ({ smtpHost: 'smtp.test', smtpFrom: 'a@test.com' }) },
    workspaceICP: { findUnique: async () => ({ approvalMode: false, dailySendLimit: 0, monthlySendLimit: 0, warmupStartedAt: null, targetIndustries: [], businessType: null, outreachTone: null }) },
    workspace: { findUnique: async () => ({ senderBusinessName: 'Acme', senderPostalAddress: '1 St', sendSuppressed: false }) },
    mission: { findUnique: async () => null },
    workspaceDraftPolicy: { findUnique: async () => null },
    campaign: { findUnique: async () => ({ autoFollowupsEnabled: false }) },
    lead: {
      count: async () => leads.length,
      findMany: async () => leads.map(leadRow),
      update: async () => ({}),
    },
    outreachSent: {
      count: async () => 0,
      groupBy: async () => [],
      findMany: async () => [],
      create: async (a: any) => ({ id: `claim-${a.data.leadId}` }),
      update: async () => ({}),
      delete: async () => ({}),
    },
    outreachDraft: { findMany: async () => [], create: async () => ({}) },
    outreachIntent: { findMany: async () => [], update: async () => ({}) },
    suppression: { findMany: async () => [] },
    usageRecord: {
      findMany: async () => [],
      upsert: async () => ({}),
      updateMany: async () => ({}),
    },
    contactEvent: { create: async () => ({}) },
    campaignDailyStats: { upsert: async () => ({}) },
    ...overrides,
  }
}

type SendMailFn = typeof import('../packages/backend-core/src/services/mail.ts').sendMail
type GenerateOutreachFn = typeof import('../packages/backend-core/src/services/openai.ts').generateOutreach

function mailStub(behavior: (to: string) => { messageId?: string } | 'reject' = () => ({ messageId: 'mid-default' })) {
  const calls: string[] = []
  const fn = async (to: string) => {
    calls.push(to)
    const b = behavior(to)
    if (b === 'reject') throw new Error('SMTP 550 rejected')
    return b
  }
  return { fn: fn as unknown as SendMailFn, calls }
}

let prisma: FakePrisma
function install(spec: FakePrismaSpec) {
  prisma = createFakePrisma(spec)
  installPrisma(prisma)
  return prisma
}

test.afterEach(() => resetPrisma())

// ── Idempotency under a racing/retried claim ────────────────────────────────
test('operational chaos: a racing/retried claim on the same (campaign, lead) is rejected — never double-sent', async () => {
  const leads: LeadFixture[] = [
    { id: 'l1', draft: { subject: 'Hi', emailBody: 'Body' } },
    { id: 'l2', draft: { subject: 'Hi', emailBody: 'Body' } },
  ]
  let createCalls = 0
  const spec = baseSpec(leads, {
    outreachSent: {
      count: async () => 0,
      groupBy: async () => [],
      findMany: async () => [], // pre-check missed the race — the unique constraint is the real guard
      create: async (a: any) => {
        createCalls++
        // l2's claim loses the race: another attempt already holds the unique
        // (campaignId, leadId) row — Prisma reports this as P2002.
        if (a.data.leadId === 'l2') { const e: any = new Error('Unique constraint failed'); e.code = 'P2002'; throw e }
        return { id: `claim-${a.data.leadId}` }
      },
      update: async () => ({}),
      delete: async () => ({}),
    },
  })
  install(spec)
  const { fn: sendMail, calls } = mailStub()

  const result = await sendCampaignBatch(CAMPAIGN, WORKSPACE, undefined, undefined, { sendMail })

  assert.equal(result.sent, 1, 'only the winning claim actually sends')
  assert.equal(result.skippedByReason.ALREADY_SENT, 1, 'the losing claim is recorded as ALREADY_SENT, not silently dropped')
  assert.deepEqual(calls, ['l1@example.com'], 'SMTP is never dispatched for a lead that lost the claim race')
  assert.equal(createCalls, 2, 'both leads attempted the claim (the guard is the unique constraint, not a pre-filter)')
})

// ── Reserve-before-dispatch ordering ────────────────────────────────────────
test('operational chaos: the outbox claim is reserved before any SMTP dispatch, both in call order and on failure', async () => {
  const leads: LeadFixture[] = [{ id: 'l1', draft: { subject: 'Hi', emailBody: 'Body' } }]
  install(baseSpec(leads))
  const { fn: sendMail, calls } = mailStub()

  await sendCampaignBatch(CAMPAIGN, WORKSPACE, undefined, undefined, { sendMail })

  const createIdx = prisma.__calls.findIndex((c: RecordedCall) => c.model === 'outreachSent' && c.method === 'create')
  const updateIdx = prisma.__calls.findIndex((c: RecordedCall) => c.model === 'outreachSent' && c.method === 'update')
  assert.notEqual(createIdx, -1)
  assert.ok(createIdx < updateIdx, 'the claim (create) is recorded before the send is finalized (update)')
  assert.equal(calls.length, 1, 'sendMail ran exactly once, after the claim existed')

  // And when the claim itself fails outright (not a P2002 race), dispatch must
  // never be attempted at all — the reservation gates the SMTP call, not just orders it.
  const leads2: LeadFixture[] = [{ id: 'l2', draft: { subject: 'Hi', emailBody: 'Body' } }]
  install(baseSpec(leads2, {
    outreachSent: {
      count: async () => 0, groupBy: async () => [], findMany: async () => [],
      create: async () => { throw new Error('connection reset') },
      update: async () => ({}), delete: async () => ({}),
    },
  }))
  const mail2 = mailStub()
  await assert.rejects(() => sendCampaignBatch(CAMPAIGN, WORKSPACE, undefined, undefined, { sendMail: mail2.fn }))
  assert.equal(mail2.calls.length, 0, 'a claim failure must never let SMTP dispatch happen anyway')
})

// ── Real outbox states + reply-correlation identity ─────────────────────────
test('operational chaos: the outbox actually cycles SENDING → SENT/FAILED, and the persisted messageId is exactly what the mailer returned', async () => {
  const leads: LeadFixture[] = [
    { id: 'ok', draft: { subject: 'Hi', emailBody: 'Body' } },
    { id: 'bad', draft: { subject: 'Hi', emailBody: 'Body' } },
  ]
  install(baseSpec(leads))
  const { fn: sendMail } = mailStub((to) => (to === 'bad@example.com' ? 'reject' : { messageId: 'provider-msg-42' }))

  await sendCampaignBatch(CAMPAIGN, WORKSPACE, undefined, undefined, { sendMail })

  const creates = prisma.callsTo('outreachSent', 'create')
  for (const c of creates) assert.equal((c.args[0] as any).data.status, 'SENDING', 'the claim reserves the row as SENDING before dispatch')

  const updates = prisma.callsTo('outreachSent', 'update')
  const okUpdate = updates.find((u) => (u.args[0] as any).where.id === 'claim-ok')!
  assert.equal((okUpdate.args[0] as any).data.status, 'SENT')
  assert.equal((okUpdate.args[0] as any).data.messageId, 'provider-msg-42', 'the exact provider messageId is persisted — reply correlation depends on this being unmangled')

  const badUpdate = updates.find((u) => (u.args[0] as any).where.id === 'claim-bad')!
  assert.equal((badUpdate.args[0] as any).data.status, 'FAILED')
  assert.match((badUpdate.args[0] as any).data.lastError, /SMTP 550/)
})

// ── Deterministic queue dedup key ───────────────────────────────────────────
test('operational chaos: send-campaign jobs get a real, deterministic dedup key (not just a "jobId:" literal in the source)', () => {
  const now = 5 * 60_000 + 100
  const a = sendCampaignJobId(CAMPAIGN, WORKSPACE, ['l1', 'l2'], now)
  const b = sendCampaignJobId(CAMPAIGN, WORKSPACE, ['l1', 'l2'], now + 1000)
  assert.equal(a, b, 'the same batch launched twice within a minute collapses to one job')
  assert.notEqual(a, sendCampaignJobId(CAMPAIGN, WORKSPACE, ['l1', 'l3'], now), 'a different lead set is a different job')
  // Full coverage of the hashing/bucketing contract lives in tests/lib-queues-jobid.test.ts.
})

// ── Suppression enforced before any dispatch ────────────────────────────────
test('operational chaos: a suppressed recipient is never claimed or dispatched', async () => {
  const leads: LeadFixture[] = [{ id: 'l1', email: 'blocked@example.com', draft: { subject: 'Hi', emailBody: 'Body' } }]
  install(baseSpec(leads, { suppression: { findMany: async () => [{ emailKey: 'blocked@example.com' }] } }))
  const { fn: sendMail, calls } = mailStub()

  const result = await sendCampaignBatch(CAMPAIGN, WORKSPACE, undefined, undefined, { sendMail })

  assert.equal(result.skippedByReason.SUPPRESSED, 1)
  assert.equal(calls.length, 0)
  assert.equal(prisma.callsTo('outreachSent', 'create').length, 0, 'a suppressed lead is filtered before the outbox claim is even attempted')
})

// ── AI spend refunded on every failure path ─────────────────────────────────
test('operational chaos: reserved AI usage is refunded on BOTH failure paths — a thrown generation error and an unusable draft', async () => {
  const leads: LeadFixture[] = [{ id: 'throws' }, { id: 'malformed' }] // no existing draft → generation required
  install(baseSpec(leads))

  // Both fixtures share the same businessName, so disambiguate by call order
  // instead: 1st call throws (provider error), 2nd returns unusable JSON.
  let call = 0
  const generateOutreachFn = (async () => {
    call++
    if (call === 1) throw new Error('provider timeout') // thrown-error path
    return '{"not": "the expected shape"}' // unusable/malformed → schema parse fails
  }) as unknown as GenerateOutreachFn

  const result = await sendCampaignBatch(CAMPAIGN, WORKSPACE, undefined, undefined, {
    sendMail: mailStub().fn,
    generateOutreach: generateOutreachFn,
  })

  const reserves = prisma.callsTo('usageRecord', 'upsert')
  const refunds = prisma.callsTo('usageRecord', 'updateMany')
  assert.equal(reserves.length, 2, 'both leads reserved AI usage before generating')
  assert.equal(refunds.length, 2, 'both failure paths refunded the reservation — no silent quota burn')
  assert.equal(result.failed, 1, 'the thrown-error path fails the lead (BullMQ-visible)')
  assert.equal(result.skippedByReason.AI_GENERATION_FAILED, 1, 'the malformed-output path is recorded as a skip, not a crash')
  // Both claims must be released (deleted) on these pre-dispatch aborts.
  assert.equal(prisma.callsTo('outreachSent', 'delete').length, 2)
})

// ── Approval gate cannot be bypassed by generating anyway ───────────────────
test('operational chaos: an unapproved lead is skipped before any AI generation runs — the approval gate cannot be bypassed at send time', async () => {
  const leads: LeadFixture[] = [{ id: 'l1' }] // no APPROVED draft
  install(baseSpec(leads, { workspaceICP: { findUnique: async () => ({ approvalMode: true, dailySendLimit: 0, monthlySendLimit: 0, warmupStartedAt: null }) } }))

  let generationCalls = 0
  const result = await sendCampaignBatch(CAMPAIGN, WORKSPACE, undefined, undefined, {
    sendMail: mailStub().fn,
    generateOutreach: (async () => { generationCalls++; return '{}' }) as unknown as GenerateOutreachFn,
  })

  assert.equal(generationCalls, 0, 'approval mode must never fall through to generation')
  assert.equal(result.skippedByReason.NO_APPROVED_DRAFT, 1)
  assert.equal(prisma.callsTo('outreachSent', 'create').length, 0, 'no claim is taken for a lead that will never be sent')
})

// ── Mid-batch operator pause halts the rest of the batch ────────────────────
test('operational chaos: an operator pause mid-batch halts remaining sends in the same run (not just future launches)', async () => {
  const leads: LeadFixture[] = [
    { id: 'l1', draft: { subject: 'Hi', emailBody: 'Body' } },
    { id: 'l2', draft: { subject: 'Hi', emailBody: 'Body' } },
  ]
  let missionChecks = 0
  install(baseSpec(leads, {
    mission: {
      findUnique: async () => {
        missionChecks++
        // Call order: 1) the batch's own missionCtx (offer/targetCustomer) fetch,
        // 2) the pre-batch getMissionSendBlockReason check, 3) the per-lead
        // recheck before l1, 4) the per-lead recheck before l2 — paused mid-run.
        return missionChecks >= 4 ? { status: 'PAUSED' } : { status: 'ACTIVE' }
      },
    },
  }))
  const { fn: sendMail, calls } = mailStub()

  const result = await sendCampaignBatch(CAMPAIGN, WORKSPACE, undefined, undefined, { sendMail })

  assert.deepEqual(calls, ['l1@example.com'], 'l1 sent before the pause was observed; l2 never dispatched')
  assert.equal(result.sent, 1)
  assert.equal(result.skippedByReason.MISSION_PAUSED, 1)
})

// ── The atomic per-lead daily-cap reservation is the real enforcement ───────
test('operational chaos: the atomic daily-cap reservation blocks a send even when the pre-batch forecast was permissive', async () => {
  const leads: LeadFixture[] = [{ id: 'l1', draft: { subject: 'Hi', emailBody: 'Body' } }]
  let countCalls = 0
  install(baseSpec(leads, {
    workspaceICP: { findUnique: async () => ({ approvalMode: false, dailySendLimit: 1, monthlySendLimit: 0, warmupStartedAt: null }) },
    outreachSent: {
      count: async () => {
        countCalls++
        // 1st call: the pre-batch fast-path forecast — reports the cap as NOT yet
        // reached, so the batch proceeds into the per-lead loop.
        if (countCalls === 1) return 0
        // 2nd call: reserveDailySendSlot's own atomic, advisory-locked read inside
        // the claim transaction — the actual source of truth — reports the cap as
        // already used. This is the property the forecast can only ever mirror,
        // never replace.
        return 1
      },
      groupBy: async () => [], findMany: async () => [],
      create: async (a: any) => ({ id: `claim-${a.data.leadId}` }),
      update: async () => ({}), delete: async () => ({}),
    },
  }))
  const { fn: sendMail, calls } = mailStub()

  const result = await sendCampaignBatch(CAMPAIGN, WORKSPACE, undefined, undefined, { sendMail })

  assert.equal(calls.length, 0, 'SMTP is never reached once the atomic reservation reports the cap is used')
  assert.equal(result.sent, 0)
  assert.equal(result.skippedByReason.DAILY_CAP, 1)
})

// ── OutreachIntent provenance: stamped on the claim, advanced only after ────
test('operational chaos: a linked approved intent is stamped onto the claim and advanced to SENT only after the send succeeds', async () => {
  const leads: LeadFixture[] = [{ id: 'l1', draft: { subject: 'Hi', emailBody: 'Body' } }]
  install(baseSpec(leads, {
    outreachIntent: {
      findMany: async () => [{ leadId: 'l1', id: 'int1', recommendationId: 'rec1', evidenceSnapshot: { signal: 'FUNDING' } }],
      update: async () => ({}),
    },
  }))
  await sendCampaignBatch(CAMPAIGN, WORKSPACE, undefined, undefined, { sendMail: mailStub().fn })

  const create = prisma.callsTo('outreachSent', 'create')[0].args[0] as any
  assert.equal(create.data.outreachIntentId, 'int1')
  assert.equal(create.data.recommendationId, 'rec1')
  assert.deepEqual(create.data.evidenceSnapshot, { signal: 'FUNDING' })

  const intentUpdate = prisma.callsTo('outreachIntent', 'update')
  assert.equal(intentUpdate.length, 1)
  assert.deepEqual((intentUpdate[0].args[0] as any), { where: { id: 'int1' }, data: { status: 'SENT' } })

  const createIdx = prisma.__calls.findIndex((c: RecordedCall) => c.model === 'outreachSent' && c.method === 'create')
  const intentUpdateIdx = prisma.__calls.findIndex((c: RecordedCall) => c.model === 'outreachIntent' && c.method === 'update')
  assert.ok(createIdx < intentUpdateIdx, 'the intent only advances to SENT after the claim exists — never before a send is actually recorded')
})

test('operational chaos: a lead with no linked intent never touches OutreachIntent at all', async () => {
  const leads: LeadFixture[] = [{ id: 'l1', draft: { subject: 'Hi', emailBody: 'Body' } }]
  install(baseSpec(leads)) // default outreachIntent.findMany → []
  await sendCampaignBatch(CAMPAIGN, WORKSPACE, undefined, undefined, { sendMail: mailStub().fn })
  assert.equal(prisma.callsTo('outreachIntent', 'update').length, 0)
  const create = prisma.callsTo('outreachSent', 'create')[0].args[0] as any
  assert.equal(create.data.outreachIntentId, undefined)
})
