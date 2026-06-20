// Database-backed test for Stripe webhook idempotency (BILL-1) against a REAL
// Postgres. The fake-Prisma unit test in tests/routes-billing-webhook.test.ts
// models dedup with an in-memory Set, which cannot prove the actual behaviour
// the handler relies on: the unique PK on ProcessedStripeEvent.id is what makes
// a duplicate delivery a no-op, and deleting that row on a processing failure is
// what lets Stripe's redelivery be reprocessed.
//
// This drives the route end-to-end (approach "a"): a real HTTP server mounts the
// billing router, payloads are signed with Stripe's own test header generator so
// the genuine signature verification runs, and assertions read the live DB. The
// route and these helpers share the same Prisma singleton via
// globalThis.__acaosPrisma__, so the writes the handler makes are visible here.

import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import Stripe from 'stripe'
import { billingRouter } from '../apps/api/src/routes/billing.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace, startTestServer, type TestServer } from './helpers/db.ts'

const WEBHOOK_SECRET = 'whsec_test_secret'
const GROWTH_PRICE = 'price_growth_db_123'

function setEnv() {
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy'
  process.env.WEB_URL = 'http://localhost:5173'
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET
  process.env.STRIPE_PRICE_GROWTH = GROWTH_PRICE
}

let server: TestServer

function signedBody(event: object): { body: string; signature: string } {
  const body = JSON.stringify(event)
  const signature = Stripe.webhooks.generateTestHeaderString({ payload: body, secret: WEBHOOK_SECRET })
  return { body, signature }
}

async function postWebhook(event: Record<string, unknown>) {
  const { body, signature } = signedBody(event)
  return server.request('/api/billing/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': signature },
    body,
  })
}

function checkoutEvent(id: string, workspaceId: string) {
  return {
    id,
    type: 'checkout.session.completed',
    data: {
      object: {
        customer: 'cus_db_1',
        subscription: 'sub_db_1',
        metadata: { workspaceId, priceId: GROWTH_PRICE },
      },
    },
  }
}

before(async () => {
  setEnv()
  server = await startTestServer('/api/billing', billingRouter, {
    configure: (app: express.Express) => {
      // Webhook needs the raw body, exactly as wired in server.ts.
      app.use('/api/billing/webhook', express.raw({ type: 'application/json', limit: '1mb' }))
    },
  })
})

after(async () => {
  await server.close()
  await disconnect()
})

beforeEach(async () => {
  setEnv()
  await resetDb()
})

test('a first valid delivery is processed and recorded in processedStripeEvent', async () => {
  const { workspace } = await seedUserWithWorkspace()

  const res = await postWebhook(checkoutEvent('evt_db_first', workspace.id))
  assert.equal(res.status, 200)
  assert.equal(res.body.received, true)
  assert.equal(res.body.duplicate, undefined)

  // The claim row exists in the REAL table.
  const claim = await prisma.processedStripeEvent.findUnique({ where: { id: 'evt_db_first' } })
  assert.ok(claim, 'event id must be recorded')
  assert.equal(claim!.type, 'checkout.session.completed')

  // The side effect ran: the workspace was activated on the growth plan.
  const ws = await prisma.workspace.findUnique({ where: { id: workspace.id } })
  assert.equal(ws!.subscriptionStatus, 'active')
  assert.equal(ws!.plan, 'growth')
})

test('a duplicate delivery of the same event id is acknowledged and does NOT reprocess', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const event = checkoutEvent('evt_db_dup', workspace.id)

  const first = await postWebhook(event)
  assert.equal(first.status, 200)
  assert.equal(first.body.duplicate, undefined)

  // Mutate the workspace AFTER the first delivery; if the duplicate reprocessed,
  // it would overwrite this back to active/growth, so the change proves a no-op.
  await prisma.workspace.update({ where: { id: workspace.id }, data: { subscriptionStatus: 'canceled', plan: 'free' } })

  const second = await postWebhook(event) // identical id — the real unique PK rejects the second claim
  assert.equal(second.status, 200)
  assert.equal(second.body.duplicate, true)

  // Exactly one claim row, and the post-first mutation is intact (not reprocessed).
  assert.equal(await prisma.processedStripeEvent.count({ where: { id: 'evt_db_dup' } }), 1)
  const ws = await prisma.workspace.findUnique({ where: { id: workspace.id } })
  assert.equal(ws!.subscriptionStatus, 'canceled')
  assert.equal(ws!.plan, 'free')
})

test('the real unique PK rejects a second claim for the same event id', async () => {
  // Directly exercises the constraint the handler depends on, independent of HTTP.
  await prisma.processedStripeEvent.create({ data: { id: 'evt_db_pk', type: 'checkout.session.completed' } })
  await assert.rejects(
    () => prisma.processedStripeEvent.create({ data: { id: 'evt_db_pk', type: 'checkout.session.completed' } }),
    (err: { code?: string }) => err.code === 'P2002',
  )
})

test('a processing failure releases the claim so a later redelivery is reprocessed', async () => {
  // Simulate a clean processing failure: a checkout event whose workspaceId does
  // not exist makes handleWebhookEvent's prisma.workspace.update throw (P2025).
  // The handler must DELETE the just-created claim so the next delivery is not
  // skipped as a duplicate.
  const failing = checkoutEvent('evt_db_release', 'ws-does-not-exist')

  const first = await postWebhook(failing)
  assert.equal(first.status, 500, 'a processing failure surfaces as an error response')

  // Claim was released — the table is empty for this id.
  assert.equal(
    await prisma.processedStripeEvent.count({ where: { id: 'evt_db_release' } }),
    0,
    'the claim must be deleted when processing fails',
  )

  // A redelivery of the SAME id now succeeds against an existing workspace,
  // proving the failure did not permanently swallow the event.
  const { workspace } = await seedUserWithWorkspace()
  const retry = await postWebhook(checkoutEvent('evt_db_release', workspace.id))
  assert.equal(retry.status, 200)
  assert.equal(retry.body.received, true)
  assert.equal(retry.body.duplicate, undefined, 'redelivery after a release must reprocess, not dedup')

  const ws = await prisma.workspace.findUnique({ where: { id: workspace.id } })
  assert.equal(ws!.subscriptionStatus, 'active')
  assert.equal(await prisma.processedStripeEvent.count({ where: { id: 'evt_db_release' } }), 1)
})
