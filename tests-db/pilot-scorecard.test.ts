// The pilot scorecard over a real database: Find work taken through the routes
// a contractor uses (pursue, quote, accept, start the job, close it out), then
// read back by GET /api/delivery/scorecard and the platform admin's
// GET /api/admin/pilot-scorecards. Another workspace's work never counts.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { deliveryRouter } from '../apps/api/src/routes/delivery.ts'
import { opportunitiesRouter } from '../apps/api/src/routes/opportunities.ts'
import { adminRouter } from '../apps/api/src/routes/admin.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace, startTestServer, bearer, type TestServer } from './helpers/db.ts'

let delivery: TestServer
let opps: TestServer
let admin: TestServer
before(async () => {
  delivery = await startTestServer('/api/delivery', deliveryRouter)
  opps = await startTestServer('/api/opportunities', opportunitiesRouter)
  admin = await startTestServer('/api/admin', adminRouter)
})
after(async () => { await delivery.close(); await opps.close(); await admin.close(); await disconnect() })
beforeEach(async () => { await resetDb() })

const DAY = 86_400_000

function call(s: TestServer, userId: string, method: string, path: string, body?: unknown) {
  return s.request(path, {
    method,
    headers: { Authorization: bearer(userId), 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

let n = 0
function seedOpportunity(workspaceId: string, kind: string, firstSeenAt = new Date()) {
  n++
  return prisma.opportunity.create({
    data: {
      workspaceId, source: kind === 'CONTRACT_AWARD' ? 'austender' : 'planningalerts', externalId: `X-${n}`, kind,
      title: `Work ${n}`, score: 70, matchedTrades: ['electrical'], reasons: ['Matches electrical'], contentHash: `h${n}`, firstSeenAt,
    },
  })
}

// Find work set up a month ago, so the scorecard shows full weeks.
async function seedContractor(email?: string) {
  const { user, workspace } = await seedUserWithWorkspace(email)
  await prisma.discoveryProfile.create({ data: { workspaceId: workspace.id, trades: ['electrical'], createdAt: new Date(Date.now() - 30 * DAY) } })
  return { user, ws: workspace.id }
}

async function quoteAndWin(userId: string, ws: string, opportunityId: string, amountCents: number) {
  const q = await call(delivery, userId, 'POST', '/api/delivery/quotes', { workspaceId: ws, opportunityId, amountCents, estimatedHours: 40, submit: true })
  assert.equal(q.status, 201, JSON.stringify(q.body))
  const a = await call(delivery, userId, 'PATCH', `/api/delivery/quotes/${q.body.quote.id}/status`, { workspaceId: ws, status: 'ACCEPTED' })
  assert.equal(a.status, 200, JSON.stringify(a.body))
  return q.body.quote.id as string
}

test('the scorecard counts a week of Find work through quote, win and closeout', async () => {
  const { user, ws } = await seedContractor()
  const da = await seedOpportunity(ws, 'DEVELOPMENT_APPLICATION')
  const award = await seedOpportunity(ws, 'CONTRACT_AWARD')
  const dismissed = await seedOpportunity(ws, 'DEVELOPMENT_APPLICATION')
  await seedOpportunity(ws, 'DEVELOPMENT_APPLICATION', new Date(Date.now() - 10 * DAY)) // last week

  // Pursue and quote the award (no decision yet); dismiss one; win the DA.
  assert.equal((await call(opps, user.id, 'PATCH', `/api/opportunities/${award.id}/status`, { workspaceId: ws, status: 'PURSUING' })).status, 200)
  assert.equal((await call(delivery, user.id, 'POST', '/api/delivery/quotes', { workspaceId: ws, opportunityId: award.id, amountCents: 2_350_000, submit: true })).status, 201)
  assert.equal((await call(opps, user.id, 'PATCH', `/api/opportunities/${dismissed.id}/status`, { workspaceId: ws, status: 'DISMISSED' })).status, 200)
  const quoteId = await quoteAndWin(user.id, ws, da.id, 1_850_000)

  // Start the job, log a costed shift, close it out with an invoice and costs.
  const job = await call(delivery, user.id, 'POST', `/api/delivery/quotes/${quoteId}/job`, { workspaceId: ws, jobCode: 'SC-1' })
  assert.equal(job.status, 201, JSON.stringify(job.body))
  const crew = await prisma.opsCrewMember.create({ data: { workspaceId: ws, employeeCode: 'E1', fullName: 'Sparky One', role: 'Electrician', baseRate: 50 } })
  const start = new Date(Date.now() - 2 * DAY)
  await prisma.opsShiftRecord.create({
    data: { workspaceId: ws, crewMemberId: crew.id, jobSiteId: job.body.job.opsJobSiteId, shiftDate: start, startTime: start, endTime: new Date(start.getTime() + 8 * 3_600_000), totalHours: 40 },
  })
  const closed = await call(delivery, user.id, 'POST', `/api/delivery/jobs/${job.body.job.id}/closeout`, {
    workspaceId: ws, invoicedRevenueCents: 2_000_000, otherCostCents: 600_000,
  })
  assert.equal(closed.status, 200, JSON.stringify(closed.body))

  const res = await call(delivery, user.id, 'GET', `/api/delivery/scorecard?workspaceId=${ws}&weeks=4`)
  assert.equal(res.status, 200, JSON.stringify(res.body))
  const sc = res.body.scorecard
  assert.equal(sc.findWorkSetUp, true)
  assert.equal(sc.weeks.length, 4)
  assert.deepEqual(
    { found: sc.weeks[0].found, pursued: sc.weeks[0].pursued, quoted: sc.weeks[0].quoted, quotedCents: sc.weeks[0].quotedCents, won: sc.weeks[0].won, wonCents: sc.weeks[0].wonCents },
    { found: 3, pursued: 2, quoted: 2, quotedCents: 4_200_000, won: 1, wonCents: 1_850_000 },
  )
  assert.equal(sc.weeks[1].found, 1)
  assert.deepEqual(sc.checks.thisWeek, { found: true, quotes: true })
  // Labour 40 h × $50 = $2,000; gross margin $20,000 − $2,000 − $6,000 = $12,000 (60%).
  assert.deepEqual(sc.margin, { closedJobs: 1, grossMarginJobs: 1, grossMarginCents: 1_200_000, revenueCents: 2_000_000, grossMarginPct: 60 })
  assert.equal(sc.closeout.closedOut, 1)
  assert.equal(sc.closeout.rate, 1)
  assert.deepEqual(sc.bestSource, { kind: 'DEVELOPMENT_APPLICATION', label: 'Development applications', basis: 'GROSS_MARGIN', cents: 1_200_000, jobs: 1 })
  assert.equal(sc.checks.sourceIdentified, true)
  assert.deepEqual(sc.conversion.quoteToWon, { quoted: 2, won: 1, lost: 0, awaiting: 1, rate: 0.5 })
})

test('another workspace’s work never counts, and a non-member is refused', async () => {
  const mine = await seedContractor()
  const theirs = await seedContractor()
  await seedOpportunity(theirs.ws, 'CONTRACT_AWARD')
  const theirWin = await seedOpportunity(theirs.ws, 'DEVELOPMENT_APPLICATION')
  await quoteAndWin(theirs.user.id, theirs.ws, theirWin.id, 5_000_000)

  const res = await call(delivery, mine.user.id, 'GET', `/api/delivery/scorecard?workspaceId=${mine.ws}`)
  assert.equal(res.status, 200)
  assert.equal(res.body.scorecard.totals.found, 0)
  assert.equal(res.body.scorecard.totals.won, 0)

  const denied = await call(delivery, mine.user.id, 'GET', `/api/delivery/scorecard?workspaceId=${theirs.ws}`)
  assert.equal(denied.status, 403)
})

test('the platform admin sees every pilot’s scorecard; workspaces without Find work are left out', async () => {
  const pilot = await seedContractor()
  await seedOpportunity(pilot.ws, 'DEVELOPMENT_APPLICATION')
  await seedUserWithWorkspace() // outreach only: no Find work
  const { user: founder } = await seedUserWithWorkspace('founder@acaos.test')
  await prisma.user.update({ where: { id: founder.id }, data: { isPlatformAdmin: true, emailVerified: true } })

  const res = await call(admin, founder.id, 'GET', '/api/admin/pilot-scorecards')
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body.pilots.length, 1)
  assert.equal(res.body.pilots[0].workspace.id, pilot.ws)
  assert.equal(res.body.pilots[0].scorecard.weeks[0].found, 1)

  const denied = await call(admin, pilot.user.id, 'GET', '/api/admin/pilot-scorecards')
  assert.equal(denied.status, 403)
})
