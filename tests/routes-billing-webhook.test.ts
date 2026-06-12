// Integration tests for the Stripe webhook handler in /api/billing.
//
// Money-critical path: a forged or unsigned event must be rejected, and valid
// subscription lifecycle events must move the workspace through the correct
// plan / status transitions. Signatures are produced with Stripe's own test
// header generator, so the real signature verification is exercised — not
// stubbed.

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import Stripe from 'stripe'
import { billingRouter } from '../apps/api/src/routes/billing.ts'
import {
  createFakePrisma,
  installPrisma,
  resetPrisma,
  startTestServer,
  type FakePrisma,
  type TestServer,
} from './helpers/integration.ts'

const WEBHOOK_SECRET = 'whsec_test_secret'
const GROWTH_PRICE = 'price_growth_123'
const STARTER_PRICE = 'price_starter_123'

function setEnv() {
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy'
  process.env.WEB_URL = 'http://localhost:5173'
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET
  process.env.STRIPE_PRICE_GROWTH = GROWTH_PRICE
  process.env.STRIPE_PRICE_STARTER = STARTER_PRICE
}

function baseSpec() {
  return {
    workspace: {
      update: async (args: any) => ({ id: args?.where?.id }),
      findFirst: async (args: any) =>
        args?.where?.stripeSubscriptionId === 'sub_known' ? { id: 'ws1' } : null,
    },
  }
}

let prisma: FakePrisma
let server: TestServer

function signedBody(event: object): { body: string; signature: string } {
  const body = JSON.stringify(event)
  const signature = Stripe.webhooks.generateTestHeaderString({
    payload: body,
    secret: WEBHOOK_SECRET,
  })
  return { body, signature }
}

async function postWebhook(event: object, opts: { badSig?: boolean } = {}) {
  const { body, signature } = signedBody(event)
  return server.request('/api/billing/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'stripe-signature': opts.badSig ? 't=1,v1=deadbeef' : signature,
    },
    body,
  })
}

beforeEach(async () => {
  setEnv()
  prisma = createFakePrisma(baseSpec())
  installPrisma(prisma)
  server = await startTestServer('/api/billing', billingRouter, {
    configure: (app: express.Express) => {
      // Webhook needs the raw body, exactly as wired in server.ts.
      app.use('/api/billing/webhook', express.raw({ type: 'application/json', limit: '1mb' }))
    },
  })
})

afterEach(async () => {
  await server.close()
  resetPrisma()
})

test('rejects a request with no stripe-signature header', async () => {
  const res = await server.request('/api/billing/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'checkout.session.completed' }),
  })
  assert.equal(res.status, 400)
  assert.equal(prisma.callsTo('workspace', 'update').length, 0)
})

test('rejects a forged signature and never touches the database', async () => {
  const res = await postWebhook(
    { type: 'checkout.session.completed', data: { object: {} } },
    { badSig: true }
  )
  assert.equal(res.status, 400)
  assert.equal(prisma.callsTo('workspace', 'update').length, 0)
})

test('checkout.session.completed activates the workspace with the resolved plan', async () => {
  const res = await postWebhook({
    type: 'checkout.session.completed',
    data: {
      object: {
        customer: 'cus_1',
        subscription: 'sub_1',
        metadata: { workspaceId: 'ws1', priceId: GROWTH_PRICE },
      },
    },
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.received, true)
  const updates = prisma.callsTo('workspace', 'update')
  assert.equal(updates.length, 1)
  const data = (updates[0].args[0] as any).data
  assert.equal(data.subscriptionStatus, 'active')
  assert.equal(data.plan, 'growth')
})

test('checkout.session.completed without a workspaceId is a no-op', async () => {
  const res = await postWebhook({
    type: 'checkout.session.completed',
    data: { object: { customer: 'cus_1', metadata: {} } },
  })
  assert.equal(res.status, 200)
  assert.equal(prisma.callsTo('workspace', 'update').length, 0)
})

test('customer.subscription.deleted downgrades the workspace to free', async () => {
  const res = await postWebhook({
    type: 'customer.subscription.deleted',
    data: { object: { id: 'sub_known', status: 'canceled' } },
  })
  assert.equal(res.status, 200)
  const updates = prisma.callsTo('workspace', 'update')
  assert.equal(updates.length, 1)
  const data = (updates[0].args[0] as any).data
  assert.equal(data.plan, 'free')
  assert.equal(data.subscriptionStatus, 'canceled')
  assert.equal(data.stripeSubscriptionId, null)
})

test('invoice.payment_failed marks the workspace past_due', async () => {
  const res = await postWebhook({
    type: 'invoice.payment_failed',
    data: { object: { subscription: 'sub_known' } },
  })
  assert.equal(res.status, 200)
  const updates = prisma.callsTo('workspace', 'update')
  assert.equal(updates.length, 1)
  assert.equal((updates[0].args[0] as any).data.subscriptionStatus, 'past_due')
})

test('an event for an unknown subscription is acknowledged without a write', async () => {
  const res = await postWebhook({
    type: 'customer.subscription.deleted',
    data: { object: { id: 'sub_unknown', status: 'canceled' } },
  })
  assert.equal(res.status, 200)
  assert.equal(prisma.callsTo('workspace', 'update').length, 0)
})

test('an unhandled event type is acknowledged as a no-op', async () => {
  const res = await postWebhook({
    type: 'customer.created',
    data: { object: { id: 'cus_9' } },
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.received, true)
  assert.equal(prisma.callsTo('workspace', 'update').length, 0)
})
