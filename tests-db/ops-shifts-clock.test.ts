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

// Audit writes are fire-and-forget (`void recordAudit(...)`), so the row may
// land just after the HTTP response — poll briefly rather than assuming it's
// already there.
async function waitForAudit(where: Record<string, unknown>) {
  for (let i = 0; i < 50; i++) {
    const ev = await prisma.auditEvent.findFirst({ where, orderBy: { createdAt: 'desc' } })
    if (ev) return ev
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`no AuditEvent matched ${JSON.stringify(where)}`)
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

// ── Identity binding (self-service vs. supervisor override) ─────────────────

test('a crew member linked via userId can clock themselves in and out; the audit event is the plain (non-supervisor) type', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const member = await seedUserWithWorkspace(undefined, 'member')
  await prisma.membership.create({ data: { userId: member.user.id, workspaceId: workspace.id, role: 'member' } })
  const site = await prisma.opsJobSite.create({ data: { workspaceId: workspace.id, jobCode: 'J1', siteName: 'Site 1' } })
  const crew = await prisma.opsCrewMember.create({
    data: { workspaceId: workspace.id, employeeCode: 'E1', fullName: 'Jane Doe', role: 'TECH', userId: member.user.id },
  })

  const in_ = await clock.request('/api/ops/clock/in', {
    method: 'POST', headers: jsonAuth(member.user.id),
    body: JSON.stringify({ workspaceId: workspace.id, crewMemberId: crew.id, jobSiteId: site.id }),
  })
  assert.equal(in_.status, 201)
  const inEvent = await waitForAudit({ workspaceId: workspace.id, entityId: in_.body.shift.id, entityType: 'OpsShiftRecord' })
  assert.equal(inEvent.type, 'ops.clock.in')

  const out = await clock.request('/api/ops/clock/out', {
    method: 'POST', headers: jsonAuth(member.user.id),
    body: JSON.stringify({ workspaceId: workspace.id, crewMemberId: crew.id }),
  })
  assert.equal(out.status, 200)
  const outEvent = await waitForAudit({ workspaceId: workspace.id, entityId: in_.body.shift.id, entityType: 'OpsShiftRecord', type: 'ops.clock.out' })
  assert.ok(outEvent)
})

test('a plain member cannot clock in a crew member not linked to their own account, even though clock-in is membership-level', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const member = await seedUserWithWorkspace(undefined, 'member')
  await prisma.membership.create({ data: { userId: member.user.id, workspaceId: workspace.id, role: 'member' } })
  const { crew, site } = await seedCrewAndSite(workspace.id) // crew.userId is null — no self-service identity

  const res = await clock.request('/api/ops/clock/in', {
    method: 'POST', headers: jsonAuth(member.user.id),
    body: JSON.stringify({ workspaceId: workspace.id, crewMemberId: crew.id, jobSiteId: site.id }),
  })
  assert.equal(res.status, 403)
})

test('a plain member cannot clock in a crew member linked to a DIFFERENT account', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const member = await seedUserWithWorkspace(undefined, 'member')
  const otherMember = await seedUserWithWorkspace(undefined, 'member')
  await prisma.membership.create({ data: { userId: member.user.id, workspaceId: workspace.id, role: 'member' } })
  const site = await prisma.opsJobSite.create({ data: { workspaceId: workspace.id, jobCode: 'J1', siteName: 'Site 1' } })
  const crew = await prisma.opsCrewMember.create({
    data: { workspaceId: workspace.id, employeeCode: 'E1', fullName: 'Jane Doe', role: 'TECH', userId: otherMember.user.id },
  })

  const res = await clock.request('/api/ops/clock/in', {
    method: 'POST', headers: jsonAuth(member.user.id),
    body: JSON.stringify({ workspaceId: workspace.id, crewMemberId: crew.id, jobSiteId: site.id }),
  })
  assert.equal(res.status, 403)
})

