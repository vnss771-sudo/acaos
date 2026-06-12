// Database-backed integration tests for /api/signals.
//
// Runs the real router against real PostgreSQL: real membership lookups, real
// signal rows, and a real prospect rescore side effect. Confirms the workspace
// isolation fix holds against actual queries, not just a fake.

import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { signalsRouter } from '../apps/api/src/routes/signals.ts'
import {
  prisma,
  resetDb,
  disconnect,
  seedUserWithWorkspace,
  startTestServer,
  bearer,
  type TestServer,
} from './helpers/db.ts'

let server: TestServer

before(async () => {
  server = await startTestServer('/api/signals', signalsRouter)
})

after(async () => {
  await server.close()
  await disconnect()
})

beforeEach(async () => {
  await resetDb()
})

async function seedProspect(workspaceId: string) {
  return prisma.prospect.create({
    data: {
      workspaceId,
      companyName: 'Acme Co',
      industry: 'construction',
      employeeCount: 50,
      contactEmail: 'c@acme.test',
      contactName: 'Cee',
      domain: 'acme.test',
    },
  })
}

test('GET returns only the requesting member\'s workspace signals', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const prospect = await seedProspect(workspace.id)
  await prisma.signal.create({
    data: { workspaceId: workspace.id, prospectId: prospect.id, type: 'FUNDING', strength: 80 },
  })

  const res = await server.request(`/api/signals?workspaceId=${workspace.id}`, {
    headers: { Authorization: bearer(user.id) },
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.signals.length, 1)
  assert.equal(res.body.signals[0].type, 'FUNDING')
})

test('GET denies a workspace the user is not a member of', async () => {
  const a = await seedUserWithWorkspace('a@acme.test')
  const b = await seedUserWithWorkspace('b@acme.test')

  const res = await server.request(`/api/signals?workspaceId=${b.workspace.id}`, {
    headers: { Authorization: bearer(a.user.id) },
  })
  assert.equal(res.status, 403)
})

test('POST creates a signal and rescores the prospect (real columns persisted)', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const prospect = await seedProspect(workspace.id)

  const res = await server.request('/api/signals', {
    method: 'POST',
    headers: { Authorization: bearer(user.id), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workspaceId: workspace.id,
      prospectId: prospect.id,
      type: 'FUNDING',
      strength: 90,
    }),
  })
  assert.equal(res.status, 201)

  // The signal row exists and the prospect was rescored + lastSignalAt set.
  assert.equal(await prisma.signal.count({ where: { prospectId: prospect.id } }), 1)
  const updated = await prisma.prospect.findUnique({ where: { id: prospect.id } })
  assert.ok(updated!.lastSignalAt)
  assert.ok(updated!.opportunityScore >= 0)
})

test('POST rejects a prospect that belongs to another workspace', async () => {
  const a = await seedUserWithWorkspace('a@acme.test')
  const b = await seedUserWithWorkspace('b@acme.test')
  const otherProspect = await seedProspect(b.workspace.id)

  const res = await server.request('/api/signals', {
    method: 'POST',
    headers: { Authorization: bearer(a.user.id), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workspaceId: a.workspace.id,
      prospectId: otherProspect.id,
      type: 'FUNDING',
      strength: 50,
    }),
  })
  assert.equal(res.status, 403)
  assert.equal(await prisma.signal.count(), 0)
})

test('DELETE removes a signal in the owned workspace but not another\'s', async () => {
  const a = await seedUserWithWorkspace('a@acme.test')
  const b = await seedUserWithWorkspace('b@acme.test')
  const pa = await seedProspect(a.workspace.id)
  const pb = await seedProspect(b.workspace.id)
  const sigA = await prisma.signal.create({
    data: { workspaceId: a.workspace.id, prospectId: pa.id, type: 'HIRING', strength: 40 },
  })
  const sigB = await prisma.signal.create({
    data: { workspaceId: b.workspace.id, prospectId: pb.id, type: 'HIRING', strength: 40 },
  })

  // Cannot delete another workspace's signal.
  const denied = await server.request(`/api/signals/${sigB.id}`, {
    method: 'DELETE',
    headers: { Authorization: bearer(a.user.id) },
  })
  assert.equal(denied.status, 403)
  assert.equal(await prisma.signal.count({ where: { id: sigB.id } }), 1)

  // Can delete own.
  const ok = await server.request(`/api/signals/${sigA.id}`, {
    method: 'DELETE',
    headers: { Authorization: bearer(a.user.id) },
  })
  assert.equal(ok.status, 200)
  assert.equal(await prisma.signal.count({ where: { id: sigA.id } }), 0)
})
