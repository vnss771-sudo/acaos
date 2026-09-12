// Database-backed tests for the Ops module's shift/clock routes. These exist at
// the tests-db (real Postgres) tier specifically because the properties that
// matter here — the partial unique index rejecting a concurrent double clock-in,
// and cross-tenant ownership checks — can't be proven against a mocked Prisma.

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { shiftsRouter } from '../apps/api/src/routes/ops/shifts.ts'
import { clockRouter } from '../apps/api/src/routes/ops/clock.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace, startTestServer, bearer, type TestServer } from './helpers/db.ts'

let shifts: TestServer
let clock: TestServer
before(async () => {
  shifts = await startTestServer('/api/ops/shifts', shiftsRouter)
  clock = await startTestServer('/api/ops/clock', clockRouter)
})
after(async () => { await shifts.close(); await clock.close(); await disconnect() })
beforeEach(async () => { await resetDb() })

function jsonAuth(userId: string) {
  return { Authorization: bearer(userId), 'Content-Type': 'application/json' }
}

async function seedCrewAndSite(workspaceId: string) {
  const crew = await prisma.opsCrewMember.create({ data: { workspaceId, employeeCode: 'E1', fullName: 'Jane Doe', role: 'TECH' } })
  const site = await prisma.opsJobSite.create({ data: { workspaceId, jobCode: 'J1', siteName: 'Site 1' } })
  return { crew, site }
}

test('clock in opens a shift; a second clock-in for the same crew member is rejected 409, not a silent double-open', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const { crew, site } = await seedCrewAndSite(workspace.id)

  const first = await clock.request('/api/ops/clock/in', {
    method: 'POST', headers: jsonAuth(user.id),
    body: JSON.stringify({ workspaceId: workspace.id, crewMemberId: crew.id, jobSiteId: site.id }),
  })
  assert.equal(first.status, 201)
  assert.equal(first.body.shift.endTime, null)

  const second = await clock.request('/api/ops/clock/in', {
    method: 'POST', headers: jsonAuth(user.id),
    body: JSON.stringify({ workspaceId: workspace.id, crewMemberId: crew.id, jobSiteId: site.id }),
  })
  assert.equal(second.status, 409)

  const openShifts = await prisma.opsShiftRecord.count({ where: { workspaceId: workspace.id, crewMemberId: crew.id, endTime: null } })
  assert.equal(openShifts, 1, 'only one open shift must exist for this crew member')
})

test('clock out closes the open shift and computes totalHours', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const { crew, site } = await seedCrewAndSite(workspace.id)
  await clock.request('/api/ops/clock/in', {
    method: 'POST', headers: jsonAuth(user.id),
    body: JSON.stringify({ workspaceId: workspace.id, crewMemberId: crew.id, jobSiteId: site.id }),
  })

  const out = await clock.request('/api/ops/clock/out', {
    method: 'POST', headers: jsonAuth(user.id),
    body: JSON.stringify({ workspaceId: workspace.id, crewMemberId: crew.id }),
  })
  assert.equal(out.status, 200)
  assert.ok(out.body.shift.endTime, 'shift should be closed')
  assert.ok(out.body.shift.totalHours >= 0)

  const stillOpen = await prisma.opsShiftRecord.count({ where: { workspaceId: workspace.id, crewMemberId: crew.id, endTime: null } })
  assert.equal(stillOpen, 0)
})

test('clock out with no open shift returns 404', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const { crew } = await seedCrewAndSite(workspace.id)
  const res = await clock.request('/api/ops/clock/out', {
    method: 'POST', headers: jsonAuth(user.id),
    body: JSON.stringify({ workspaceId: workspace.id, crewMemberId: crew.id }),
  })
  assert.equal(res.status, 404)
})

