// Job variations (UQ-35), against a real database: scope changes beside the
// accepted quote (never over it), an audited DRAFT → SUBMITTED → APPROVED |
// REJECTED lifecycle, and only APPROVED variations adjusting the contract.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { deliveryRouter } from '../apps/api/src/routes/delivery.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace, startTestServer, bearer, type TestServer } from './helpers/db.ts'

let server: TestServer
before(async () => { server = await startTestServer('/api/delivery', deliveryRouter) })
after(async () => { await server.close(); await disconnect() })
beforeEach(async () => { await resetDb() })

const req = (uid: string, method: string, path: string, body?: unknown) => server.request(`/api/delivery${path}`, {
  method, headers: { Authorization: bearer(uid), 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
})

async function jobWithQuote() {
  const { user, workspace } = await seedUserWithWorkspace()
  const ws = workspace.id
  const opp = await prisma.opportunity.create({
    data: { workspaceId: ws, source: 'planningalerts', externalId: 'DA-V1', kind: 'DEVELOPMENT_APPLICATION', title: 'Warehouse fit-out', score: 70, matchedTrades: ['electrical'], reasons: ['x'], contentHash: 'hv1', region: 'QLD', status: 'PURSUING' },
  })
  const quote = await req(user.id, 'POST', '/quotes', { workspaceId: ws, opportunityId: opp.id, amountCents: 6_000_000, estimatedHours: 400, submit: true })
  await req(user.id, 'PATCH', `/quotes/${quote.body.quote.id}/status`, { workspaceId: ws, status: 'ACCEPTED' })
  const job = await req(user.id, 'POST', `/quotes/${quote.body.quote.id}/job`, { workspaceId: ws, jobCode: 'WH-V' })
  assert.equal(job.status, 201, JSON.stringify(job.body))
  return { user, ws, jobId: job.body.job.id as string, quoteId: quote.body.quote.id as string }
}

test('approved variations adjust the contract; drafts, submissions and rejections do not; the quote never changes', async () => {
  const { user, ws, jobId, quoteId } = await jobWithQuote()
  const create = (body: Record<string, unknown>) => req(user.id, 'POST', `/jobs/${jobId}/variations`, { workspaceId: ws, ...body })
  const move = (id: string, status: string) => req(user.id, 'PATCH', `/variations/${id}/status`, { workspaceId: ws, status })

  const extra = await create({ title: 'Extra sub-board', revenueCents: 500_000, estimatedCostCents: 200_000, estimatedHours: 20, submit: true })
  assert.equal(extra.status, 201, JSON.stringify(extra.body))
  assert.equal(extra.body.variation.status, 'SUBMITTED')
  const reduction = await create({ title: 'Client supplies the fittings', revenueCents: -100_000 })
  assert.equal(reduction.body.variation.status, 'DRAFT')
  const rejected = await create({ title: 'Gold-plated switches', revenueCents: 900_000, submit: true })

  assert.equal((await move(reduction.body.variation.id, 'APPROVED')).status, 409, 'a draft must be submitted before approval')
  assert.equal((await move(extra.body.variation.id, 'APPROVED')).status, 200)
  assert.equal((await move(reduction.body.variation.id, 'SUBMITTED')).status, 200)
  assert.equal((await move(reduction.body.variation.id, 'APPROVED')).status, 200)
  assert.equal((await move(rejected.body.variation.id, 'REJECTED')).status, 200)
  assert.equal((await move(extra.body.variation.id, 'CANCELLED')).status, 409, 'an approved variation is history')

  const live = (await req(user.id, 'GET', `/jobs/${jobId}?workspaceId=${ws}`)).body.job
  assert.equal(live.economics.quotedCents, 6_000_000)
  assert.equal(live.economics.approvedVariations, 2)
  assert.equal(live.economics.adjustedQuotedCents, 6_400_000)
  assert.deepEqual(live.variations.map((v: { status: string }) => v.status), ['APPROVED', 'APPROVED', 'REJECTED'])

  const closed = await req(user.id, 'POST', `/jobs/${jobId}/closeout`, { workspaceId: ws, invoicedRevenueCents: 6_600_000, otherCostCents: 2_500_000 })
  assert.equal(closed.status, 200, JSON.stringify(closed.body))
  const e = closed.body.job.economics
  assert.equal(e.version, 2)
  assert.equal(e.revenueVsQuotePct, 10)
  assert.equal(e.revenueVsAdjustedQuotePct, 3.1)
  assert.equal(e.otherCostCents, 2_500_000, 'estimated variation cost never becomes actual cost')
  assert.equal((await prisma.quote.findUniqueOrThrow({ where: { id: quoteId } })).amountCents, 6_000_000, 'the accepted quote is never rewritten')

  const types = (await prisma.auditEvent.findMany({ where: { workspaceId: ws, entityType: 'jobVariation' }, select: { type: true } })).map(a => a.type)
  assert.equal(types.filter(t => t === 'job.variation.created').length, 3)
  assert.equal(types.filter(t => t === 'job.variation.status').length, 4)
})

test('a closed job takes no variation changes until reopened; other workspaces can\'t touch them', async () => {
  const { user, ws, jobId } = await jobWithQuote()
  const v = await req(user.id, 'POST', `/jobs/${jobId}/variations`, { workspaceId: ws, title: 'More cable', revenueCents: 50_000, submit: true })
  assert.equal((await req(user.id, 'POST', `/jobs/${jobId}/closeout`, { workspaceId: ws, invoicedRevenueCents: 6_000_000, otherCostCents: 0 })).status, 200)

  const late = await req(user.id, 'POST', `/jobs/${jobId}/variations`, { workspaceId: ws, title: 'Late change', revenueCents: 1 })
  assert.equal(late.status, 409)
  assert.match(late.body.error, /Reopen the job/)
  assert.equal((await req(user.id, 'PATCH', `/variations/${v.body.variation.id}/status`, { workspaceId: ws, status: 'APPROVED' })).status, 409)

  assert.equal((await req(user.id, 'POST', `/jobs/${jobId}/reopen`, { workspaceId: ws, reason: 'Variation to approve' })).status, 200)
  assert.equal((await req(user.id, 'PATCH', `/variations/${v.body.variation.id}/status`, { workspaceId: ws, status: 'APPROVED' })).status, 200)

  const other = await seedUserWithWorkspace('other@rival.test')
  assert.equal((await req(other.user.id, 'PATCH', `/variations/${v.body.variation.id}/status`, { workspaceId: other.workspace.id, status: 'CANCELLED' })).status, 404)
  assert.equal((await req(other.user.id, 'POST', `/jobs/${jobId}/variations`, { workspaceId: other.workspace.id, title: 'x' })).status, 404)
  assert.equal((await req(other.user.id, 'PATCH', `/variations/${v.body.variation.id}/status`, { workspaceId: ws, status: 'CANCELLED' })).status, 403)
})
