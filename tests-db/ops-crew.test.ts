// Database-backed tests for the Ops module's crew routes. These live at the
// tests-db (real Postgres) tier because the properties that matter — the
// (workspaceId, employeeCode) unique constraint surfacing as a 409, and the
// soft delete leaving the row on disk — can't be proven against a mocked Prisma.

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { crewRouter } from '../apps/api/src/routes/ops/crew.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace, startTestServer, bearer, type TestServer } from './helpers/db.ts'

let server: TestServer
before(async () => { server = await startTestServer('/api/ops/crew', crewRouter) })
after(async () => { await server.close(); await disconnect() })
beforeEach(async () => { await resetDb() })

function jsonAuth(userId: string) {
  return { Authorization: bearer(userId), 'Content-Type': 'application/json' }
}

function createCrew(userId: string, workspaceId: string, body: Record<string, unknown>) {
  return server.request('/api/ops/crew', {
    method: 'POST', headers: jsonAuth(userId),
    body: JSON.stringify({ workspaceId, ...body }),
  })
}

test('POST /crew creates a crew member and GET /crew lists it', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const created = await createCrew(user.id, workspace.id, {
    employeeCode: 'E1', fullName: 'Jane Doe', role: 'TECH', crewName: 'Alpha', baseRate: 42.5, allowanceProfile: 'HEAT', licenceNotes: 'HR licence exp 2027',
  })
  assert.equal(created.status, 201)
  assert.equal(created.body.crew.employeeCode, 'E1')
  assert.equal(created.body.crew.baseRate, 42.5)
  assert.equal(created.body.crew.isActive, true)

  const list = await server.request(`/api/ops/crew?workspaceId=${workspace.id}`, { headers: { Authorization: bearer(user.id) } })
  assert.equal(list.status, 200)
  assert.equal(list.body.total, 1)
  assert.equal(list.body.page, 1)
  assert.equal(list.body.pages, 1)
  assert.equal(list.body.crew[0].fullName, 'Jane Doe')
})

test('GET /crew?search= matches fullName OR employeeCode, case-insensitively', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  await createCrew(user.id, workspace.id, { employeeCode: 'ABC-1', fullName: 'Jane Doe', role: 'TECH' })
  await createCrew(user.id, workspace.id, { employeeCode: 'XYZ-9', fullName: 'John Roe', role: 'LABOURER' })

  const byName = await server.request(`/api/ops/crew?workspaceId=${workspace.id}&search=jane`, { headers: { Authorization: bearer(user.id) } })
  assert.equal(byName.body.total, 1)
  assert.equal(byName.body.crew[0].employeeCode, 'ABC-1')

  const byCode = await server.request(`/api/ops/crew?workspaceId=${workspace.id}&search=xyz`, { headers: { Authorization: bearer(user.id) } })
  assert.equal(byCode.body.total, 1)
  assert.equal(byCode.body.crew[0].fullName, 'John Roe')

  const noMatch = await server.request(`/api/ops/crew?workspaceId=${workspace.id}&search=nobody`, { headers: { Authorization: bearer(user.id) } })
  assert.equal(noMatch.body.total, 0)
})

test('GET /crew?active= filters on isActive in both directions', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  await createCrew(user.id, workspace.id, { employeeCode: 'E1', fullName: 'Active Person', role: 'TECH' })
  const gone = await createCrew(user.id, workspace.id, { employeeCode: 'E2', fullName: 'Departed Person', role: 'TECH' })
  await prisma.opsCrewMember.update({ where: { id: gone.body.crew.id }, data: { isActive: false } })

  const active = await server.request(`/api/ops/crew?workspaceId=${workspace.id}&active=true`, { headers: { Authorization: bearer(user.id) } })
  assert.equal(active.body.total, 1)
  assert.equal(active.body.crew[0].fullName, 'Active Person')

  // 'false' must mean inactive — not "any non-empty string is truthy".
  const inactive = await server.request(`/api/ops/crew?workspaceId=${workspace.id}&active=false`, { headers: { Authorization: bearer(user.id) } })
  assert.equal(inactive.body.total, 1)
  assert.equal(inactive.body.crew[0].fullName, 'Departed Person')

  const all = await server.request(`/api/ops/crew?workspaceId=${workspace.id}`, { headers: { Authorization: bearer(user.id) } })
  assert.equal(all.body.total, 2)
})

test('GET /crew denies a non-member of the workspace', async () => {
  const a = await seedUserWithWorkspace('a@x.test')
  const b = await seedUserWithWorkspace('b@x.test')
  const res = await server.request(`/api/ops/crew?workspaceId=${a.workspace.id}`, { headers: { Authorization: bearer(b.user.id) } })
  assert.equal(res.status, 403)
})

test('PUT /crew/:id updates allowlisted fields and CANNOT change employeeCode', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const created = await createCrew(user.id, workspace.id, { employeeCode: 'E1', fullName: 'Jane Doe', role: 'TECH' })
  const id = created.body.crew.id

  const res = await server.request(`/api/ops/crew/${id}`, {
    method: 'PUT', headers: jsonAuth(user.id),
    body: JSON.stringify({ workspaceId: workspace.id, fullName: 'Jane Smith', role: 'LEAD', crewName: 'Bravo', employeeCode: 'HACKED' }),
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.crew.fullName, 'Jane Smith')
  assert.equal(res.body.crew.role, 'LEAD')
  assert.equal(res.body.crew.crewName, 'Bravo')
  assert.equal(res.body.crew.employeeCode, 'E1', 'employeeCode must be immutable through PUT')

  const row = await prisma.opsCrewMember.findUnique({ where: { id } })
  assert.equal(row!.employeeCode, 'E1')
})

