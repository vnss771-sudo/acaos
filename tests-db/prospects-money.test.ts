// Database-backed round-trip tests for CORR-7: money is sent/received as whole
// units but stored as integer cents.

import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { prospectsRouter } from '../apps/api/src/routes/prospects.ts'
import { intelligenceRouter } from '../apps/api/src/routes/intelligence.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace, startTestServer, bearer, type TestServer } from './helpers/db.ts'

let prospects: TestServer
let intel: TestServer
before(async () => {
  prospects = await startTestServer('/api/prospects', prospectsRouter)
  intel = await startTestServer('/api/intelligence', intelligenceRouter)
})
after(async () => { await prospects.close(); await intel.close(); await disconnect() })
beforeEach(async () => { await resetDb() })

test('a prospect created with whole-unit money is stored as cents and read back as units', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const create = await prospects.request('/api/prospects', {
    method: 'POST',
    headers: { Authorization: bearer(user.id), 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceId: workspace.id, companyName: 'Acme', expectedDealValue: 5000, estimatedRevenue: 120000 }),
  })
  assert.equal(create.status, 201)
  // API returns whole units.
  assert.equal(create.body.expectedDealValue, 5000)
  assert.equal(create.body.estimatedRevenue, 120000)

  // Database stores cents.
  const row = await prisma.prospect.findUnique({ where: { id: create.body.id } })
  assert.equal(row!.expectedDealValue, 500000)
  assert.equal(row!.estimatedRevenue, 12000000)

  // GET reads back whole units.
  const get = await prospects.request(`/api/prospects/${create.body.id}`, { headers: { Authorization: bearer(user.id) } })
  assert.equal(get.body.expectedDealValue, 5000)
})

test('outcome dealValue round-trips through cents', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const p = await prisma.prospect.create({ data: { workspaceId: workspace.id, companyName: 'Acme' } })

  const res = await prospects.request(`/api/prospects/${p.id}/outcome`, {
    method: 'POST',
    headers: { Authorization: bearer(user.id), 'Content-Type': 'application/json' },
    body: JSON.stringify({ stage: 'WON', dealValue: 2500 }),
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.outcome.dealValue, 2500) // units out

  const stored = await prisma.prospectOutcome.findFirst({ where: { prospectId: p.id } })
  assert.equal(stored!.dealValue, 250000) // cents in DB
})

test('forecast computes whole-unit revenue from cents-stored deal values', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  // expectedDealValue 10000 units => 1_000_000 cents; winProbability 0.5.
  await prisma.prospect.create({
    data: { workspaceId: workspace.id, companyName: 'Acme', expectedDealValue: 1_000_000, winProbability: 0.5, opportunityScore: 80, buyingStage: 'PURCHASING' },
  })

  const res = await intel.request(`/api/intelligence/forecast?workspaceId=${workspace.id}`, {
    headers: { Authorization: bearer(user.id) },
  })
  assert.equal(res.status, 200)
  // dealValue 10000 * 0.5 = 5000 (whole units), not 5_000_00 cents.
  assert.equal(res.body.summary.totalPipelineValue, 10000)
  assert.equal(res.body.summary.weightedForecast, 5000)
})
