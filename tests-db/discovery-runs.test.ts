// Database-backed tests for the DiscoveryRun audit endpoint. Verifies that
// discovery runs are listed (newest first), scoped to workspace members, and that
// GET /discovery-runs is matched before GET /:id (not treated as a prospect id).

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { prospectsRouter } from '../apps/api/src/routes/prospects.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace, startTestServer, bearer, type TestServer } from './helpers/db.ts'

let server: TestServer
before(async () => { server = await startTestServer('/api/prospects', prospectsRouter) })
after(async () => { await server.close(); await disconnect() })
beforeEach(async () => { await resetDb() })

test('GET /discovery-runs lists runs newest-first (not shadowed by /:id)', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  await prisma.discoveryRun.create({
    data: { workspaceId: workspace.id, source: 'apollo', status: 'FAILED', errorCode: 'QUOTA', errorMessage: 'quota exceeded', resultCount: 0 },
  })
  await prisma.discoveryRun.create({
    data: { workspaceId: workspace.id, source: 'apollo', status: 'SUCCEEDED', resultCount: 10, importedCount: 7, skippedCount: 3 },
  })

  const res = await server.request(`/api/prospects/discovery-runs?workspaceId=${workspace.id}`, {
    headers: { Authorization: bearer(user.id) },
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.runs.length, 2)
  assert.equal(res.body.runs[0].status, 'SUCCEEDED') // newest first
  assert.equal(res.body.runs[1].errorCode, 'QUOTA')  // failures are visible
})

test('GET /discovery-runs denies a non-member', async () => {
  const a = await seedUserWithWorkspace('a@x.test')
  const b = await seedUserWithWorkspace('b@x.test')
  const res = await server.request(`/api/prospects/discovery-runs?workspaceId=${b.workspace.id}`, {
    headers: { Authorization: bearer(a.user.id) },
  })
  assert.equal(res.status, 403)
})
