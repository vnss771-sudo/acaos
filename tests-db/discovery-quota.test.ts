// Database-backed tests for the per-workspace monthly discovery quota and the
// (previously latent) separation of discovery usage from the AI limit.

import { test, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { checkAndIncrementDiscoveryUsage, checkAndIncrementAiUsage, getMonthlyUsage } from '../apps/api/src/lib/limits.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace } from './helpers/db.ts'

test('getMonthlyUsage reports discovery + lead usage with plan limits', async () => {
  const { workspace } = await seedUserWithWorkspace() // free plan
  await checkAndIncrementDiscoveryUsage(workspace.id)
  await prisma.lead.create({ data: { workspaceId: workspace.id, businessName: 'L1' } })
  await prisma.lead.create({ data: { workspaceId: workspace.id, businessName: 'L2' } })

  const u = await getMonthlyUsage(workspace.id)
  assert.equal(u.discovery.used, 1)
  assert.equal(u.discovery.limit, 25)  // free plan
  assert.equal(u.leads.used, 2)
  assert.equal(u.leads.limit, 500)     // free plan
})

after(async () => { await disconnect() })
beforeEach(async () => { await resetDb() })

function currentMonth(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

test('discovery quota: free plan allows 25 runs then blocks the 26th', async () => {
  const { workspace } = await seedUserWithWorkspace()
  for (let i = 0; i < 25; i++) await checkAndIncrementDiscoveryUsage(workspace.id)
  await assert.rejects(
    () => checkAndIncrementDiscoveryUsage(workspace.id),
    /discovery limit reached/i,
  )
})

test('discovery usage does not count against the AI monthly limit', async () => {
  const { workspace } = await seedUserWithWorkspace()
  // 20 discovery runs — more than the free AI cap (15). If discovery counted
  // toward AI, the AI call below would be rejected.
  for (let i = 0; i < 20; i++) await checkAndIncrementDiscoveryUsage(workspace.id)
  await checkAndIncrementAiUsage(workspace.id, 'AI_RESEARCH') // must succeed

  const ai = await prisma.usageRecord.findUnique({
    where: { workspaceId_month_action: { workspaceId: workspace.id, month: currentMonth(), action: 'AI_RESEARCH' } },
  })
  assert.equal(ai!.count, 1)
  const disc = await prisma.usageRecord.findUnique({
    where: { workspaceId_month_action: { workspaceId: workspace.id, month: currentMonth(), action: 'DISCOVERY' } },
  })
  assert.equal(disc!.count, 20)
})
