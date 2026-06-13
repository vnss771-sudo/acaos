// Database-backed test for the atomic AI-usage limit (CORR-2): concurrent
// requests must never push usage past the plan cap.

import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { checkAndIncrementAiUsage } from '../apps/api/src/lib/limits.ts'
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

test('a growth (unlimited) workspace accepts many concurrent calls', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await prisma.workspace.update({ where: { id: workspace.id }, data: { plan: 'growth', subscriptionStatus: 'active' } })

  const results = await Promise.allSettled(
    Array.from({ length: 25 }, () => checkAndIncrementAiUsage(workspace.id, 'AI_OUTREACH'))
  )
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 25)
})
