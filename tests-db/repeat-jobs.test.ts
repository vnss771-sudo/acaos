// Repeat jobs per site and shift → job attribution (UQ-24), over the real routes
// and a real database. A site can host several Jobs over time; each shift is
// costed to one Job, so a second project at the same site never mixes hours,
// margin, late-shift flags or closeout with the first.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { deliveryRouter } from '../apps/api/src/routes/delivery.ts'
import { opsRouter } from '../apps/api/src/routes/ops/index.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace, startTestServer, bearer, type TestServer } from './helpers/db.ts'

let delivery: TestServer
let ops: TestServer
before(async () => {
  delivery = await startTestServer('/api/delivery', deliveryRouter)
  ops = await startTestServer('/api/ops', opsRouter as express.Router)
})
after(async () => { await delivery.close(); await ops.close(); await disconnect() })
beforeEach(async () => { await resetDb() })

function call(s: TestServer, userId: string, method: string, path: string, body?: unknown) {
  return s.request(path, {
    method,
    headers: { Authorization: bearer(userId), 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

let seq = 0
async function acceptedQuote(userId: string, ws: string) {
  seq++
  const opp = await prisma.opportunity.create({
    data: {
      workspaceId: ws, source: 'planningalerts', externalId: `DA-R${seq}`, kind: 'DEVELOPMENT_APPLICATION', title: `Stage ${seq} fit-out`,
      score: 70, matchedTrades: ['electrical'], reasons: ['Matches electrical'], contentHash: `r${seq}`, region: 'QLD', status: 'PURSUING',
    },
  })
  const quote = await call(delivery, userId, 'POST', '/api/delivery/quotes', { workspaceId: ws, opportunityId: opp.id, amountCents: 2_000_000, estimatedHours: 40, submit: true })
  assert.equal(quote.status, 201, JSON.stringify(quote.body))
  assert.equal((await call(delivery, userId, 'PATCH', `/api/delivery/quotes/${quote.body.quote.id}/status`, { workspaceId: ws, status: 'ACCEPTED' })).status, 200)
  return quote.body.quote.id as string
}

function shift(userId: string, ws: string, crewMemberId: string, jobSiteId: string, day: number, hours: number, jobId?: string) {
  const start = new Date(Date.UTC(2026, 8, day, 6))
  return call(ops, userId, 'POST', '/api/ops/shifts', {
    workspaceId: ws, crewMemberId, jobSiteId, ...(jobId ? { jobId } : {}),
    shiftDate: new Date(Date.UTC(2026, 8, day)).toISOString(), startTime: start.toISOString(), endTime: new Date(start.getTime() + hours * 3_600_000).toISOString(),
  })
}

const jobOf = async (userId: string, ws: string, id: string) => (await call(delivery, userId, 'GET', `/api/delivery/jobs/${id}?workspaceId=${ws}`)).body.job

test('a second job at the same site keeps its own hours, late shifts and closeout', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const ws = workspace.id
  const crew = await call(ops, user.id, 'POST', '/api/ops/crew', { workspaceId: ws, employeeCode: 'E1', fullName: 'Sparky', role: 'Electrician', baseRate: 50 })
  const crewId = crew.body.crew.id as string

  // Job 1: its site is created with it; a one-job site attributes automatically.
  const first = await call(delivery, user.id, 'POST', `/api/delivery/quotes/${await acceptedQuote(user.id, ws)}/job`, { workspaceId: ws, jobCode: 'SITE-1' })
  assert.equal(first.status, 201, JSON.stringify(first.body))
  const job1 = first.body.job.id as string
  const siteId = first.body.job.opsJobSiteId as string
  const s1 = await shift(user.id, ws, crewId, siteId, 1, 10)
  assert.equal(s1.status, 201, JSON.stringify(s1.body))
  assert.equal(s1.body.shift.jobId, job1)
  assert.equal((await call(delivery, user.id, 'POST', `/api/delivery/jobs/${job1}/closeout`, { workspaceId: ws, invoicedRevenueCents: 1_000_000, otherCostCents: 0 })).status, 200)

  // Late work with no other job still lands on job 1 and is flagged there.
  const late = await shift(user.id, ws, crewId, siteId, 3, 2)
  assert.equal(late.body.shift.jobId, job1)
  assert.equal((await jobOf(user.id, ws, job1)).shiftsAfterCloseout, 1)

  // Job 2: repeat work at the same physical site.
  const second = await call(delivery, user.id, 'POST', `/api/delivery/quotes/${await acceptedQuote(user.id, ws)}/job`, { workspaceId: ws, opsJobSiteId: siteId })
  assert.equal(second.status, 201, JSON.stringify(second.body))
  const job2 = second.body.job.id as string
  assert.equal(second.body.job.opsJobSiteId, siteId)
  assert.notEqual(job2, job1)
  assert.equal(await prisma.opsJobSite.count({ where: { workspaceId: ws } }), 1)

  // With one ACTIVE job, new labour goes to it — and is not job 1's late work.
  const s2 = await shift(user.id, ws, crewId, siteId, 10, 6)
  assert.equal(s2.body.shift.jobId, job2)
  const j1 = await jobOf(user.id, ws, job1)
  assert.equal(j1.shiftsAfterCloseout, 1, 'job 2 labour is not counted as job 1 late work')
  assert.equal(j1.economics.actualHours, 10, 'frozen job 1 figures are unchanged')
  assert.equal((await jobOf(user.id, ws, job2)).economics.actualHours, 6)

  // Reopen job 1: two ACTIVE jobs, so a shift must name its job.
  assert.equal((await call(delivery, user.id, 'POST', `/api/delivery/jobs/${job1}/reopen`, { workspaceId: ws, reason: 'Variation' })).status, 200)
  const ambiguous = await shift(user.id, ws, crewId, siteId, 11, 4)
  assert.equal(ambiguous.status, 409)
  assert.match(ambiguous.body.error, /choose which job/)
  const clockAmbiguous = await call(ops, user.id, 'POST', '/api/ops/clock/in', { workspaceId: ws, crewMemberId: crewId, jobSiteId: siteId })
  assert.equal(clockAmbiguous.status, 409)
  const clocked = await call(ops, user.id, 'POST', '/api/ops/clock/in', { workspaceId: ws, crewMemberId: crewId, jobSiteId: siteId, jobId: job1 })
  assert.equal(clocked.status, 201, JSON.stringify(clocked.body))
  assert.equal(clocked.body.shift.jobId, job1)
  await prisma.opsShiftRecord.delete({ where: { id: clocked.body.shift.id } })
  assert.equal((await shift(user.id, ws, crewId, siteId, 12, 3, job1)).body.shift.jobId, job1)

  // Closing job 2 costs only job 2's labour.
  const closed2 = await call(delivery, user.id, 'POST', `/api/delivery/jobs/${job2}/closeout`, { workspaceId: ws, invoicedRevenueCents: 800_000, otherCostCents: 0 })
  assert.equal(closed2.status, 200, JSON.stringify(closed2.body))
  assert.equal(closed2.body.job.economics.actualHours, 6)

  // Field Ops lists the site's jobs by identity only — no money for crew eyes.
  const sites = await call(ops, user.id, 'GET', `/api/ops/jobs?workspaceId=${ws}`)
  const listed = sites.body.jobSites[0].jobs as Array<Record<string, unknown>>
  assert.deepEqual(listed.map(j => j.id).sort(), [job1, job2].sort())
  for (const j of listed) assert.deepEqual(Object.keys(j).sort(), ['id', 'label', 'startedAt', 'status'])
})

test('a job named for another site is refused; a first job at a plain site takes over its site-only shifts', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const ws = workspace.id
  const crewId = (await call(ops, user.id, 'POST', '/api/ops/crew', { workspaceId: ws, employeeCode: 'E1', fullName: 'Sparky', role: 'Electrician', baseRate: 50 })).body.crew.id as string
  const plain = await call(ops, user.id, 'POST', '/api/ops/jobs', { workspaceId: ws, jobCode: 'DEPOT', siteName: 'Depot' })
  assert.equal(plain.status, 201, JSON.stringify(plain.body))
  const plainSite = plain.body.jobSite.id as string

  // No job at the site: Field Ops on its own keeps site-only shifts.
  const before = await shift(user.id, ws, crewId, plainSite, 1, 5)
  assert.equal(before.status, 201)
  assert.equal(before.body.shift.jobId, null)

  const other = await call(delivery, user.id, 'POST', `/api/delivery/quotes/${await acceptedQuote(user.id, ws)}/job`, { workspaceId: ws })
  assert.equal((await shift(user.id, ws, crewId, plainSite, 2, 1, other.body.job.id)).status, 404, 'a job from another site')

  const made = await call(delivery, user.id, 'POST', `/api/delivery/quotes/${await acceptedQuote(user.id, ws)}/job`, { workspaceId: ws, opsJobSiteId: plainSite })
  assert.equal(made.status, 201, JSON.stringify(made.body))
  assert.equal((await prisma.opsShiftRecord.findUniqueOrThrow({ where: { id: before.body.shift.id } })).jobId, made.body.job.id)
  assert.equal((await jobOf(user.id, ws, made.body.job.id)).economics.actualHours, 5)

  // Another workspace's site can't host this workspace's job.
  const stranger = await seedUserWithWorkspace('stranger@acme.test')
  const theirs = await call(ops, stranger.user.id, 'POST', '/api/ops/jobs', { workspaceId: stranger.workspace.id, jobCode: 'X', siteName: 'Theirs' })
  const refused = await call(delivery, user.id, 'POST', `/api/delivery/quotes/${await acceptedQuote(user.id, ws)}/job`, { workspaceId: ws, opsJobSiteId: theirs.body.jobSite.id })
  assert.equal(refused.status, 404)
})
