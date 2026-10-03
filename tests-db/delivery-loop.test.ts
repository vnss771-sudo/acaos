// End-to-end over the real routes and a real database: one piece of work taken
// through the whole loop — found → pursued → quoted → won → job → crew and
// shifts → closeout → margin report — plus the tenant boundary around it.
// Each step goes through the API a user would call, not a direct DB write
// (only the discovered opportunity itself is seeded, as the sweep would).
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { deliveryRouter } from '../apps/api/src/routes/delivery.ts'
import { opportunitiesRouter } from '../apps/api/src/routes/opportunities.ts'
import { opsRouter } from '../apps/api/src/routes/ops/index.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace, startTestServer, bearer, type TestServer } from './helpers/db.ts'

let delivery: TestServer
let opps: TestServer
let ops: TestServer
before(async () => {
  delivery = await startTestServer('/api/delivery', deliveryRouter)
  opps = await startTestServer('/api/opportunities', opportunitiesRouter)
  ops = await startTestServer('/api/ops', opsRouter as express.Router)
})
after(async () => { await delivery.close(); await opps.close(); await ops.close(); await disconnect() })
beforeEach(async () => { await resetDb() })

function call(s: TestServer, userId: string, method: string, path: string, body?: unknown) {
  return s.request(path, {
    method,
    headers: { Authorization: bearer(userId), 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

test('the full loop: find → quote → win → job → shifts → closeout → report', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const ws = workspace.id
  const found = await prisma.opportunity.create({
    data: {
      workspaceId: ws, source: 'planningalerts', externalId: 'DA-2026-77', kind: 'DEVELOPMENT_APPLICATION',
      title: 'Cold store fit-out, Eagle Farm', score: 81, matchedTrades: ['electrical'], reasons: ['Matches electrical'],
      contentHash: 'h1', region: 'QLD', address: '7 Export St, Eagle Farm QLD',
    },
  })

  // Pursue it, then quote it (the capture moment), then the client accepts.
  assert.equal((await call(opps, user.id, 'PATCH', `/api/opportunities/${found.id}/status`, { workspaceId: ws, status: 'PURSUING' })).status, 200)
  const quote = await call(delivery, user.id, 'POST', '/api/delivery/quotes', { workspaceId: ws, opportunityId: found.id, amountCents: 4_000_000, estimatedHours: 200, submit: true })
  assert.equal(quote.status, 201, JSON.stringify(quote.body))
  const accepted = await call(delivery, user.id, 'PATCH', `/api/delivery/quotes/${quote.body.quote.id}/status`, { workspaceId: ws, status: 'ACCEPTED' })
  assert.equal(accepted.status, 200)
  assert.equal((await prisma.opportunity.findUnique({ where: { id: found.id } }))!.status, 'WON')

  // Start the job, hire the crew, record the shifts through the Field Ops API.
  const job = await call(delivery, user.id, 'POST', `/api/delivery/quotes/${quote.body.quote.id}/job`, { workspaceId: ws, jobCode: 'EF-1' })
  assert.equal(job.status, 201, JSON.stringify(job.body))
  const siteId = job.body.job.opsJobSiteId
  const crewIds: string[] = []
  for (const [code, rate] of [['E1', 60], ['E2', 45]] as const) {
    const c = await call(ops, user.id, 'POST', '/api/ops/crew', { workspaceId: ws, employeeCode: code, fullName: `Sparky ${code}`, role: 'Electrician', baseRate: rate })
    assert.equal(c.status, 201, JSON.stringify(c.body))
    crewIds.push(c.body.crew.id)
  }
  // 12 shifts of 10 hours each per electrician (no breaks): 240 h against 200 estimated.
  for (let d = 0; d < 12; d++) {
    for (const crewMemberId of crewIds) {
      const day = new Date(Date.UTC(2026, 8, 1 + d))
      const start = new Date(day.getTime() + 6 * 3_600_000)
      const end = new Date(start.getTime() + 10 * 3_600_000)
      const s = await call(ops, user.id, 'POST', '/api/ops/shifts', {
        workspaceId: ws, crewMemberId, jobSiteId: siteId, shiftDate: day.toISOString(), startTime: start.toISOString(), endTime: end.toISOString(),
      })
      assert.equal(s.status, 201, JSON.stringify(s.body))
    }
  }

  const live = await call(delivery, user.id, 'GET', `/api/delivery/jobs/${job.body.job.id}?workspaceId=${ws}`)
  assert.equal(live.body.job.economics.actualHours, 240)
  assert.equal(live.body.job.economics.hoursVariancePct, 20)
  assert.equal(live.body.job.economicsFrozen, false)

  // Done: invoice $42,000, materials $11,000, 25% on-costs.
  const closed = await call(delivery, user.id, 'POST', `/api/delivery/jobs/${job.body.job.id}/closeout`, { workspaceId: ws, invoicedRevenueCents: 4_200_000, otherCostCents: 1_100_000, onCostPct: 25 })
  assert.equal(closed.status, 200, JSON.stringify(closed.body))
  const e = closed.body.job.economics
  // Labour: (120 × 60 + 120 × 45) × 1.25 = 15,750 dollars.
  assert.equal(e.labourCostCents, 1_575_000)
  assert.equal(e.grossMarginCents, 4_200_000 - 1_575_000 - 1_100_000)
  assert.equal(e.grossMarginPct, 36.3)
  assert.equal(e.revenueVsQuotePct, 5)
  assert.equal(e.marginBasis, 'GROSS')
  assert.deepEqual(e.gaps, [])

  // A shift logged after closeout is flagged, not silently ignored or folded in.
  const late = await call(ops, user.id, 'POST', '/api/ops/shifts', {
    workspaceId: ws, crewMemberId: crewIds[0], jobSiteId: siteId, shiftDate: '2026-09-20T00:00:00.000Z', startTime: '2026-09-20T06:00:00.000Z', endTime: '2026-09-20T10:00:00.000Z',
  })
  assert.equal(late.status, 201)
  const flagged = await call(delivery, user.id, 'GET', `/api/delivery/jobs/${job.body.job.id}?workspaceId=${ws}`)
  assert.equal(flagged.body.job.shiftsAfterCloseout, 1)
  assert.equal(flagged.body.job.economics.actualHours, 240, 'frozen figures are unchanged')

  // One job is not a pattern: the report counts it but withholds the medians.
  const report = await call(delivery, user.id, 'GET', `/api/delivery/report?workspaceId=${ws}`)
  assert.equal(report.body.report.overall.jobs, 1)
  assert.equal(report.body.report.overall.grossMarginPct, null)
  assert.equal(report.body.report.groups[0].label, 'Development applications')

  // Every step left an audit trail.
  const types = (await prisma.auditEvent.findMany({ where: { workspaceId: ws }, select: { type: true } })).map(a => a.type)
  for (const t of ['discovery.opportunity_status', 'quote.created', 'quote.status', 'job.created', 'job.closeout']) assert.ok(types.includes(t), t)
})

test('tenant boundary: another workspace\'s admin can neither see nor change this workspace\'s quotes and jobs', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const intruder = await seedUserWithWorkspace()
  const opp = await prisma.opportunity.create({
    data: { workspaceId: workspace.id, source: 'austender', externalId: 'CN1', kind: 'CONTRACT_AWARD', title: 'x', score: 50, matchedTrades: [], reasons: [], contentHash: 'h', status: 'PURSUING' },
  })
  const q = await call(delivery, user.id, 'POST', '/api/delivery/quotes', { workspaceId: workspace.id, opportunityId: opp.id, amountCents: 100_000, submit: true })
  await call(delivery, user.id, 'PATCH', `/api/delivery/quotes/${q.body.quote.id}/status`, { workspaceId: workspace.id, status: 'ACCEPTED' })
  const job = await call(delivery, user.id, 'POST', `/api/delivery/quotes/${q.body.quote.id}/job`, { workspaceId: workspace.id })
  assert.equal(job.status, 201)

  // Naming the victim's workspace: not a member → 403.
  assert.equal((await call(delivery, intruder.user.id, 'GET', `/api/delivery/jobs?workspaceId=${workspace.id}`)).status, 403)
  // Naming their own workspace with the victim's ids: not found, nothing changes.
  const own = intruder.workspace.id
  assert.equal((await call(delivery, intruder.user.id, 'GET', `/api/delivery/jobs/${job.body.job.id}?workspaceId=${own}`)).status, 404)
  assert.equal((await call(delivery, intruder.user.id, 'POST', `/api/delivery/jobs/${job.body.job.id}/closeout`, { workspaceId: own, invoicedRevenueCents: 1 })).status, 404)
  assert.equal((await call(delivery, intruder.user.id, 'PATCH', `/api/delivery/quotes/${q.body.quote.id}/status`, { workspaceId: own, status: 'WITHDRAWN' })).status, 404)
  assert.equal((await call(delivery, intruder.user.id, 'POST', `/api/delivery/quotes/${q.body.quote.id}/job`, { workspaceId: own })).status, 404)
  assert.equal((await call(delivery, intruder.user.id, 'POST', '/api/delivery/quotes', { workspaceId: own, opportunityId: opp.id, amountCents: 1 })).status, 404)
  const lists = await call(delivery, intruder.user.id, 'GET', `/api/delivery/quotes?workspaceId=${own}&opportunityId=${opp.id}`)
  assert.deepEqual(lists.body.quotes, [])
  assert.equal((await prisma.job.findUnique({ where: { id: job.body.job.id } }))!.status, 'ACTIVE')
})
