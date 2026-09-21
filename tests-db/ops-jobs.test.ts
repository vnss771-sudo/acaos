// Database-backed tests for the Ops module's job-site routes. These live at the
// tests-db (real Postgres) tier because the properties that matter here — the
// (workspaceId, jobCode) unique constraint producing a 409, and archive being a
// status change on a row that must still exist afterwards — can't be proven
// against a mocked Prisma.

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { opsJobsRouter } from '../apps/api/src/routes/ops/jobs.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace, startTestServer, bearer, type TestServer } from './helpers/db.ts'

let server: TestServer
before(async () => { server = await startTestServer('/api/ops/jobs', opsJobsRouter) })
after(async () => { await server.close(); await disconnect() })
beforeEach(async () => { await resetDb() })

function jsonAuth(userId: string) {
  return { Authorization: bearer(userId), 'Content-Type': 'application/json' }
}

async function createSite(userId: string, workspaceId: string, body: Record<string, unknown>) {
  return server.request('/api/ops/jobs', {
    method: 'POST', headers: jsonAuth(userId),
    body: JSON.stringify({ workspaceId, ...body }),
  })
}

test('POST /jobs creates a site with riskLevel MEDIUM by default and ACTIVE status, ignoring any status in the body', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const res = await createSite(user.id, workspace.id, {
    jobCode: 'J-100', siteName: 'North Tower', location: 'Docklands', supervisor: 'Ana',
    shiftType: 'Rotating', status: 'ARCHIVED',
  })
  assert.equal(res.status, 201)
  assert.equal(res.body.jobSite.jobCode, 'J-100')
  assert.equal(res.body.jobSite.siteName, 'North Tower')
  assert.equal(res.body.jobSite.riskLevel, 'MEDIUM')
  assert.equal(res.body.jobSite.radiusMeters, 500)
  assert.equal(res.body.jobSite.shiftType, 'Rotating')
  assert.equal(res.body.jobSite.status, 'ACTIVE', 'status must not be settable at creation')

  const row = await prisma.opsJobSite.findUnique({ where: { id: res.body.jobSite.id } })
  assert.equal(row!.status, 'ACTIVE')
})

test('GET /jobs filters by status and paginates', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  await createSite(user.id, workspace.id, { jobCode: 'J-1', siteName: 'Alpha' })
  const second = await createSite(user.id, workspace.id, { jobCode: 'J-2', siteName: 'Bravo' })
  await server.request(`/api/ops/jobs/${second.body.jobSite.id}?workspaceId=${workspace.id}`, {
    method: 'DELETE', headers: jsonAuth(user.id),
  })

  const all = await server.request(`/api/ops/jobs?workspaceId=${workspace.id}`, { headers: { Authorization: bearer(user.id) } })
  assert.equal(all.status, 200)
  assert.equal(all.body.total, 2)
  assert.equal(all.body.pages, 1)

  const active = await server.request(`/api/ops/jobs?workspaceId=${workspace.id}&status=ACTIVE`, { headers: { Authorization: bearer(user.id) } })
  assert.equal(active.body.total, 1)
  assert.equal(active.body.jobSites[0].jobCode, 'J-1')

  const archived = await server.request(`/api/ops/jobs?workspaceId=${workspace.id}&status=ARCHIVED`, { headers: { Authorization: bearer(user.id) } })
  assert.equal(archived.body.total, 1)
  assert.equal(archived.body.jobSites[0].jobCode, 'J-2')
})

test('GET /jobs rejects an unrecognized status filter with 400 rather than ignoring it', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const res = await server.request(`/api/ops/jobs?workspaceId=${workspace.id}&status=BOGUS`, { headers: { Authorization: bearer(user.id) } })
  assert.equal(res.status, 400)
})

test('PUT /jobs/:id updates allowlisted fields; jobCode and status are not changeable', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const created = await createSite(user.id, workspace.id, { jobCode: 'J-7', siteName: 'Old Name', riskLevel: 'LOW' })
  const id = created.body.jobSite.id

  const res = await server.request(`/api/ops/jobs/${id}`, {
    method: 'PUT', headers: jsonAuth(user.id),
    body: JSON.stringify({
      workspaceId: workspace.id, siteName: 'New Name', riskLevel: 'HIGH', radiusMeters: 1200,
      notes: 'crane on site', jobCode: 'J-HACKED', status: 'ARCHIVED',
    }),
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.jobSite.siteName, 'New Name')
  assert.equal(res.body.jobSite.riskLevel, 'HIGH')
  assert.equal(res.body.jobSite.radiusMeters, 1200)
  assert.equal(res.body.jobSite.notes, 'crane on site')
  assert.equal(res.body.jobSite.jobCode, 'J-7', 'jobCode is immutable via PUT')
  assert.equal(res.body.jobSite.status, 'ACTIVE', 'status is only settable via the archive endpoint')

  const row = await prisma.opsJobSite.findUnique({ where: { id } })
  assert.equal(row!.jobCode, 'J-7')
  assert.equal(row!.status, 'ACTIVE')
})

