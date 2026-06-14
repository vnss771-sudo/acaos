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

function baseSpec(workspaceRow: any = { id: 'ws1' }) {
  // Tracks processed event ids so re-deliveries are recognized, mirroring the
  // unique-constraint on ProcessedStripeEvent.
  const seen = new Set<string>()
  return {
    processedStripeEvent: {
      create: async (a: any) => {
        const id = String(a?.data?.id)
        if (seen.has(id)) throw new Error('duplicate event')
        seen.add(id)
        return { id }
      },
      delete: async (a: any) => { seen.delete(String(a?.where?.id)); return {} },
    },
    workspace: {
      update: async (args: any) => ({ id: args?.where?.id }),
      findFirst: async (args: any) =>
        args?.where?.stripeSubscriptionId === 'sub_known' ? workspaceRow : null,
    },
    membership: {
      findFirst: async (_args: any) => ({ id: 'mem1', user: { email: 'owner@test.com' } }),
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

let eventSeq = 0
async function postWebhook(event: Record<string, any>, opts: { badSig?: boolean } = {}) {
  // Stripe events always carry an id; default a unique one so each delivery is
  // treated as new unless a test deliberately reuses an id.
  const withId = { id: event.id ?? `evt_${++eventSeq}`, ...event }
  const { body, signature } = signedBody(withId)
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

// --- idempotency (BILL-1) ---

test('a re-delivered event (same id) is processed only once', async () => {
  const event = {
    id: 'evt_dup_1',
    type: 'checkout.session.completed',
    data: { object: { customer: 'cus_1', subscription: 'sub_1', metadata: { workspaceId: 'ws1', priceId: GROWTH_PRICE } } },
  }
  const first = await postWebhook(event)
  assert.equal(first.status, 200)
  assert.equal(first.body.duplicate, undefined)

  const second = await postWebhook(event) // same id
  assert.equal(second.status, 200)
  assert.equal(second.body.duplicate, true)

  // The side effect ran exactly once despite two deliveries.
  assert.equal(prisma.callsTo('workspace', 'update').length, 1)
})

// --- plan-downgrade safety (BILL-2) ---

test('subscription.updated with an unrecognized price does NOT change the plan', async () => {
  const res = await postWebhook({
    type: 'customer.subscription.updated',
    data: { object: { id: 'sub_known', status: 'active', customer: 'cus_1', items: { data: [{ price: { id: 'price_unrecognized' } }] } } },
  })
  assert.equal(res.status, 200)
  const data = (prisma.callsTo('workspace', 'update')[0].args[0] as any).data
  assert.equal(data.subscriptionStatus, 'active')
  assert.equal('plan' in data, false, 'plan must be preserved, not downgraded')
})

test('subscription.updated with a known price still sets that plan', async () => {
  const res = await postWebhook({
    type: 'customer.subscription.updated',
    data: { object: { id: 'sub_known', status: 'active', customer: 'cus_1', items: { data: [{ price: { id: GROWTH_PRICE } }] } } },
  })
  assert.equal(res.status, 200)
  const data = (prisma.callsTo('workspace', 'update')[0].args[0] as any).data
  assert.equal(data.plan, 'growth')
})

test('checkout with an unrecognized price activates WITHOUT granting a tier (no default to starter)', async () => {
  const res = await postWebhook({
    type: 'checkout.session.completed',
    data: { object: { customer: 'cus_1', subscription: 'sub_1', metadata: { workspaceId: 'ws1', priceId: 'price_unrecognized' } } },
  })
  assert.equal(res.status, 200)
  const data = (prisma.callsTo('workspace', 'update')[0].args[0] as any).data
  assert.equal(data.subscriptionStatus, 'active')
  assert.equal('plan' in data, false, 'an unrecognized price must not be guessed into a plan')
})

test('checkout.session.completed honors the server-set plan in metadata', async () => {
  const res = await postWebhook({
    type: 'checkout.session.completed',
    data: { object: { customer: 'cus_1', subscription: 'sub_1', metadata: { workspaceId: 'ws1', plan: 'growth' } } },
  })
  assert.equal(res.status, 200)
  const data = (prisma.callsTo('workspace', 'update')[0].args[0] as any).data
  assert.equal(data.subscriptionStatus, 'active')
  assert.equal(data.plan, 'growth')
})

test('checkout.session.completed rejects a forged plan in metadata (not a known tier)', async () => {
  const res = await postWebhook({
    type: 'checkout.session.completed',
    data: { object: { customer: 'cus_1', subscription: 'sub_1', metadata: { workspaceId: 'ws1', plan: 'enterprise' } } },
  })
  assert.equal(res.status, 200)
  const data = (prisma.callsTo('workspace', 'update')[0].args[0] as any).data
  assert.equal('plan' in data, false, 'an unknown plan string must not be applied')
})
