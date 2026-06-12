// Tests for the REAL lib/limits.ts enforcement paths.
//
// The existing lib-limits.test.ts only covers an inlined copy of the pure
// helpers. These exercise the actual exported functions that gate AI usage and
// lead creation against the database — the real plan-bypass surface, including
// the lapsed-subscription downgrade.

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  checkAndIncrementAiUsage,
  checkLeadLimit,
  getMonthlyUsage,
  getPlanInfo,
} from '../apps/api/src/lib/limits.ts'
import { createFakePrisma, installPrisma, resetPrisma, type FakePrisma } from './helpers/integration.ts'

type WsRow = { plan: string; subscriptionStatus: string | null }

function spec(opts: {
  workspace?: WsRow
  aiUsed?: number
  leadCount?: number
}) {
  const { workspace = { plan: 'free', subscriptionStatus: null }, aiUsed = 0, leadCount = 0 } = opts
  // Represent current AI usage as a single record so findMany.reduce == aiUsed.
  const usageRecords = aiUsed > 0 ? [{ action: 'AI_RESEARCH', count: aiUsed }] : []
  return {
    workspace: {
      findUnique: async () => workspace,
    },
    usageRecord: {
      findMany: async () => usageRecords,
      upsert: async () => ({ id: 'u1' }),
    },
    lead: {
      count: async () => leadCount,
    },
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

test('AI usage throws 429 at the free limit and does NOT increment', async () => {
  install(spec({ aiUsed: 15 })) // free cap is 15, boundary is `>=`
  await assert.rejects(
    () => checkAndIncrementAiUsage('ws1', 'AI_RESEARCH'),
    (err: any) => err.statusCode === 429
  )
  assert.equal(prisma.callsTo('usageRecord', 'upsert').length, 0)
})

test('growth plan never enforces an AI cap', async () => {
  install(spec({ workspace: { plan: 'growth', subscriptionStatus: 'active' }, aiUsed: 10_000 }))
  await checkAndIncrementAiUsage('ws1', 'AI_OUTREACH')
  assert.equal(prisma.callsTo('usageRecord', 'upsert').length, 1)
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
