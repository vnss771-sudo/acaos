// Stripe failures at checkout and in the billing portal must reach the user as
// a plain 503, not a bare 500 "Internal server error". In production a rejected
// secret key made every Upgrade click fail that way.

import test from 'node:test'
import assert from 'node:assert/strict'
import { callStripe } from '../apps/api/src/services/stripe.ts'
import { ApiError } from '../apps/api/src/lib/http.ts'

test('a Stripe failure becomes a 503 with a plain message', async () => {
  const stripeError = Object.assign(new Error('Invalid API Key provided: sk_live_***'), { type: 'StripeAuthenticationError' })
  await assert.rejects(
    () => callStripe('checkout', async () => { throw stripeError }),
    (err: unknown) => err instanceof ApiError
      && err.statusCode === 503
      && /Billing is temporarily unavailable/.test(err.message)
      && !err.message.includes('sk_live'),
  )
})

test('an ApiError raised inside the call passes through unchanged', async () => {
  await assert.rejects(
    () => callStripe('checkout', async () => { throw new ApiError(502, 'Stripe checkout URL unavailable') }),
    (err: unknown) => err instanceof ApiError && err.statusCode === 502,
  )
})

test('a successful call returns its result', async () => {
  const session = await callStripe('checkout', async () => ({ url: 'https://checkout.stripe.test/s' }))
  assert.deepEqual(session, { url: 'https://checkout.stripe.test/s' })
})
