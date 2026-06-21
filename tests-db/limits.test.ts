// Database-backed test for the atomic AI-usage limit (CORR-2): concurrent
// requests must never push usage past the plan cap.

import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { checkAndIncrementAiUsage, refundAiUsage, getMonthlyUsage } from '../packages/backend-core/src/lib/limits.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace } from './helpers/db.ts'

after(async () => { await disconnect() })
beforeEach(async () => { await resetDb() })

const monthNow = () => new Date().toISOString().slice(0, 7)

test('concurrent AI-usage increments never exceed the free plan cap', async () => {
  const { workspace } = await seedUserWithWorkspace() // free plan: 15/month

  // Fire 30 concurrent calls; only 15 may succeed.
  const results = await Promise.allSettled(
    Array.from({ length: 30 }, () => checkAndIncrementAiUsage(workspace.id, 'AI_RESEARCH'))
  )
  const ok = results.filter((r) => r.status === 'fulfilled').length
  const rejected = results.filter((r) => r.status === 'rejected').length

  assert.ok(ok <= 15, `at most 15 should succeed, got ${ok}`)
  assert.ok(ok >= 1, 'some should succeed')
  assert.equal(ok + rejected, 30)

  // The persisted total never exceeds the cap (over-limit increments refunded).
  const records = await prisma.usageRecord.findMany({
    where: { workspaceId: workspace.id, month: monthNow() },
  })
  const persisted = records.reduce((s, r) => s + r.count, 0)
  assert.ok(persisted <= 15, `persisted usage ${persisted} must not exceed 15`)
  assert.equal(persisted, ok, 'persisted count matches successful calls')
})

test('refundAiUsage returns a reserved call and floors at zero', async () => {
  const { workspace } = await seedUserWithWorkspace()

  await checkAndIncrementAiUsage(workspace.id, 'AI_OUTREACH')
  await checkAndIncrementAiUsage(workspace.id, 'AI_OUTREACH')
  // One reserved call produced no usable draft → refund it.
  await refundAiUsage(workspace.id, 'AI_OUTREACH')
  let usage = await getMonthlyUsage(workspace.id)
  assert.equal(usage.totals.AI_OUTREACH, 1, 'one refund leaves a single billed call')

  // Refund the last one, then refund again past zero — must never go negative.
  await refundAiUsage(workspace.id, 'AI_OUTREACH')
  await refundAiUsage(workspace.id, 'AI_OUTREACH')
  usage = await getMonthlyUsage(workspace.id)
  assert.equal(usage.totals.AI_OUTREACH, 0, 'refunds floor at zero, never negative')
})

test('a growth (unlimited) workspace accepts many concurrent calls', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await prisma.workspace.update({ where: { id: workspace.id }, data: { plan: 'growth', subscriptionStatus: 'active' } })

  const results = await Promise.allSettled(
    Array.from({ length: 25 }, () => checkAndIncrementAiUsage(workspace.id, 'AI_OUTREACH'))
  )
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 25)
})

// --- downgrade / lapsed-subscription entitlement (audit gap) ---
// A paid plan whose Stripe subscription has lapsed (past_due / canceled /
// incomplete) must be treated as free: getWorkspacePlan() returns 'free' for any
// non-'active' status, and every gate routes through it. These verify the
// entitlement actually reverts, not just the reported plan.

for (const status of ['past_due', 'canceled', 'incomplete'] as const) {
  test(`a ${status} subscription is metered as the free plan`, async () => {
    const { workspace } = await seedUserWithWorkspace()
    // Paid plan on record, but the subscription has lapsed.
    await prisma.workspace.update({ where: { id: workspace.id }, data: { plan: 'growth', subscriptionStatus: status } })

    const usage = await getMonthlyUsage(workspace.id)
    assert.equal(usage.plan, 'free', 'effective plan reverts to free')
    assert.equal(usage.limit, 15, 'free AI cap applies, not growth/unlimited')
    assert.equal(usage.leads.limit, 500, 'free lead cap applies')
  })
}

test('a lapsed growth subscription enforces the free AI cap (not just reports it)', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await prisma.workspace.update({ where: { id: workspace.id }, data: { plan: 'growth', subscriptionStatus: 'past_due' } })

  // Were this still active growth, all 20 would succeed (unlimited). Lapsed → free
  // cap of 15 must reject the rest.
  const results = await Promise.allSettled(
    Array.from({ length: 20 }, () => checkAndIncrementAiUsage(workspace.id, 'AI_RESEARCH'))
  )
  const ok = results.filter((r) => r.status === 'fulfilled').length
  assert.ok(ok <= 15, `lapsed subscription must enforce the free cap, got ${ok}`)
  assert.ok(ok >= 1, 'some calls should still succeed under the free cap')
})

test('the DB rejects a plan value outside the BillingPlan enum', async () => {
  const { workspace } = await seedUserWithWorkspace()
  // Bypass Prisma's client-side typing with a raw write to prove the column type
  // itself (not just the TS layer) enforces the closed set of plans.
  await assert.rejects(
    () => prisma.$executeRawUnsafe(
      `UPDATE "Workspace" SET "plan" = 'enterprise' WHERE "id" = $1`, workspace.id,
    ),
    /invalid input value for enum "BillingPlan"/i,
  )
})
