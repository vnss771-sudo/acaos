// Unit tests for services/stripe — the configuration and price-resolution
// guards. priceIdForPlan is a deliberate security boundary: the client never
// supplies a Stripe price id (that would let a user point checkout at an
// arbitrary price in the account), so the server resolves it from env per plan.
// We exercise the guard branches that don't require a live Stripe API: price
// resolution and every "not configured → 503" path.

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  priceIdForPlan, createCheckoutSession, createBillingPortalSession, constructWebhookEvent,
} from '../apps/api/src/services/stripe.ts'

const STRIPE_ENV = ['STRIPE_SECRET_KEY', 'STRIPE_PRICE_GROWTH', 'STRIPE_PRICE_STARTER', 'STRIPE_WEBHOOK_SECRET']
let saved: Record<string, string | undefined>
beforeEach(() => {
  saved = Object.fromEntries(STRIPE_ENV.map((k) => [k, process.env[k]]))
  for (const k of STRIPE_ENV) delete process.env[k]
})
afterEach(() => {
  for (const k of STRIPE_ENV) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

// Assert a thrown ApiError carries the expected HTTP status.
async function rejectsWithStatus(fn: () => unknown, status: number, match?: RegExp) {
  await assert.rejects(async () => { await fn() }, (err: any) => {
    assert.equal(err.statusCode, status, `expected statusCode ${status}, got ${err.statusCode}`)
    if (match) assert.match(err.message, match)
    return true
  })
}

// ── priceIdForPlan ───────────────────────────────────────────────────────────

test('priceIdForPlan resolves the growth and starter prices from env', () => {
  process.env.STRIPE_PRICE_GROWTH = 'price_growth'
  process.env.STRIPE_PRICE_STARTER = 'price_starter'
  assert.equal(priceIdForPlan('growth'), 'price_growth')
  assert.equal(priceIdForPlan('starter'), 'price_starter')
})

test('priceIdForPlan throws 503 when the plan has no configured price', () => {
  process.env.STRIPE_PRICE_GROWTH = 'price_growth'
  // starter price is unset → must not fall back to growth, must 503.
  assert.equal(priceIdForPlan('growth'), 'price_growth')
  assert.throws(() => priceIdForPlan('starter'), (err: any) => {
    assert.equal(err.statusCode, 503)
    assert.match(err.message, /starter/)
    return true
  })
})

// ── createCheckoutSession guards ─────────────────────────────────────────────

test('createCheckoutSession returns 503 when Stripe is not configured', async () => {
  // No STRIPE_SECRET_KEY → getStripe() fails before any network call.
  await rejectsWithStatus(() => createCheckoutSession('ws1', 'growth'), 503, /not configured/)
})

test('createCheckoutSession returns 503 when the key is set but the price is not', async () => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_x'
  // Key present, STRIPE_PRICE_GROWTH absent → priceIdForPlan trips.
  await rejectsWithStatus(() => createCheckoutSession('ws1', 'growth'), 503, /price/i)
})

// ── billing portal + webhook guards ──────────────────────────────────────────

test('createBillingPortalSession returns 503 when Stripe is not configured', async () => {
  await rejectsWithStatus(() => createBillingPortalSession('cus_123'), 503, /not configured/)
})

test('constructWebhookEvent returns 503 when STRIPE_WEBHOOK_SECRET is missing', async () => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_x' // key present, webhook secret absent
  await rejectsWithStatus(
    () => constructWebhookEvent(Buffer.from('{}'), 'sig'),
    503,
    /STRIPE_WEBHOOK_SECRET/,
  )
})
