// Database-backed tests for the fatigue-risk report: rolling 7-day window,
// consecutive-day counting, and the workspace summary bucketing.

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { fatigueRouter } from '../apps/api/src/routes/ops/fatigue.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace, startTestServer, bearer, type TestServer } from './helpers/db.ts'

let server: TestServer
before(async () => { server = await startTestServer('/api/ops/fatigue', fatigueRouter) })
after(async () => { await server.close(); await disconnect() })
beforeEach(async () => { await resetDb() })

const DAY = 24 * 60 * 60 * 1000
const ago = (days: number) => new Date(Date.now() - days * DAY)

async function seedCrewAndSite(workspaceId: string, employeeCode = 'E1') {
  const crew = await prisma.opsCrewMember.create({ data: { workspaceId, employeeCode, fullName: 'Jane Doe', role: 'TECH' } })
  const site = await prisma.opsJobSite.create({ data: { workspaceId, jobCode: `J-${employeeCode}`, siteName: 'Site 1' } })
  return { crew, site }
}

async function seedShift(workspaceId: string, crewMemberId: string, jobSiteId: string, when: Date, totalHours: number) {
  return prisma.opsShiftRecord.create({
    data: { workspaceId, crewMemberId, jobSiteId, shiftDate: when, startTime: when, endTime: new Date(when.getTime() + totalHours * 60 * 60 * 1000), totalHours },
  })
}

test('a crew member with no shifts in the last 7 days gets LOW risk / zeroed fields', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const { crew } = await seedCrewAndSite(workspace.id)

  const res = await server.request(`/api/ops/fatigue/${crew.id}?workspaceId=${workspace.id}`, { headers: { Authorization: bearer(user.id) } })
  assert.equal(res.status, 200)
  assert.equal(res.body.fatigue.riskLevel, 'LOW')
  assert.equal(res.body.fatigue.riskScore, 0)
  assert.equal(res.body.fatigue.totalHours7d, 0)
  assert.equal(res.body.fatigue.consecutiveDays, 0)
  assert.equal(res.body.fatigue.lastShiftDate, null)
})

test('only shifts inside the 7-day window count toward the report', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const { crew, site } = await seedCrewAndSite(workspace.id)
  await seedShift(workspace.id, crew.id, site.id, ago(10), 8) // outside window
  await seedShift(workspace.id, crew.id, site.id, ago(1), 8)  // inside window

  const res = await server.request(`/api/ops/fatigue/${crew.id}?workspaceId=${workspace.id}`, { headers: { Authorization: bearer(user.id) } })
  assert.equal(res.status, 200)
  assert.equal(res.body.fatigue.totalHours7d, 8, 'the 10-day-old shift must not be counted')
})

test('a heavy trailing week (overtime + consecutive days) escalates risk level', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const { crew, site } = await seedCrewAndSite(workspace.id)
  // 6 consecutive 10-hour days, ending yesterday — well past both thresholds.
  for (let d = 6; d >= 1; d -= 1) {
    await seedShift(workspace.id, crew.id, site.id, ago(d), 10)
  }

  const res = await server.request(`/api/ops/fatigue/${crew.id}?workspaceId=${workspace.id}`, { headers: { Authorization: bearer(user.id) } })
  assert.equal(res.status, 200)
  assert.equal(res.body.fatigue.totalHours7d, 60)
  assert.equal(res.body.fatigue.consecutiveDays, 6)
  assert.ok(['HIGH', 'CRITICAL'].includes(res.body.fatigue.riskLevel), `expected elevated risk, got ${res.body.fatigue.riskLevel}`)
  assert.ok(res.body.fatigue.factors.length > 0)
})

test('fatigue report 404s for a crew member id from another workspace', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const other = await seedUserWithWorkspace('other@x.test')
  const { crew: otherCrew } = await seedCrewAndSite(other.workspace.id)

  const res = await server.request(`/api/ops/fatigue/${otherCrew.id}?workspaceId=${workspace.id}`, { headers: { Authorization: bearer(user.id) } })
  assert.equal(res.status, 404)
})

