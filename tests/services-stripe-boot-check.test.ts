// Boot-time Stripe price check (item 7): assertStripePricesConfigured() must
// never throw and must not attempt any Stripe API call when Stripe isn't
// configured at all — that's a legitimate deploy state (e.g. local dev), not
// an error. The "configured but broken" path calls the real Stripe network
// API and is exercised manually/in a keyed environment, not here.

import test from 'node:test'
import assert from 'node:assert/strict'

test('assertStripePricesConfigured resolves quietly when STRIPE_SECRET_KEY is unset', async () => {
  const original = process.env.STRIPE_SECRET_KEY
  delete process.env.STRIPE_SECRET_KEY
  try {
    const { assertStripePricesConfigured } = await import('../apps/api/src/services/stripe.ts')
    await assert.doesNotReject(() => assertStripePricesConfigured())
  } finally {
    if (original !== undefined) process.env.STRIPE_SECRET_KEY = original
  }
})

test('assertStripePricesConfigured resolves quietly when Stripe is configured but no price ids are set', async () => {
  const originalKey = process.env.STRIPE_SECRET_KEY
  const originalStarter = process.env.STRIPE_PRICE_STARTER
  const originalGrowth = process.env.STRIPE_PRICE_GROWTH
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake_for_boot_check_test'
  delete process.env.STRIPE_PRICE_STARTER
  delete process.env.STRIPE_PRICE_GROWTH
  try {
    const { assertStripePricesConfigured } = await import('../apps/api/src/services/stripe.ts')
    // No price ids configured -> nothing to retrieve -> no network call, no throw.
    await assert.doesNotReject(() => assertStripePricesConfigured())
  } finally {
    if (originalKey !== undefined) process.env.STRIPE_SECRET_KEY = originalKey; else delete process.env.STRIPE_SECRET_KEY
    if (originalStarter !== undefined) process.env.STRIPE_PRICE_STARTER = originalStarter
    if (originalGrowth !== undefined) process.env.STRIPE_PRICE_GROWTH = originalGrowth
  }
})
