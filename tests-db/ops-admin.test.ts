// Database-backed tests for the Ops admin dashboard aggregation.

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { adminRouter } from '../apps/api/src/routes/ops/admin.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace, startTestServer, bearer, type TestServer } from './helpers/db.ts'

let server: TestServer
before(async () => { server = await startTestServer('/api/ops/admin', adminRouter) })
after(async () => { await server.close(); await disconnect() })
beforeEach(async () => { await resetDb() })

async function seedCrewAndSite(workspaceId: string, code = 'E1') {
  const crew = await prisma.opsCrewMember.create({ data: { workspaceId, employeeCode: code, fullName: 'Jane Doe', role: 'TECH' } })
  const site = await prisma.opsJobSite.create({ data: { workspaceId, jobCode: `J-${code}`, siteName: 'Site 1' } })
  return { crew, site }
}

test('GET /overview aggregates crew, alerts, clocked-in state, and recent activity', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const { crew, site } = await seedCrewAndSite(workspace.id)
  const now = new Date()

  // An open (clocked-in) shift.
  await prisma.opsShiftRecord.create({ data: { workspaceId: workspace.id, crewMemberId: crew.id, jobSiteId: site.id, shiftDate: now, startTime: now, endTime: null } })
  // A closed shift from earlier this week, contributing hours.
  const earlier = new Date(now.getTime() - 3_600_000 * 4)
  await prisma.opsShiftRecord.create({ data: { workspaceId: workspace.id, crewMemberId: crew.id, jobSiteId: site.id, shiftDate: earlier, startTime: earlier, endTime: now, totalHours: 4 } })
  // Open + reviewed alerts.
  await prisma.opsAlert.create({ data: { workspaceId: workspace.id, alertType: 'MISSING_HEAT_CHECK', title: 'a', severity: 'HIGH' } })
  await prisma.opsAlert.create({ data: { workspaceId: workspace.id, alertType: 'FATIGUE_THRESHOLD', title: 'b', status: 'REVIEWED', reviewedBy: user.id, reviewedAt: now } })

  const res = await server.request(`/api/ops/admin/overview?workspaceId=${workspace.id}`, { headers: { Authorization: bearer(user.id) } })
  assert.equal(res.status, 200)
  const { overview } = res.body
  assert.equal(overview.activeCrewCount, 1)
  assert.equal(overview.jobSiteCount, 1)
  assert.equal(overview.openAlertCount, 1)
  assert.equal(overview.reviewedAlertCount, 1)
  assert.equal(overview.clockedInCrew.length, 1)
  assert.equal(overview.clockedInCrew[0].crewMember.id, crew.id)
  assert.equal(overview.recentShifts.length, 2)
  assert.equal(overview.openAlerts.length, 1)
  assert.ok(overview.thisWeekShiftHours >= 4)
})

test('GET /overview requires workspace membership', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const outsider = await seedUserWithWorkspace('outsider@x.test')
  const res = await server.request(`/api/ops/admin/overview?workspaceId=${workspace.id}`, { headers: { Authorization: bearer(outsider.user.id) } })
  assert.equal(res.status, 403)
})

test('GET /overview on an empty workspace returns zeroed counts, not an error', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const res = await server.request(`/api/ops/admin/overview?workspaceId=${workspace.id}`, { headers: { Authorization: bearer(user.id) } })
  assert.equal(res.status, 200)
  assert.equal(res.body.overview.activeCrewCount, 0)
  assert.equal(res.body.overview.thisWeekShiftHours, 0)
  assert.deepEqual(res.body.overview.clockedInCrew, [])
  assert.deepEqual(res.body.overview.recentShifts, [])
})
