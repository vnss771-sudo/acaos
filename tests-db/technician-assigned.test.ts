// GET /api/ops/technician/assigned — the mobile technician's own job list.
// A worker sees only their own active assignments, only identity-level fields,
// and nothing across workspaces.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { technicianRouter } from '../apps/api/src/routes/ops/technician.ts'
import { prisma, resetDb, disconnect, seedUser, seedUserWithWorkspace, startTestServer, bearer, type TestServer } from './helpers/db.ts'

let server: TestServer
before(async () => { server = await startTestServer('/api/ops/technician', technicianRouter) })
after(async () => { await server.close(); await disconnect() })
beforeEach(async () => { await resetDb() })

function call(userId: string, method: string, path: string, body?: unknown) {
  return server.request(path, {
    method,
    headers: { Authorization: bearer(userId), 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}
const assigned = (userId: string, workspaceId: string) => call(userId, 'GET', `/api/ops/technician/assigned?workspaceId=${workspaceId}`)

async function workspace(email: string) {
  const { user: owner, workspace: ws } = await seedUserWithWorkspace(email)
  const site = await prisma.opsJobSite.create({ data: { workspaceId: ws.id, jobCode: 'SITE-1', siteName: 'Harbour Plaza' } })
  const job = (data: Record<string, unknown> = {}) =>
    prisma.job.create({ data: { workspaceId: ws.id, opsJobSiteId: site.id, ...data } })
  const worker = async (name: string, opts: { linked?: boolean; active?: boolean; role?: string } = {}) => {
    const user = await seedUser(`${name}-${Math.random().toString(36).slice(2, 6)}@example.test`)
    await prisma.membership.create({ data: { workspaceId: ws.id, userId: user.id, role: opts.role ?? 'member' } })
    const crew = opts.linked === false ? null : await prisma.opsCrewMember.create({ data: {
      workspaceId: ws.id, employeeCode: `E-${name}`, fullName: name, role: 'TECH', userId: user.id, isActive: opts.active ?? true,
    } })
    return { user, crew }
  }
  const assign = async (jobId: string, crewMemberId: string) => {
    const r = await call(owner.id, 'POST', `/api/ops/technician/${jobId}/assignments`, { workspaceId: ws.id, crewMemberId })
    assert.equal(r.status, 201, JSON.stringify(r.body))
  }
  return { owner, ws, job, worker, assign }
}

test('a worker sees only their own active assignments, with identity-level fields only', async () => {
  const w = await workspace('owner@example.test')
  const alice = await w.worker('alice')
  const bob = await w.worker('bob')
  // Jobs carrying commercial data, to prove none of it is returned.
  const mine = await w.job({ invoicedRevenueCents: 987_654, otherCostCents: 11_111, closeout: { marginNote: 'secret' } })
  const bobs = await w.job({ invoicedRevenueCents: 5_000 })
  const done = await w.job()
  const unassigned = await w.job()
  await w.assign(mine.id, alice.crew!.id)
  await w.assign(bobs.id, bob.crew!.id)
  await w.assign(done.id, alice.crew!.id)
  await prisma.job.update({ where: { id: done.id }, data: { status: 'COMPLETE' } })
  void unassigned
  const r = await assigned(alice.user.id, w.ws.id)
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.linked, true)
  assert.deepEqual(r.body.jobs.map((j: { id: string }) => j.id), [mine.id], "only Alice's active job")
  assert.deepEqual(Object.keys(r.body.jobs[0]).sort(), ['assignedAt', 'id', 'jobCode', 'siteName', 'status'])
  assert.equal(r.body.jobs[0].siteName, 'Harbour Plaza')
  assert.equal(JSON.stringify(r.body).includes('987'), false, 'no financial data in the payload')
  assert.equal(JSON.stringify(r.body).includes('secret'), false)
  // Bob sees his own, not Alice's.
  const b = await assigned(bob.user.id, w.ws.id)
  assert.deepEqual(b.body.jobs.map((j: { id: string }) => j.id), [bobs.id])
})

test('revocation removes a job from the list', async () => {
  const w = await workspace('owner-rv@example.test')
  const alice = await w.worker('alice')
  const job = await w.job()
  await w.assign(job.id, alice.crew!.id)
  assert.equal((await assigned(alice.user.id, w.ws.id)).body.jobs.length, 1)
  const del = await call(w.owner.id, 'DELETE', `/api/ops/technician/${job.id}/assignments/${alice.crew!.id}?workspaceId=${w.ws.id}`)
  assert.equal(del.status, 200)
  assert.equal((await assigned(alice.user.id, w.ws.id)).body.jobs.length, 0)
})

test('members without a usable crew link get linked:false, not an error', async () => {
  const w = await workspace('owner-nl@example.test')
  const unlinked = await w.worker('unlinked', { linked: false })
  const inactive = await w.worker('inactive', { active: false })
  for (const who of [unlinked, inactive, { user: w.owner }]) {
    const r = await assigned(who.user.id, w.ws.id)
    assert.equal(r.status, 200)
    assert.deepEqual(r.body, { linked: false, jobs: [] })
  }
})

test('nothing crosses workspaces', async () => {
  const a = await workspace('owner-a@example.test')
  const b = await workspace('owner-b@example.test')
  const alice = await a.worker('alice')
  const jobA = await a.job()
  await a.assign(jobA.id, alice.crew!.id)
  // Alice is not a member of B; B's owner is not a member of A.
  assert.equal((await assigned(alice.user.id, b.ws.id)).status, 403)
  assert.equal((await assigned(b.owner.id, a.ws.id)).status, 403)
  // A same-named worker linked in B sees none of A's jobs.
  const aliceB = await b.worker('alice')
  assert.deepEqual((await assigned(aliceB.user.id, b.ws.id)).body.jobs, [])
  // No workspace, or an unauthenticated caller, is rejected.
  assert.equal((await call(alice.user.id, 'GET', '/api/ops/technician/assigned')).status, 400)
  const anon = await server.request(`/api/ops/technician/assigned?workspaceId=${a.ws.id}`, { method: 'GET' })
  assert.equal(anon.status, 401)
})
