// Database-backed test for /api/intelligence/stats — verifies the tier
// distribution is computed correctly via SQL range counts (CORR-5), not by
// loading all prospects into memory.

import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { intelligenceRouter } from '../apps/api/src/routes/intelligence.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace, startTestServer, bearer, type TestServer } from './helpers/db.ts'

let server: TestServer
before(async () => { server = await startTestServer('/api/intelligence', intelligenceRouter) })
after(async () => { await server.close(); await disconnect() })
beforeEach(async () => { await resetDb() })

async function seedProspectWithScore(workspaceId: string, opportunityScore: number) {
  return prisma.prospect.create({
    data: { workspaceId, companyName: 'Acme', opportunityScore },
  })
}

test('stats buckets prospects into HOT/WARM/COLD by opportunity score', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  // HOT (>=72): 2, WARM (45-71): 3, COLD (<45): 1
  for (const s of [80, 90]) await seedProspectWithScore(workspace.id, s)
  for (const s of [45, 60, 71]) await seedProspectWithScore(workspace.id, s)
  await seedProspectWithScore(workspace.id, 10)

  const res = await server.request(`/api/intelligence/stats?workspaceId=${workspace.id}`, {
    headers: { Authorization: bearer(user.id) },
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.totalProspects, 6)
  assert.deepEqual(res.body.tierDistribution, { HOT: 2, WARM: 3, COLD: 1 })
})

test('stats tier counts are scoped to the workspace', async () => {
  const a = await seedUserWithWorkspace('a@acme.test')
  const b = await seedUserWithWorkspace('b@acme.test')
  await seedProspectWithScore(a.workspace.id, 80)
  await seedProspectWithScore(b.workspace.id, 80) // other workspace — must not count

  const res = await server.request(`/api/intelligence/stats?workspaceId=${a.workspace.id}`, {
    headers: { Authorization: bearer(a.user.id) },
  })
  assert.equal(res.body.tierDistribution.HOT, 1)
  assert.equal(res.body.totalProspects, 1)
})
