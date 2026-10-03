// Database-backed tests for /api/delivery (phase 15A): quotes on both
// opportunity types, the accepted-quote → job transition, closeout freezing the
// economics, reopen, the admin gate, and the constraints the migration adds.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { deliveryRouter } from '../apps/api/src/routes/delivery.ts'
import { opportunitiesRouter } from '../apps/api/src/routes/opportunities.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace, startTestServer, bearer, type TestServer } from './helpers/db.ts'

let server: TestServer
let oppServer: TestServer
before(async () => {
  server = await startTestServer('/api/delivery', deliveryRouter)
  oppServer = await startTestServer('/api/opportunities', opportunitiesRouter)
})
after(async () => { await server.close(); await oppServer.close(); await disconnect() })
beforeEach(async () => { await resetDb() })

function req(userId: string, method: string, path: string, body?: unknown, s = server, prefix = '/api/delivery') {
  return s.request(`${prefix}${path}`, {
    method,
    headers: { Authorization: bearer(userId), 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

let seq = 0
async function seedOpportunity(workspaceId: string, over: Record<string, unknown> = {}) {
  seq++
  return prisma.opportunity.create({
    data: {
      workspaceId, source: 'planningalerts', externalId: `DA${seq}`, kind: 'DEVELOPMENT_APPLICATION', title: `Warehouse fit-out ${seq}`,
      score: 70, matchedTrades: ['electrical'], reasons: ['Matches electrical'], contentHash: `h${seq}`, region: 'QLD', status: 'PURSUING',
      ...over,
    },
  })
}

async function seedCommercialOpportunity(workspaceId: string) {
  const prospect = await prisma.prospect.create({ data: { workspaceId, companyName: 'Northside Builders' } })
  return prisma.commercialOpportunity.create({
    data: {
      workspaceId, prospectId: prospect.id, offerKey: 'offer:x', eventType: 'CAPACITY_EXPANSION', eventFamily: 'GROWTH',
      eventTitle: 'New depot', whyNow: 'Expanding', confidence: 80, evidenceConfidence: 80, independentSources: 2,
      trustworthySignals: 2, offerFit: 70, intentScore: 70, timingScore: 70, contactability: 70, probability: 0.3,
      urgency: 'HIGH', priority: 80, buyingStage: 'ACTIVE_REQUIREMENT', recommendedAction: 'CONTACT_NOW', actionLabel: 'Call',
      actionReason: 'Corroborated', blockers: [], reasons: [], evidence: [], velocity: [], intelligenceGate: true, status: 'PURSUING',
    },
  })
}

async function acceptedQuote(userId: string, workspaceId: string, target: Record<string, string>, amountCents = 6_000_000, estimatedHours = 400) {
  const created = await req(userId, 'POST', '/quotes', { workspaceId, ...target, amountCents, estimatedHours, submit: true })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const accepted = await req(userId, 'PATCH', `/quotes/${created.body.quote.id}/status`, { workspaceId, status: 'ACCEPTED' })
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body))
  return created.body.quote.id as string
}

async function seedShift(workspaceId: string, crewMemberId: string, jobSiteId: string, totalHours: number, open = false) {
  const start = new Date('2026-09-01T07:00:00Z')
  return prisma.opsShiftRecord.create({
    data: {
      workspaceId, crewMemberId, jobSiteId, shiftDate: start, startTime: start,
      endTime: open ? null : new Date(start.getTime() + totalHours * 3_600_000), totalHours: open ? 0 : totalHours,
    },
  })
}

test('quotes: exactly one target, tenant-scoped, admin-only, and validated', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const other = await seedUserWithWorkspace()
  const opp = await seedOpportunity(workspace.id)
  const foreign = await seedOpportunity(other.workspace.id)
  const co = await seedCommercialOpportunity(workspace.id)

  assert.equal((await req(user.id, 'POST', '/quotes', { workspaceId: workspace.id, amountCents: 100 })).status, 400)
  assert.equal((await req(user.id, 'POST', '/quotes', { workspaceId: workspace.id, opportunityId: opp.id, commercialOpportunityId: co.id, amountCents: 100 })).status, 400)
  assert.equal((await req(user.id, 'POST', '/quotes', { workspaceId: workspace.id, opportunityId: opp.id, amountCents: -1 })).status, 400)
  assert.equal((await req(user.id, 'POST', '/quotes', { workspaceId: workspace.id, opportunityId: foreign.id, amountCents: 100 })).status, 404)

  const member = await seedUserWithWorkspace()
  await prisma.membership.create({ data: { userId: member.user.id, workspaceId: workspace.id, role: 'member' } })
  assert.equal((await req(member.user.id, 'POST', '/quotes', { workspaceId: workspace.id, opportunityId: opp.id, amountCents: 100 })).status, 403)
  assert.equal((await req(member.user.id, 'GET', `/jobs?workspaceId=${workspace.id}`)).status, 403, 'economics are admin-only')

  const draft = await req(user.id, 'POST', '/quotes', { workspaceId: workspace.id, opportunityId: opp.id, amountCents: 500_000 })
  assert.equal(draft.status, 201)
  assert.equal(draft.body.quote.status, 'DRAFT')
  const list = await req(user.id, 'GET', `/quotes?workspaceId=${workspace.id}&opportunityId=${opp.id}`)
  assert.equal(list.body.quotes.length, 1)
  assert.ok(await prisma.auditEvent.findFirst({ where: { type: 'quote.created' } }))
})

test('quote lifecycle: transitions enforced; accepting marks the opportunity WON; one accepted quote per opportunity', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const opp = await seedOpportunity(workspace.id)
  const draft = await req(user.id, 'POST', '/quotes', { workspaceId: workspace.id, opportunityId: opp.id, amountCents: 100_000 })
  const id = draft.body.quote.id
  assert.equal((await req(user.id, 'PATCH', `/quotes/${id}/status`, { workspaceId: workspace.id, status: 'ACCEPTED' })).status, 409, 'a draft is not accepted')

  await acceptedQuote(user.id, workspace.id, { opportunityId: opp.id })
  assert.equal((await prisma.opportunity.findUnique({ where: { id: opp.id } }))!.status, 'WON')

  const rival = await req(user.id, 'POST', '/quotes', { workspaceId: workspace.id, opportunityId: opp.id, amountCents: 90_000, submit: true })
  const second = await req(user.id, 'PATCH', `/quotes/${rival.body.quote.id}/status`, { workspaceId: workspace.id, status: 'ACCEPTED' })
  assert.equal(second.status, 409)
  assert.match(second.body.error, /already accepted/)
  assert.equal((await req(user.id, 'PATCH', `/quotes/${rival.body.quote.id}/status`, { workspaceId: workspace.id, status: 'REJECTED' })).status, 200)
})

