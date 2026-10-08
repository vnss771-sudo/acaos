import { test, expect, type APIRequestContext } from '@playwright/test'
import Stripe from 'stripe'
import { recoverStaleSends } from '../packages/backend-core/src/lib/staleSends.ts'
import {
  createApiAccount, closeDb, seedDeliveryOpportunity, seedCrewMember, seedShift,
  closeShift, readJob, seedStaleAndFreshSends, readOutreachSend,
} from './helpers.js'

const STRIPE_WEBHOOK_SECRET = 'whsec_e2e_local_secret'

test.afterAll(closeDb)

function auth(token: string) { return { Authorization: `Bearer ${token}` } }

async function postStripeEvent(request: APIRequestContext, event: Record<string, unknown>) {
  const body = JSON.stringify(event)
  const signature = Stripe.webhooks.generateTestHeaderString({ payload: body, secret: STRIPE_WEBHOOK_SECRET })
  return request.post('/api/billing/webhook', {
    headers: { 'content-type': 'application/json', 'stripe-signature': signature },
    data: body,
  })
}

test('Stripe webhook is idempotent: the first signed delivery applies and replay is acknowledged without reapplying', async ({ request }) => {
  const a = await createApiAccount(request)
  const eventId = `evt_e2e_${Date.now()}`
  const event = {
    id: eventId,
    object: 'event',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: `cs_e2e_${Date.now()}`,
        customer: 'cus_e2e',
        subscription: 'sub_e2e',
        metadata: { workspaceId: a.workspaceId, plan: 'growth', priceId: 'price_e2e_growth' },
      },
    },
  }

  const first = await postStripeEvent(request, event)
  expect(first.ok(), await first.text()).toBeTruthy()
  expect((await first.json()).duplicate).not.toBe(true)

  const status1 = await request.get(`/api/billing/status?workspaceId=${a.workspaceId}`, { headers: auth(a.token) })
  expect(status1.ok(), await status1.text()).toBeTruthy()
  const before = await status1.json()
  expect(before.plan).toBe('growth')
  expect(before.status).toBe('active')
  expect(before.hasSubscription).toBe(true)

  const replay = await postStripeEvent(request, event)
  expect(replay.ok(), await replay.text()).toBeTruthy()
  expect((await replay.json()).duplicate).toBe(true)

  const status2 = await request.get(`/api/billing/status?workspaceId=${a.workspaceId}`, { headers: auth(a.token) })
  expect(status2.ok()).toBeTruthy()
  expect(await status2.json()).toMatchObject({ plan: 'growth', status: 'active', hasSubscription: true })
})

test('accepted quote becomes a delivery job through the real API and cannot create a duplicate job', async ({ request }) => {
  const a = await createApiAccount(request)
  const headers = auth(a.token)
  const opportunityId = await seedDeliveryOpportunity(a.workspaceId)

  const quoteRes = await request.post('/api/delivery/quotes', {
    headers,
    data: { workspaceId: a.workspaceId, opportunityId, amountCents: 125_000_00, estimatedHours: 120, submit: true },
  })
  expect(quoteRes.status(), await quoteRes.text()).toBe(201)
  const quoteId = (await quoteRes.json()).quote.id as string

  const accepted = await request.patch(`/api/delivery/quotes/${quoteId}/status`, {
    headers,
    data: { workspaceId: a.workspaceId, status: 'ACCEPTED' },
  })
  expect(accepted.ok(), await accepted.text()).toBeTruthy()

  const created = await request.post(`/api/delivery/quotes/${quoteId}/job`, {
    headers,
    data: { workspaceId: a.workspaceId, jobCode: `E2E-${Date.now()}` },
  })
  expect(created.status(), await created.text()).toBe(201)
  const job = (await created.json()).job as { id: string; opsJobSiteId: string; quoteId: string }
  expect(job.quoteId).toBe(quoteId)

  const duplicate = await request.post(`/api/delivery/quotes/${quoteId}/job`, {
    headers,
    data: { workspaceId: a.workspaceId, jobCode: `E2E-DUP-${Date.now()}` },
  })
  expect(duplicate.status()).toBe(409)
  expect(await duplicate.text()).toContain('already exists')
})

