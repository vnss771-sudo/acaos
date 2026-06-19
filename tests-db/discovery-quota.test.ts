// Database-backed tests for the per-workspace monthly discovery quota and the
// (previously latent) separation of discovery usage from the AI limit.

import { test, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { checkAndIncrementDiscoveryUsage, checkAndIncrementAiUsage, getMonthlyUsage, getMonthlyDiscoveryCost } from '../packages/backend-core/src/lib/limits.ts'
import { DISCOVERY_PROVIDER_COST_CENTS } from '../packages/backend-core/src/lib/discoveryCost.ts'
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

test('getMonthlyDiscoveryCost weights recorded runs by provider', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await prisma.discoveryRun.createMany({
    data: [
      { workspaceId: workspace.id, source: 'apollo' },
      { workspaceId: workspace.id, source: 'apollo' },
      { workspaceId: workspace.id, source: 'google_places' },
      { workspaceId: workspace.id, source: 'example' }, // unpriced → free
    ],
  })

  const cost = await getMonthlyDiscoveryCost(workspace.id)
  const expected = DISCOVERY_PROVIDER_COST_CENTS.apollo * 2 + DISCOVERY_PROVIDER_COST_CENTS.google_places
  assert.equal(cost.totalCents, expected)
  assert.equal(cost.byProvider.apollo.runs, 2)
  assert.equal(cost.byProvider.apollo.costCents, DISCOVERY_PROVIDER_COST_CENTS.apollo * 2)
  assert.equal(cost.byProvider.example.costCents, 0)

  // And it surfaces through the aggregate usage view.
  const usage = await getMonthlyUsage(workspace.id)
  assert.equal(usage.discovery.estimatedCostCents, expected)
})
