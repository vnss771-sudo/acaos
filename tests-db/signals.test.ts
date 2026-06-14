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

test('POST is idempotent: re-posting the same signal dedups via ON CONFLICT and updates in place', async () => {
  // Regression test for the Signal(prospectId, fingerprint) index. The route
  // upserts with `where: { prospectId_fingerprint }`, which Prisma compiles to
  // INSERT ... ON CONFLICT ("prospectId","fingerprint") DO UPDATE. A *partial*
  // unique index cannot serve as that ON CONFLICT arbiter, so this path failed
  // in production until the index was made full. The fingerprint is derived
  // from (source, type, title, detectedAt-month), so two posts with the same
  // inputs in the same month collide deterministically.
  const { user, workspace } = await seedUserWithWorkspace()
  const prospect = await seedProspect(workspace.id)

  const post = (strength: number) =>
    server.request('/api/signals', {
      method: 'POST',
      headers: { Authorization: bearer(user.id), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspaceId: workspace.id,
        prospectId: prospect.id,
        type: 'FUNDING',
        title: 'Series B raised',
        source: 'crunchbase',
        detectedAt: '2026-06-01T00:00:00.000Z',
        strength,
      }),
    })

  const first = await post(60)
  assert.equal(first.status, 201)
  const second = await post(95)
  assert.equal(second.status, 201)

  // Deduped to a single row (the DO UPDATE branch fired, not a second INSERT).
  assert.equal(await prisma.signal.count({ where: { prospectId: prospect.id } }), 1)
  // The update branch persisted the new strength.
  const rows = await prisma.signal.findMany({ where: { prospectId: prospect.id } })
  assert.equal(rows[0]!.strength, 95)
  assert.equal(rows[0]!.id, second.body.id)
})

test('signals with a NULL fingerprint are not collapsed (NULLS DISTINCT)', async () => {
  // The migration relies on PostgreSQL treating NULLs as distinct in the unique
  // index so signals without a fingerprint (e.g. legacy/manual inserts) can
  // coexist on the same prospect. Lock that behavior in at the DB layer.
  const { workspace } = await seedUserWithWorkspace()
  const prospect = await seedProspect(workspace.id)

  await prisma.signal.create({
    data: { workspaceId: workspace.id, prospectId: prospect.id, type: 'HIRING', strength: 40, fingerprint: null },
  })
  await prisma.signal.create({
    data: { workspaceId: workspace.id, prospectId: prospect.id, type: 'FUNDING', strength: 50, fingerprint: null },
  })

  assert.equal(await prisma.signal.count({ where: { prospectId: prospect.id } }), 2)
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
