// Tests for the REAL lib/limits.ts enforcement paths.
//
// The existing lib-limits.test.ts only covers an inlined copy of the pure
// helpers. These exercise the actual exported functions that gate AI usage and
// lead creation against the database — the real plan-bypass surface, including
// the lapsed-subscription downgrade.

import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  checkAndIncrementAiUsage,
  assertAiUsageAllowed,
  checkLeadLimit,
  getMonthlyUsage,
  getPlanInfo,
  getPlanCatalog,
  utcMonthStart,
} from '../packages/backend-core/src/lib/limits.ts'
import { createFakePrisma, installPrisma, resetPrisma, type FakePrisma } from './helpers/integration.ts'

type WsRow = { plan: string; subscriptionStatus: string | null }

function spec(opts: {
  workspace?: WsRow
  aiUsed?: number
  // Per-action call counts, for tests that need to model a specific dollar
  // spend (each action has a different per-call cost in aiCost.ts). Overrides
  // aiUsed when given.
  records?: Array<{ action: string; count: number }>
  leadCount?: number
}) {
  const { workspace = { plan: 'free', subscriptionStatus: null }, aiUsed = 0, leadCount = 0 } = opts
  // Stateful AI usage so the increment-then-check-then-refund flow is modeled
  // realistically: upsert increments, findMany reflects it, update refunds.
  let count = aiUsed
  const records = opts.records
  return {
    workspace: {
      findUnique: async () => workspace,
    },
    usageRecord: {
      findMany: async () => (records ?? (count > 0 ? [{ action: 'AI_RESEARCH', count }] : [])),
      upsert: async () => { count += 1; return { id: 'u1' } },
      update: async () => { count -= 1; return { id: 'u1' } },
    },
    lead: {
      count: async () => leadCount,
    },
    discoveryRun: { groupBy: async () => [] },
  }
}

let prisma: FakePrisma

function install(s: ReturnType<typeof spec>) {
  prisma = createFakePrisma(s)
  installPrisma(prisma)
}

afterEach(() => resetPrisma())

// --- getPlanInfo (pure) ---

test('getPlanInfo resolves known plans and defaults unknown to free', () => {
  assert.equal(getPlanInfo('growth').plan, 'growth')
  assert.equal(getPlanInfo('starter').aiCallsPerMonth, 300)
  assert.equal(getPlanInfo('nonsense').plan, 'free')
  assert.equal(getPlanInfo('free').maxLeads, 500)
})

// --- checkAndIncrementAiUsage ---

test('AI usage increments when under the free limit', async () => {
  install(spec({ aiUsed: 5 }))
  await checkAndIncrementAiUsage('ws1', 'AI_RESEARCH')
  assert.equal(prisma.callsTo('usageRecord', 'upsert').length, 1)
})

test('AI usage throws 429 at the free limit without incrementing', async () => {
  install(spec({ aiUsed: 15 })) // already at the free cap of 15
  await assert.rejects(
    () => checkAndIncrementAiUsage('ws1', 'AI_RESEARCH'),
    (err: any) => err.statusCode === 429
  )
  // The advisory-locked check rejects before incrementing.
  assert.equal(prisma.callsTo('usageRecord', 'upsert').length, 0)
})

test('growth plan never enforces an AI cap', async () => {
  install(spec({ workspace: { plan: 'growth', subscriptionStatus: 'active' }, aiUsed: 10_000 }))
  await checkAndIncrementAiUsage('ws1', 'AI_OUTREACH')
  assert.equal(prisma.callsTo('usageRecord', 'upsert').length, 1)
})

// --- assertAiUsageAllowed: dollar-based spend ceiling (independent of call count) ---

test('assertAiUsageAllowed is read-only — it never increments usage', async () => {
  install(spec({ aiUsed: 5 }))
  await assertAiUsageAllowed('ws1')
  assert.equal(prisma.callsTo('usageRecord', 'upsert').length, 0)
})

test('growth plan has no call-count cap but IS blocked by the dollar spend ceiling', async () => {
  // AI_RESEARCH costs 0.1 cents/call by default; 500,000 calls = 50,000 cents,
  // exactly the default growth ceiling ($500) — growth's aiCallsPerMonth is
  // Infinity, so only the dollar ceiling can stop this.
  install(spec({
    workspace: { plan: 'growth', subscriptionStatus: 'active' },
    records: [{ action: 'AI_RESEARCH', count: 500_000 }],
  }))
  await assert.rejects(
    () => assertAiUsageAllowed('ws1'),
    (err: any) => err.statusCode === 429 && /spend ceiling/i.test(err.message)
  )
})

test('growth plan is allowed one cent below its dollar spend ceiling', async () => {
  install(spec({
    workspace: { plan: 'growth', subscriptionStatus: 'active' },
    records: [{ action: 'AI_RESEARCH', count: 499_990 }], // 49,999.00 cents, just under $500
  }))
  await assertAiUsageAllowed('ws1') // should not throw
})