test('PUT /jobs/:id 404s for a site in another workspace', async () => {
  const a = await seedUserWithWorkspace('a@x.test')
  const b = await seedUserWithWorkspace('b@x.test')
  const created = await createSite(b.user.id, b.workspace.id, { jobCode: 'J-9', siteName: 'Theirs' })
  const res = await server.request(`/api/ops/jobs/${created.body.jobSite.id}`, {
    method: 'PUT', headers: jsonAuth(a.user.id),
    body: JSON.stringify({ workspaceId: a.workspace.id, siteName: 'Mine now' }),
  })
  assert.equal(res.status, 404)
})

test('DELETE /jobs/:id archives the site instead of removing the row', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const created = await createSite(user.id, workspace.id, { jobCode: 'J-11', siteName: 'Depot' })
  const id = created.body.jobSite.id

  const res = await server.request(`/api/ops/jobs/${id}?workspaceId=${workspace.id}`, { method: 'DELETE', headers: jsonAuth(user.id) })
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { archived: true, id })

  const row = await prisma.opsJobSite.findUnique({ where: { id } })
  assert.ok(row, 'archiving must not hard-delete the row')
  assert.equal(row!.status, 'ARCHIVED')
})

test('DELETE /jobs/:id 404s when the site is already archived', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const created = await createSite(user.id, workspace.id, { jobCode: 'J-12', siteName: 'Yard' })
  const id = created.body.jobSite.id

  const first = await server.request(`/api/ops/jobs/${id}?workspaceId=${workspace.id}`, { method: 'DELETE', headers: jsonAuth(user.id) })
  assert.equal(first.status, 200)
  const second = await server.request(`/api/ops/jobs/${id}?workspaceId=${workspace.id}`, { method: 'DELETE', headers: jsonAuth(user.id) })
  assert.equal(second.status, 404)
})

test('POST /jobs returns 409 for a duplicate jobCode in the same workspace', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const first = await createSite(user.id, workspace.id, { jobCode: 'DUP', siteName: 'One' })
  assert.equal(first.status, 201)
  const second = await createSite(user.id, workspace.id, { jobCode: 'DUP', siteName: 'Two' })
  assert.equal(second.status, 409)

  // The same code in a DIFFERENT workspace is fine — the constraint is per-tenant.
  const other = await seedUserWithWorkspace('other@x.test')
  const elsewhere = await createSite(other.user.id, other.workspace.id, { jobCode: 'DUP', siteName: 'Three' })
  assert.equal(elsewhere.status, 201)
})

test('a plain member cannot create, update, or archive a job site (ops:manage required)', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const member = await seedUserWithWorkspace(undefined, 'member')
  await prisma.membership.create({ data: { userId: member.user.id, workspaceId: workspace.id, role: 'member' } })
  const created = await createSite(user.id, workspace.id, { jobCode: 'J-20', siteName: 'Gated' })
  const id = created.body.jobSite.id

  const post = await createSite(member.user.id, workspace.id, { jobCode: 'J-21', siteName: 'Nope' })
  assert.equal(post.status, 403)

  const put = await server.request(`/api/ops/jobs/${id}`, {
    method: 'PUT', headers: jsonAuth(member.user.id),
    body: JSON.stringify({ workspaceId: workspace.id, siteName: 'Nope' }),
  })
  assert.equal(put.status, 403)

  const del = await server.request(`/api/ops/jobs/${id}?workspaceId=${workspace.id}`, { method: 'DELETE', headers: jsonAuth(member.user.id) })
  assert.equal(del.status, 403)

  // A member can still READ the workspace's sites.
  const list = await server.request(`/api/ops/jobs?workspaceId=${workspace.id}`, { headers: { Authorization: bearer(member.user.id) } })
  assert.equal(list.status, 200)
  assert.equal(list.body.total, 1)
})
