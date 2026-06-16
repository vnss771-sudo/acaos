// Database-backed tests for /api/packs apply: seeding a workspace ICP from a
// vertical pack, with auth + unknown-pack guards.

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { packsRouter } from '../apps/api/src/routes/packs.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace, startTestServer, bearer, type TestServer } from './helpers/db.ts'

let server: TestServer
before(async () => { server = await startTestServer('/api/packs', packsRouter) })
after(async () => { await server.close(); await disconnect() })
beforeEach(async () => { await resetDb() })

const jsonAuth = (id: string) => ({ Authorization: bearer(id), 'Content-Type': 'application/json' })

test('GET /packs lists available packs', async () => {
  const { user } = await seedUserWithWorkspace()
  const res = await server.request('/api/packs', { headers: { Authorization: bearer(user.id) } })
  assert.equal(res.status, 200)
  assert.ok(res.body.packs.some((p: any) => p.id === 'fieldops'))
})

test('POST /packs/fieldops/apply seeds the workspace ICP', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const res = await server.request('/api/packs/fieldops/apply', {
    method: 'POST', headers: jsonAuth(user.id), body: JSON.stringify({ workspaceId: workspace.id }),
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.icp.playbook, 'fieldops')
  assert.ok(res.body.icp.targetIndustries.includes('electrical'))

  // Persisted + idempotent (applying again updates in place).
  const again = await server.request('/api/packs/fieldops/apply', {
    method: 'POST', headers: jsonAuth(user.id), body: JSON.stringify({ workspaceId: workspace.id }),
  })
  assert.equal(again.status, 200)
  assert.equal(await prisma.workspaceICP.count({ where: { workspaceId: workspace.id } }), 1)
})

test('POST apply denies a non-member workspace', async () => {
  const a = await seedUserWithWorkspace('a@x.test')
  const b = await seedUserWithWorkspace('b@x.test')
  const res = await server.request('/api/packs/fieldops/apply', {
    method: 'POST', headers: jsonAuth(a.user.id), body: JSON.stringify({ workspaceId: b.workspace.id }),
  })
  assert.equal(res.status, 403)
})

test('POST apply 404s for an unknown pack', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const res = await server.request('/api/packs/nope/apply', {
    method: 'POST', headers: jsonAuth(user.id), body: JSON.stringify({ workspaceId: workspace.id }),
  })
  assert.equal(res.status, 404)
})