test('accepted quote → job: creates the site and job, links the opportunity, and refuses a second job', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const opp = await seedOpportunity(workspace.id, { address: '9 Dock Rd, Brisbane QLD' })
  const quoteId = await acceptedQuote(user.id, workspace.id, { opportunityId: opp.id })

  const made = await req(user.id, 'POST', `/quotes/${quoteId}/job`, { workspaceId: workspace.id, jobCode: 'WH-1' })
  assert.equal(made.status, 201, JSON.stringify(made.body))
  const site = await prisma.opsJobSite.findUnique({ where: { id: made.body.job.opsJobSiteId } })
  assert.equal(site!.jobCode, 'WH-1')
  assert.equal((await prisma.opportunity.findUnique({ where: { id: opp.id } }))!.opsJobSiteId, site!.id)
  assert.equal((await req(user.id, 'POST', `/quotes/${quoteId}/job`, { workspaceId: workspace.id })).status, 409)

  const jobs = await req(user.id, 'GET', `/jobs?workspaceId=${workspace.id}`)
  assert.equal(jobs.body.jobs.length, 1)
  assert.equal(jobs.body.jobs[0].origin.type, 'OPPORTUNITY')
  assert.equal(jobs.body.jobs[0].origin.kind, 'DEVELOPMENT_APPLICATION')
  assert.equal(jobs.body.jobs[0].economicsFrozen, false)
})