test('clock/status is scoped to the EXACT crew member requested, not "any" open shift in the workspace', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const { crew: crewA, site } = await seedCrewAndSite(workspace.id)
  const crewB = await prisma.opsCrewMember.create({ data: { workspaceId: workspace.id, employeeCode: 'E2', fullName: 'John Roe', role: 'TECH' } })

  // Only crew A clocks in.
  await clock.request('/api/ops/clock/in', {
    method: 'POST', headers: jsonAuth(user.id),
    body: JSON.stringify({ workspaceId: workspace.id, crewMemberId: crewA.id, jobSiteId: site.id }),
  })

  const statusA = await clock.request(`/api/ops/clock/status?workspaceId=${workspace.id}&crewMemberId=${crewA.id}`, { headers: { Authorization: bearer(user.id) } })
  assert.equal(statusA.body.clockedIn, true)

  // Crew B has no open shift — must report false, not crew A's shift.
  const statusB = await clock.request(`/api/ops/clock/status?workspaceId=${workspace.id}&crewMemberId=${crewB.id}`, { headers: { Authorization: bearer(user.id) } })
  assert.equal(statusB.body.clockedIn, false)
  assert.equal(statusB.body.shift, null)
})

test('clock-in rejects a crewMemberId/jobSiteId that belongs to a different workspace', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const other = await seedUserWithWorkspace('other@x.test')
  const { crew: otherCrew, site: otherSite } = await seedCrewAndSite(other.workspace.id)

  const res = await clock.request('/api/ops/clock/in', {
    method: 'POST', headers: jsonAuth(user.id),
    body: JSON.stringify({ workspaceId: workspace.id, crewMemberId: otherCrew.id, jobSiteId: otherSite.id }),
  })
  assert.equal(res.status, 404)
})

test('PUT /shifts/:id editing notes on an OPEN shift does not close it', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const { crew, site } = await seedCrewAndSite(workspace.id)
  const openIn = await clock.request('/api/ops/clock/in', {
    method: 'POST', headers: jsonAuth(user.id),
    body: JSON.stringify({ workspaceId: workspace.id, crewMemberId: crew.id, jobSiteId: site.id }),
  })
  const shiftId = openIn.body.shift.id

  const edit = await shifts.request(`/api/ops/shifts/${shiftId}`, {
    method: 'PUT', headers: jsonAuth(user.id),
    body: JSON.stringify({ workspaceId: workspace.id, notes: 'left early, site closed at 2pm' }),
  })
  assert.equal(edit.status, 200)
  assert.equal(edit.body.shift.endTime, null, 'editing notes must not close an open shift')
  assert.equal(edit.body.shift.notes, 'left early, site closed at 2pm')

  const stillOpen = await prisma.opsShiftRecord.findUnique({ where: { id: shiftId } })
  assert.equal(stillOpen!.endTime, null)
})

test('PUT /shifts/:id can explicitly close a shift when endTime is provided', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const { crew, site } = await seedCrewAndSite(workspace.id)
  const openIn = await clock.request('/api/ops/clock/in', {
    method: 'POST', headers: jsonAuth(user.id),
    body: JSON.stringify({ workspaceId: workspace.id, crewMemberId: crew.id, jobSiteId: site.id }),
  })

  const closeAt = new Date(Date.now() + 60_000).toISOString()
  const edit = await shifts.request(`/api/ops/shifts/${openIn.body.shift.id}`, {
    method: 'PUT', headers: jsonAuth(user.id),
    body: JSON.stringify({ workspaceId: workspace.id, endTime: closeAt }),
  })
  assert.equal(edit.status, 200)
  assert.ok(edit.body.shift.endTime)
})

test('a plain member cannot create a manual shift entry (ops:manage required)', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const member = await seedUserWithWorkspace(undefined, 'member')
  await prisma.membership.create({ data: { userId: member.user.id, workspaceId: workspace.id, role: 'member' } })
  const { crew, site } = await seedCrewAndSite(workspace.id)

  const res = await shifts.request('/api/ops/shifts', {
    method: 'POST', headers: jsonAuth(member.user.id),
    body: JSON.stringify({
      workspaceId: workspace.id, crewMemberId: crew.id, jobSiteId: site.id,
      shiftDate: new Date().toISOString(), startTime: new Date().toISOString(),
    }),
  })
  assert.equal(res.status, 403)
})