test('GET / workspace summary buckets every ACTIVE crew member by risk level, sorted highest-risk first', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const { crew: heavy, site } = await seedCrewAndSite(workspace.id, 'HEAVY')
  const { crew: light } = await seedCrewAndSite(workspace.id, 'LIGHT')
  const { crew: inactive } = await seedCrewAndSite(workspace.id, 'INACTIVE')
  await prisma.opsCrewMember.update({ where: { id: inactive.id }, data: { isActive: false } })

  for (let d = 6; d >= 1; d -= 1) await seedShift(workspace.id, heavy.id, site.id, ago(d), 10)
  await seedShift(workspace.id, light.id, site.id, ago(1), 4)
  await seedShift(workspace.id, inactive.id, site.id, ago(1), 10) // should be excluded entirely

  const res = await server.request(`/api/ops/fatigue?workspaceId=${workspace.id}`, { headers: { Authorization: bearer(user.id) } })
  assert.equal(res.status, 200)
  assert.equal(res.body.reports.length, 2, 'inactive crew member must be excluded')
  assert.equal(res.body.reports[0].crewMemberId, heavy.id, 'highest risk sorts first')
  const total = res.body.summary.critical + res.body.summary.high + res.body.summary.medium + res.body.summary.low
  assert.equal(total, 2)
})

test('consecutive-day counting looks back further than the 7-day hours window: a 7-day streak and a 30-day streak report differently', async () => {
  const { user, workspace } = await seedUserWithWorkspace('a@x.test')
  const { crew: sevenDay, site } = await seedCrewAndSite(workspace.id, 'SEVEN')
  for (let d = 7; d >= 1; d -= 1) await seedShift(workspace.id, sevenDay.id, site.id, ago(d), 4)

  const { user: user2, workspace: workspace2 } = await seedUserWithWorkspace('b@x.test')
  const { crew: twentyDay, site: site2 } = await seedCrewAndSite(workspace2.id, 'TWENTY')
  for (let d = 20; d >= 1; d -= 1) await seedShift(workspace2.id, twentyDay.id, site2.id, ago(d), 4)

  const res7 = await server.request(`/api/ops/fatigue/${sevenDay.id}?workspaceId=${workspace.id}`, { headers: { Authorization: bearer(user.id) } })
  const res20 = await server.request(`/api/ops/fatigue/${twentyDay.id}?workspaceId=${workspace2.id}`, { headers: { Authorization: bearer(user2.id) } })

  assert.equal(res7.body.fatigue.consecutiveDays, 7)
  assert.equal(res20.body.fatigue.consecutiveDays, 20, 'a 30-day lookback must distinguish a 20-day streak from a 7-day one')
  assert.notEqual(res7.body.fatigue.consecutiveDays, res20.body.fatigue.consecutiveDays)
  assert.equal(res7.body.fatigue.consecutiveDaysCapped, false)
  assert.equal(res20.body.fatigue.consecutiveDaysCapped, false)
})

test('a streak that fills the entire lookback window is reported as capped ("N+")', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const { crew, site } = await seedCrewAndSite(workspace.id)
  // 35 consecutive days — longer than the 30-day lookback, so the true streak
  // length is unknowable from this window and must be reported as capped.
  for (let d = 35; d >= 1; d -= 1) await seedShift(workspace.id, crew.id, site.id, ago(d), 4)

  const res = await server.request(`/api/ops/fatigue/${crew.id}?workspaceId=${workspace.id}`, { headers: { Authorization: bearer(user.id) } })
  assert.equal(res.status, 200)
  assert.equal(res.body.fatigue.consecutiveDaysCapped, true)
  assert.ok(res.body.fatigue.factors.some((f: string) => f.includes('+')), 'capped factor text should say "N+"')
})

test('fatigue routes require workspace membership', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const outsider = await seedUserWithWorkspace('outsider@x.test')
  const { crew } = await seedCrewAndSite(workspace.id)

  const res = await server.request(`/api/ops/fatigue/${crew.id}?workspaceId=${workspace.id}`, { headers: { Authorization: bearer(outsider.user.id) } })
  assert.equal(res.status, 403)
})