test('legacy "won → job site" also creates the Job, carrying the accepted quote', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const opp = await seedOpportunity(workspace.id)
  const quoteId = await acceptedQuote(user.id, workspace.id, { opportunityId: opp.id })
  const made = await req(user.id, 'POST', `/${opp.id}/create-job`, { workspaceId: workspace.id }, oppServer, '/api/opportunities')
  assert.equal(made.status, 201, JSON.stringify(made.body))
  const job = await prisma.job.findUnique({ where: { opsJobSiteId: made.body.jobSite.id } })
  assert.equal(job!.quoteId, quoteId)
  assert.equal((await req(user.id, 'POST', `/quotes/${quoteId}/job`, { workspaceId: workspace.id })).status, 409)
})

test('a quote accepted after the site exists attaches to that site\'s job', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const opp = await seedOpportunity(workspace.id, { status: 'WON' })
  const made = await req(user.id, 'POST', `/${opp.id}/create-job`, { workspaceId: workspace.id }, oppServer, '/api/opportunities')
  assert.equal(made.status, 201)
  const quoteId = await acceptedQuote(user.id, workspace.id, { opportunityId: opp.id })
  const attached = await req(user.id, 'POST', `/quotes/${quoteId}/job`, { workspaceId: workspace.id })
  assert.equal(attached.status, 201, JSON.stringify(attached.body))
  assert.equal(attached.body.job.opsJobSiteId, made.body.jobSite.id)
  assert.equal(await prisma.opsJobSite.count({ where: { workspaceId: workspace.id } }), 1)
})

test('closeout: refused with open shifts; freezes economics; later rate changes do not rewrite history; reopen is audited', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const co = await seedCommercialOpportunity(workspace.id)
  const quoteId = await acceptedQuote(user.id, workspace.id, { commercialOpportunityId: co.id })
  assert.equal((await prisma.commercialOpportunity.findUnique({ where: { id: co.id } }))!.status, 'WON')
  const made = await req(user.id, 'POST', `/quotes/${quoteId}/job`, { workspaceId: workspace.id })
  assert.equal(made.status, 201, JSON.stringify(made.body))
  const jobId = made.body.job.id
  const siteId = made.body.job.opsJobSiteId
  assert.match((await prisma.opsJobSite.findUnique({ where: { id: siteId } }))!.siteName, /Northside Builders/)

  const a = await prisma.opsCrewMember.create({ data: { workspaceId: workspace.id, employeeCode: 'E1', fullName: 'A', role: 'Electrician', baseRate: 50 } })
  const b = await prisma.opsCrewMember.create({ data: { workspaceId: workspace.id, employeeCode: 'E2', fullName: 'B', role: 'Apprentice', baseRate: 40 } })
  await seedShift(workspace.id, a.id, siteId, 300)
  await seedShift(workspace.id, b.id, siteId, 230)
  const openShift = await seedShift(workspace.id, b.id, siteId, 0, true)

  const live = await req(user.id, 'GET', `/jobs/${jobId}?workspaceId=${workspace.id}`)
  assert.equal(live.body.job.economics.actualHours, 530)
  assert.equal(live.body.job.economics.openShifts, 1)
  assert.equal(live.body.job.origin.type, 'COMMERCIAL_OPPORTUNITY')

  const refused = await req(user.id, 'POST', `/jobs/${jobId}/closeout`, { workspaceId: workspace.id, invoicedRevenueCents: 6_200_000, otherCostCents: 2_500_000 })
  assert.equal(refused.status, 409)
  await prisma.opsShiftRecord.delete({ where: { id: openShift.id } })

  const closed = await req(user.id, 'POST', `/jobs/${jobId}/closeout`, { workspaceId: workspace.id, invoicedRevenueCents: 6_200_000, otherCostCents: 2_500_000, onCostPct: 20 })
  assert.equal(closed.status, 200, JSON.stringify(closed.body))
  const e = closed.body.job.economics
  assert.equal(closed.body.job.status, 'COMPLETE')
  assert.equal(closed.body.job.economicsFrozen, true)
  assert.equal(closed.body.job.closeoutVersion, 1)
  assert.equal(e.labourCostCents, 2_904_000)
  assert.equal(e.marginBasis, 'GROSS')
  assert.equal(e.hoursVariancePct, 32.5)

  // Rule 8: today's rates never rewrite a closed job.
  await prisma.opsCrewMember.update({ where: { id: a.id }, data: { baseRate: 90 } })
  const after = await req(user.id, 'GET', `/jobs/${jobId}?workspaceId=${workspace.id}`)
  assert.equal(after.body.job.economics.labourCostCents, 2_904_000)
  assert.equal((await req(user.id, 'POST', `/jobs/${jobId}/closeout`, { workspaceId: workspace.id })).status, 409, 'already complete')

  assert.equal((await req(user.id, 'POST', `/jobs/${jobId}/reopen`, { workspaceId: workspace.id, reason: '' })).status, 400)
  const reopened = await req(user.id, 'POST', `/jobs/${jobId}/reopen`, { workspaceId: workspace.id, reason: 'Late variation invoice' })
  assert.equal(reopened.status, 200, JSON.stringify(reopened.body))
  assert.equal(reopened.body.job.economicsFrozen, false)
  const audit = await prisma.auditEvent.findFirst({ where: { type: 'job.reopened' } })
  assert.equal((audit!.metadata as { previousCloseout: { labourCostCents: number } }).previousCloseout.labourCostCents, 2_904_000)

  const again = await req(user.id, 'POST', `/jobs/${jobId}/closeout`, { workspaceId: workspace.id })
  assert.equal(again.status, 200)
  assert.equal(again.body.job.closeoutVersion, 2)
  assert.equal(again.body.job.economics.revenueCents, 6_200_000, 'absent fields keep what was recorded')
  assert.equal(again.body.job.economics.onCostPct, 0)
  assert.equal(again.body.job.economics.labourCostCents, 300 * 9000 + 230 * 4000, 'a new closeout uses the rates current at that closeout')
})