test('PUT /crew/:id returns 404 for a row in another workspace', async () => {
  const a = await seedUserWithWorkspace('a@x.test')
  const b = await seedUserWithWorkspace('b@x.test')
  const created = await createCrew(b.user.id, b.workspace.id, { employeeCode: 'E1', fullName: 'Jane Doe', role: 'TECH' })

  const res = await server.request(`/api/ops/crew/${created.body.crew.id}`, {
    method: 'PUT', headers: jsonAuth(a.user.id),
    body: JSON.stringify({ workspaceId: a.workspace.id, fullName: 'Nope' }),
  })
  assert.equal(res.status, 404)
})

test('DELETE /crew/:id is a SOFT delete — isActive false, row still present', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const created = await createCrew(user.id, workspace.id, { employeeCode: 'E1', fullName: 'Jane Doe', role: 'TECH' })
  const id = created.body.crew.id

  const res = await server.request(`/api/ops/crew/${id}?workspaceId=${workspace.id}`, { method: 'DELETE', headers: jsonAuth(user.id) })
  assert.equal(res.status, 200)
  assert.equal(res.body.deactivated, true)
  assert.equal(res.body.id, id)

  const row = await prisma.opsCrewMember.findUnique({ where: { id } })
  assert.ok(row, 'the crew member row must survive a delete (shift/roster history references it)')
  assert.equal(row!.isActive, false)
})

test('DELETE /crew/:id succeeds even when the crew member has shift history (Restrict FK)', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const created = await createCrew(user.id, workspace.id, { employeeCode: 'E1', fullName: 'Jane Doe', role: 'TECH' })
  const id = created.body.crew.id
  const site = await prisma.opsJobSite.create({ data: { workspaceId: workspace.id, jobCode: 'J1', siteName: 'Site 1' } })
  await prisma.opsShiftRecord.create({
    data: { workspaceId: workspace.id, crewMemberId: id, jobSiteId: site.id, shiftDate: new Date(), startTime: new Date() },
  })

  const res = await server.request(`/api/ops/crew/${id}?workspaceId=${workspace.id}`, { method: 'DELETE', headers: jsonAuth(user.id) })
  assert.equal(res.status, 200)
  assert.equal(await prisma.opsShiftRecord.count({ where: { crewMemberId: id } }), 1)
})

test('DELETE /crew/:id returns 404 for an unknown id', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const res = await server.request(`/api/ops/crew/doesnotexist?workspaceId=${workspace.id}`, { method: 'DELETE', headers: jsonAuth(user.id) })
  assert.equal(res.status, 404)
})

test('POST /crew with a duplicate employeeCode returns 409, not a 500', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const first = await createCrew(user.id, workspace.id, { employeeCode: 'E1', fullName: 'Jane Doe', role: 'TECH' })
  assert.equal(first.status, 201)

  const second = await createCrew(user.id, workspace.id, { employeeCode: 'E1', fullName: 'Someone Else', role: 'LABOURER' })
  assert.equal(second.status, 409)
  assert.match(second.body.error ?? second.body.message ?? '', /employee code/i)
  assert.equal(await prisma.opsCrewMember.count({ where: { workspaceId: workspace.id } }), 1)

  // The same code in a DIFFERENT workspace is fine — the constraint is per-tenant.
  const other = await seedUserWithWorkspace('other@x.test')
  const elsewhere = await createCrew(other.user.id, other.workspace.id, { employeeCode: 'E1', fullName: 'Jane Doe', role: 'TECH' })
  assert.equal(elsewhere.status, 201)
})

test('a plain member cannot create, update, or deactivate a crew member (ops:manage required)', async () => {
  const owner = await seedUserWithWorkspace()
  const member = await seedUserWithWorkspace(undefined, 'member')
  await prisma.membership.create({ data: { userId: member.user.id, workspaceId: owner.workspace.id, role: 'member' } })
  const created = await createCrew(owner.user.id, owner.workspace.id, { employeeCode: 'E1', fullName: 'Jane Doe', role: 'TECH' })
  const id = created.body.crew.id

  const post = await createCrew(member.user.id, owner.workspace.id, { employeeCode: 'E2', fullName: 'New Hire', role: 'TECH' })
  assert.equal(post.status, 403)

  const put = await server.request(`/api/ops/crew/${id}`, {
    method: 'PUT', headers: jsonAuth(member.user.id),
    body: JSON.stringify({ workspaceId: owner.workspace.id, fullName: 'Renamed' }),
  })
  assert.equal(put.status, 403)

  const del = await server.request(`/api/ops/crew/${id}?workspaceId=${owner.workspace.id}`, { method: 'DELETE', headers: jsonAuth(member.user.id) })
  assert.equal(del.status, 403)

  // Nothing the member attempted took effect.
  const row = await prisma.opsCrewMember.findUnique({ where: { id } })
  assert.equal(row!.fullName, 'Jane Doe')
  assert.equal(row!.isActive, true)
  assert.equal(await prisma.opsCrewMember.count({ where: { workspaceId: owner.workspace.id } }), 1)

  // …but a plain member CAN still read the roster.
  const list = await server.request(`/api/ops/crew?workspaceId=${owner.workspace.id}`, { headers: { Authorization: bearer(member.user.id) } })
  assert.equal(list.status, 200)
  assert.equal(list.body.total, 1)
})
