// Database-backed tests for reserveLeadCapacity: the atomic plan lead-cap
// reservation that ingest and bulk import rely on. Runs against real PostgreSQL
// so the advisory lock and row counting are genuinely exercised — the fake
// client cannot model the serialization that prevents concurrent oversell.

import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { reserveLeadCapacity } from '../packages/backend-core/src/lib/limits.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace } from './helpers/db.ts'

after(async () => { await disconnect() })
beforeEach(async () => { await resetDb() })

async function seedLeads(workspaceId: string, n: number) {
  if (n <= 0) return
  await prisma.lead.createMany({
    data: Array.from({ length: n }, (_, i) => ({ workspaceId, businessName: `Seed ${i}` })),
  })
}

// Mirror what the routes do: reserve capacity, then insert exactly that many,
// all inside one transaction holding the per-workspace advisory lock.
async function reserveAndInsert(workspaceId: string, requested: number): Promise<number> {
  return prisma.$transaction(async (tx) => {
    const allowed = await reserveLeadCapacity(tx, workspaceId, requested)
    for (let i = 0; i < allowed; i++) {
      await tx.lead.create({ data: { workspaceId, businessName: `New ${Math.random()}` } })
    }
    return allowed
  })
}

test('returns the exact remaining capacity below the free cap', async () => {
  const { workspace } = await seedUserWithWorkspace() // free plan: 500 leads
  await seedLeads(workspace.id, 498)

  const allowed = await prisma.$transaction((tx) => reserveLeadCapacity(tx, workspace.id, 5))
  assert.equal(allowed, 2, 'only 2 of 5 requested fit under the 500 cap')
})

test('returns 0 when already at the cap', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await seedLeads(workspace.id, 500)
  const allowed = await prisma.$transaction((tx) => reserveLeadCapacity(tx, workspace.id, 10))
  assert.equal(allowed, 0)
})

test('an unlimited (growth) workspace grants the full request', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await prisma.workspace.update({ where: { id: workspace.id }, data: { plan: 'growth', subscriptionStatus: 'active' } })
  await seedLeads(workspace.id, 1000)
  const allowed = await prisma.$transaction((tx) => reserveLeadCapacity(tx, workspace.id, 250))
  assert.equal(allowed, 250)
})

test('concurrent reservations cannot collectively overshoot the cap', async () => {
  const { workspace } = await seedUserWithWorkspace() // free: 500
  await seedLeads(workspace.id, 495) // 5 slots left

  // 10 concurrent batches each wanting 3 leads = 30 demanded, only 5 may land.
  const results = await Promise.all(
    Array.from({ length: 10 }, () => reserveAndInsert(workspace.id, 3))
  )
  const totalAllowed = results.reduce((s, n) => s + n, 0)
  assert.equal(totalAllowed, 5, `exactly 5 should be granted across all batches, got ${totalAllowed}`)

  const finalCount = await prisma.lead.count({ where: { workspaceId: workspace.id } })
  assert.equal(finalCount, 500, 'the cap is reached exactly, never exceeded')
})