test('closeout with unknowns: no rate and no other costs means unknown, never zero', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const opp = await seedOpportunity(workspace.id)
  const quoteId = await acceptedQuote(user.id, workspace.id, { opportunityId: opp.id })
  const made = await req(user.id, 'POST', `/quotes/${quoteId}/job`, { workspaceId: workspace.id })
  const crew = await prisma.opsCrewMember.create({ data: { workspaceId: workspace.id, employeeCode: 'E9', fullName: 'C', role: 'Labourer' } })
  await seedShift(workspace.id, crew.id, made.body.job.opsJobSiteId, 8)
  const closed = await req(user.id, 'POST', `/jobs/${made.body.job.id}/closeout`, { workspaceId: workspace.id, invoicedRevenueCents: 100_000 })
  assert.equal(closed.status, 200)
  const e = closed.body.job.economics
  assert.equal(e.labourCostCents, null)
  assert.equal(e.otherCostCents, null)
  assert.equal(e.marginBasis, 'UNKNOWN')
  assert.ok(e.gaps.length >= 2)
})

test('migration constraints: one opportunity per quote, non-negative money', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const opp = await seedOpportunity(workspace.id)
  const co = await seedCommercialOpportunity(workspace.id)
  await assert.rejects(prisma.quote.create({ data: { workspaceId: workspace.id, opportunityId: opp.id, commercialOpportunityId: co.id, amountCents: 1 } }))
  await assert.rejects(prisma.quote.create({ data: { workspaceId: workspace.id, opportunityId: opp.id, amountCents: -5 } }))
  // A quote outlives its opportunity as economic history.
  const q = await prisma.quote.create({ data: { workspaceId: workspace.id, opportunityId: opp.id, amountCents: 10 } })
  await prisma.opportunity.delete({ where: { id: opp.id } })
  assert.equal((await prisma.quote.findUnique({ where: { id: q.id } }))!.opportunityId, null)
})