test('job closeout refuses open shifts, preserves unknown costs, freezes economics, and reopen is explicit', async ({ request }) => {
  const a = await createApiAccount(request)
  const headers = auth(a.token)
  const opportunityId = await seedDeliveryOpportunity(a.workspaceId)
  const quoteRes = await request.post('/api/delivery/quotes', {
    headers,
    data: { workspaceId: a.workspaceId, opportunityId, amountCents: 80_000_00, estimatedHours: 80, submit: true },
  })
  const quoteId = (await quoteRes.json()).quote.id as string
  expect((await request.patch(`/api/delivery/quotes/${quoteId}/status`, { headers, data: { workspaceId: a.workspaceId, status: 'ACCEPTED' } })).ok()).toBeTruthy()
  const jobRes = await request.post(`/api/delivery/quotes/${quoteId}/job`, { headers, data: { workspaceId: a.workspaceId, jobCode: `E2E-CLOSE-${Date.now()}` } })
  expect(jobRes.status(), await jobRes.text()).toBe(201)
  const created = (await jobRes.json()).job as { id: string; opsJobSiteId: string }

  const crewId = await seedCrewMember(a.workspaceId, 60)
  const shiftId = await seedShift({ workspaceId: a.workspaceId, crewMemberId: crewId, jobSiteId: created.opsJobSiteId, open: true })

  const blocked = await request.post(`/api/delivery/jobs/${created.id}/closeout`, {
    headers,
    data: { workspaceId: a.workspaceId, invoicedRevenueCents: 82_000_00 },
  })
  expect(blocked.status()).toBe(409)
  expect(await blocked.text()).toContain('still open')

  await closeShift(shiftId, 8)
  const closed = await request.post(`/api/delivery/jobs/${created.id}/closeout`, {
    headers,
    data: { workspaceId: a.workspaceId, invoicedRevenueCents: 82_000_00, otherCostCents: null },
  })
  expect(closed.ok(), await closed.text()).toBeTruthy()
  const closedJob = await readJob(created.id)
  expect(closedJob?.status).toBe('COMPLETE')
  expect(closedJob?.otherCostCents).toBeNull()
  expect(closedJob?.closeout).not.toBeNull()
  const frozen = JSON.stringify(closedJob?.closeout)
  expect(closedJob?.closeoutVersion).toBe(1)

  // A late shift must not silently rewrite historical closeout economics.
  await seedShift({ workspaceId: a.workspaceId, crewMemberId: crewId, jobSiteId: created.opsJobSiteId, totalHours: 4 })
  expect(JSON.stringify((await readJob(created.id))?.closeout)).toBe(frozen)

  const reopened = await request.post(`/api/delivery/jobs/${created.id}/reopen`, {
    headers,
    data: { workspaceId: a.workspaceId, reason: 'Late timesheet received' },
  })
  expect(reopened.ok(), await reopened.text()).toBeTruthy()
  const reopenedJob = await readJob(created.id)
  expect(reopenedJob?.status).toBe('ACTIVE')
  expect(reopenedJob?.closeout).toBeNull()
  expect(reopenedJob?.closeoutVersion).toBe(1)

  const reclosed = await request.post(`/api/delivery/jobs/${created.id}/closeout`, {
    headers,
    data: { workspaceId: a.workspaceId, invoicedRevenueCents: 82_000_00, otherCostCents: null },
  })
  expect(reclosed.ok(), await reclosed.text()).toBeTruthy()
  expect((await readJob(created.id))?.closeoutVersion).toBe(2)
})

test('stale SENDING recovery fails closed and never reclaims a recent in-flight send', async ({ request }) => {
  const a = await createApiAccount(request)
  const { staleId, freshId } = await seedStaleAndFreshSends(a.workspaceId)

  const recovered = await recoverStaleSends(new Date())
  expect(recovered).toBeGreaterThanOrEqual(1)

  const stale = await readOutreachSend(staleId)
  const fresh = await readOutreachSend(freshId)
  expect(stale?.status).toBe('FAILED')
  expect(stale?.lastError).toContain('stale SENDING reclaimed')
  expect(fresh?.status).toBe('SENDING')
})
