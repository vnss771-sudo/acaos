// /api/billing checkout + status authorization and guard paths (the webhook is
// covered in routes-billing-webhook.test.ts). These exercise every branch that
// runs before the Stripe network call.

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { billingRouter } from '../apps/api/src/routes/billing.ts'
import {
  createFakePrisma, installPrisma, resetPrisma, startTestServer, bearer,
  type FakePrisma, type TestServer,
} from './helpers/integration.ts'

const OWNER = 'owner1'
const MEMBER = 'member1'
const WS = 'ws1'

// owner/admin gate for billing
function billingMember(a: any) {
  const { userId, workspaceId, role } = a?.where ?? {}
  if (workspaceId !== WS) return null
  if (role?.in) return userId === OWNER ? { id: 'm' } : null // owner/admin-only query
  return userId === OWNER ? { id: 'm' } : { id: 'm' }
}

function spec(ws: any = { id: WS, subscriptionStatus: null, stripeCustomerId: null, plan: 'free', stripeSubscriptionId: null }) {
  return {
    user: { findUnique: async (a: any) => ({ id: a?.where?.id, email: 'x@a.test', name: null }) },
    membership: { findFirst: async (a: any) => billingMember(a) },
    workspace: { findUnique: async () => ws },
  }
}

let prisma: FakePrisma
let server: TestServer
function boot(s = spec()) { prisma = createFakePrisma(s); installPrisma(prisma) }
beforeEach(async () => { boot(); server = await startTestServer('/api/billing', billingRouter) })
afterEach(async () => { await server.close(); resetPrisma() })

const post = (path: string, u: string, b: unknown) => server.request(path, {
  method: 'POST', headers: { Authorization: bearer(u), 'Content-Type': 'application/json' }, body: JSON.stringify(b),
})

test('checkout requires a workspaceId', async () => {
  assert.equal((await post('/api/billing/checkout', OWNER, {})).status, 400)
})

test('checkout denies a non-owner/admin', async () => {
  assert.equal((await post('/api/billing/checkout', MEMBER, { workspaceId: WS })).status, 403)
})

test('checkout 409s when the workspace already has an active subscription', async () => {
  boot(spec({ id: WS, subscriptionStatus: 'active', stripeCustomerId: 'cus_1' }))
  const res = await post('/api/billing/checkout', OWNER, { workspaceId: WS })
  assert.equal(res.status, 409)
})

test('checkout 404s when the workspace is missing', async () => {
  boot(spec(null))
  const res = await post('/api/billing/checkout', OWNER, { workspaceId: WS })
  assert.equal(res.status, 404)
})

test('status denies a non-owner/admin', async () => {
  const res = await server.request(`/api/billing/status?workspaceId=${WS}`, { headers: { Authorization: bearer(MEMBER) } })
  assert.equal(res.status, 403)
})

test('status returns plan and subscription state for an owner', async () => {
  boot(spec({ plan: 'starter', subscriptionStatus: 'active', stripeSubscriptionId: 'sub_1' }))
  const res = await server.request(`/api/billing/status?workspaceId=${WS}`, { headers: { Authorization: bearer(OWNER) } })
  assert.equal(res.status, 200)
  assert.equal(res.body.plan, 'starter')
  assert.equal(res.body.hasSubscription, true)
})