test('checkAndIncrementAiUsage also enforces the dollar ceiling, not just the read-only check', async () => {
  install(spec({
    workspace: { plan: 'growth', subscriptionStatus: 'active' },
    records: [{ action: 'AI_RESEARCH', count: 500_000 }],
  }))
  await assert.rejects(
    () => checkAndIncrementAiUsage('ws1', 'AI_OUTREACH'),
    (err: any) => err.statusCode === 429
  )
  assert.equal(prisma.callsTo('usageRecord', 'upsert').length, 0)
})

test('the per-plan dollar ceiling is overridable via AI_SPEND_CEILING_CENTS_<PLAN>', async () => {
  const prev = process.env.AI_SPEND_CEILING_CENTS_GROWTH
  process.env.AI_SPEND_CEILING_CENTS_GROWTH = '10' // 10 cents — trivially low
  try {
    install(spec({
      workspace: { plan: 'growth', subscriptionStatus: 'active' },
      records: [{ action: 'AI_RESEARCH', count: 1 }], // 0.1 cents, below the 10-cent override
    }))
    await assertAiUsageAllowed('ws1') // should not throw

    install(spec({
      workspace: { plan: 'growth', subscriptionStatus: 'active' },
      records: [{ action: 'AI_RESEARCH', count: 200 }], // 20 cents — over the 10-cent override
    }))
    await assert.rejects(() => assertAiUsageAllowed('ws1'), (err: any) => err.statusCode === 429)
  } finally {
    if (prev === undefined) delete process.env.AI_SPEND_CEILING_CENTS_GROWTH
    else process.env.AI_SPEND_CEILING_CENTS_GROWTH = prev
  }
})

test('a lapsed subscription is downgraded to free limits (no plan bypass)', async () => {
  // Workspace claims the growth plan but the subscription is past_due, so the
  // free cap of 15 must apply.
  install(spec({ workspace: { plan: 'growth', subscriptionStatus: 'past_due' }, aiUsed: 15 }))
  await assert.rejects(
    () => checkAndIncrementAiUsage('ws1', 'AI_RESEARCH'),
    (err: any) => err.statusCode === 429
  )
  assert.equal(prisma.callsTo('usageRecord', 'upsert').length, 0)
})

// --- checkLeadLimit ---

test('lead creation is blocked at exactly the free cap (>= boundary)', async () => {
  install(spec({ leadCount: 500 }))
  await assert.rejects(
    () => checkLeadLimit('ws1'),
    (err: any) => err.statusCode === 429
  )
})

test('lead creation is allowed one below the free cap', async () => {
  install(spec({ leadCount: 499 }))
  await checkLeadLimit('ws1') // should not throw
})

test('growth plan has no lead cap', async () => {
  install(spec({ workspace: { plan: 'growth', subscriptionStatus: 'active' }, leadCount: 1_000_000 }))
  await checkLeadLimit('ws1') // should not throw
  // Unlimited plan short-circuits before counting.
  assert.equal(prisma.callsTo('lead', 'count').length, 0)
})

// --- getMonthlyUsage ---

test('getMonthlyUsage reports totals and an unlimited cap as -1', async () => {
  install(spec({ workspace: { plan: 'growth', subscriptionStatus: 'active' }, aiUsed: 3 }))
  const usage = await getMonthlyUsage('ws1')
  assert.equal(usage.plan, 'growth')
  assert.equal(usage.limit, -1)
  assert.equal(usage.total, 3)
  assert.equal(usage.totals.AI_RESEARCH, 3)
})

// --- getPlanCatalog (single source of truth for the billing UI) ---

test('getPlanCatalog exposes every plan with JSON-safe limits (Infinity -> null)', () => {
  const catalog = getPlanCatalog()
  assert.deepEqual(Object.keys(catalog).sort(), ['free', 'growth', 'starter'])
  // Finite limits pass through unchanged...
  assert.equal(catalog.free.maxLeads, 500)
  assert.equal(catalog.free.aiCallsPerMonth, 15)
  assert.equal(catalog.starter.maxLeads, 10_000)
  assert.equal(catalog.starter.aiCallsPerMonth, 300)
  // ...and unlimited (Infinity) becomes null so it survives JSON serialization.
  assert.equal(catalog.growth.maxLeads, null)
  assert.equal(catalog.growth.aiCallsPerMonth, null)
  assert.equal(catalog.growth.discoveriesPerMonth, null)
})

test('getPlanCatalog matches getPlanInfo for the enforced numbers', () => {
  const catalog = getPlanCatalog()
  for (const plan of ['free', 'starter'] as const) {
    const info = getPlanInfo(plan)
    assert.equal(catalog[plan].maxLeads, info.maxLeads)
    assert.equal(catalog[plan].aiCallsPerMonth, info.aiCallsPerMonth)
  }
})

test('utcMonthStart returns midnight on the first of the UTC month', () => {
  const s = utcMonthStart(new Date('2026-06-22T15:30:00Z'))
  assert.equal(s.toISOString(), '2026-06-01T00:00:00.000Z')
  // Works at a month boundary regardless of local tz (UTC-based).
  assert.equal(utcMonthStart(new Date('2026-01-31T23:59:59Z')).toISOString(), '2026-01-01T00:00:00.000Z')
})