test('an ops:manage caller can clock a crew member in/out on their behalf; the audit event is the .supervisor type', async () => {
  const { user, workspace } = await seedUserWithWorkspace() // owner — holds ops:manage
  const { crew, site } = await seedCrewAndSite(workspace.id) // crew.userId is null

  const in_ = await clock.request('/api/ops/clock/in', {
    method: 'POST', headers: jsonAuth(user.id),
    body: JSON.stringify({ workspaceId: workspace.id, crewMemberId: crew.id, jobSiteId: site.id }),
  })
  assert.equal(in_.status, 201)
  const inEvent = await waitForAudit({ workspaceId: workspace.id, entityId: in_.body.shift.id, entityType: 'OpsShiftRecord' })
  assert.equal(inEvent.type, 'ops.clock.in.supervisor')

  const out = await clock.request('/api/ops/clock/out', {
    method: 'POST', headers: jsonAuth(user.id),
    body: JSON.stringify({ workspaceId: workspace.id, crewMemberId: crew.id }),
  })
  assert.equal(out.status, 200)
  const outEvent = await waitForAudit({ workspaceId: workspace.id, entityId: in_.body.shift.id, entityType: 'OpsShiftRecord', type: 'ops.clock.out.supervisor' })
  assert.ok(outEvent)
})

// ── Geofencing ────────────────────────────────────────────────────────────────

test('clock-in is rejected when the caller is outside the job site geofence', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const crew = await prisma.opsCrewMember.create({ data: { workspaceId: workspace.id, employeeCode: 'E1', fullName: 'Jane Doe', role: 'TECH' } })
  // Philadelphia, tight 100m radius.
  const site = await prisma.opsJobSite.create({ data: { workspaceId: workspace.id, jobCode: 'J1', siteName: 'Site 1', lat: 39.9526, lng: -75.1652, radiusMeters: 100 } })

  const res = await clock.request('/api/ops/clock/in', {
    method: 'POST', headers: jsonAuth(user.id),
    // New York City — well outside a 100m radius around Philadelphia.
    body: JSON.stringify({ workspaceId: workspace.id, crewMemberId: crew.id, jobSiteId: site.id, lat: 40.7128, lng: -74.0060 }),
  })
  assert.equal(res.status, 400)
  assert.match(res.body.error, /geofence/i)

  const openShifts = await prisma.opsShiftRecord.count({ where: { workspaceId: workspace.id, crewMemberId: crew.id } })
  assert.equal(openShifts, 0, 'a rejected clock-in must not create a shift row')
})

test('clock-in succeeds when the caller is within the job site geofence', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const crew = await prisma.opsCrewMember.create({ data: { workspaceId: workspace.id, employeeCode: 'E1', fullName: 'Jane Doe', role: 'TECH' } })
  const site = await prisma.opsJobSite.create({ data: { workspaceId: workspace.id, jobCode: 'J1', siteName: 'Site 1', lat: 39.9526, lng: -75.1652, radiusMeters: 500 } })

  const res = await clock.request('/api/ops/clock/in', {
    method: 'POST', headers: jsonAuth(user.id),
    // A few dozen meters away — within the 500m radius.
    body: JSON.stringify({ workspaceId: workspace.id, crewMemberId: crew.id, jobSiteId: site.id, lat: 39.9530, lng: -75.1655 }),
  })
  assert.equal(res.status, 201)
})

test('geofence is a no-op when the job site has no lat/lng configured, even if the caller sends coordinates', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const { crew, site } = await seedCrewAndSite(workspace.id) // no lat/lng set

  const res = await clock.request('/api/ops/clock/in', {
    method: 'POST', headers: jsonAuth(user.id),
    body: JSON.stringify({ workspaceId: workspace.id, crewMemberId: crew.id, jobSiteId: site.id, lat: 0, lng: 0 }),
  })
  assert.equal(res.status, 201)
})

test('geofence is a no-op on clock-out when the caller sends no coordinates, even if the job site has a configured geofence', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const crew = await prisma.opsCrewMember.create({ data: { workspaceId: workspace.id, employeeCode: 'E1', fullName: 'Jane Doe', role: 'TECH' } })
  const site = await prisma.opsJobSite.create({ data: { workspaceId: workspace.id, jobCode: 'J1', siteName: 'Site 1', lat: 39.9526, lng: -75.1652, radiusMeters: 50 } })
  await clock.request('/api/ops/clock/in', {
    method: 'POST', headers: jsonAuth(user.id),
    body: JSON.stringify({ workspaceId: workspace.id, crewMemberId: crew.id, jobSiteId: site.id, lat: 39.9526, lng: -75.1652 }),
  })

  const out = await clock.request('/api/ops/clock/out', {
    method: 'POST', headers: jsonAuth(user.id),
    body: JSON.stringify({ workspaceId: workspace.id, crewMemberId: crew.id }),
  })
  assert.equal(out.status, 200)
})
