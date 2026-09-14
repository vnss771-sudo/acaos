import Stripe from 'stripe'
import { ApiError } from '../lib/http.js'
import { hasEnv } from '@acaos/backend-core/lib/env.js'
import { stripeBreaker } from '@acaos/backend-core/lib/circuit.js'
import { logger } from '@acaos/backend-core/lib/logger.js'
import type { BillingPlan } from '@acaos/shared'

function getStripe() {
  if (!hasEnv(['STRIPE_SECRET_KEY'])) {
    throw new ApiError(503, 'Stripe is not configured')
  }
  return new Stripe(process.env.STRIPE_SECRET_KEY as string, {
    apiVersion: '2024-06-20',
    timeout: Number(process.env.STRIPE_TIMEOUT_MS || 20_000),
    maxNetworkRetries: 2,
  })
}

// Paid plans eligible for Stripe checkout (the `free` tier is never purchased).
export type CheckoutPlan = Exclude<BillingPlan, 'free'>

// Resolve the Stripe price id for a plan from server-side config only. The
// client never supplies a price id directly (it would let a user point checkout
// at an arbitrary price in the account).
export function priceIdForPlan(plan: CheckoutPlan): string {
  const id = plan === 'growth' ? process.env.STRIPE_PRICE_GROWTH : process.env.STRIPE_PRICE_STARTER
  if (!id) throw new ApiError(503, `No Stripe price configured for the ${plan} plan`)
  return id
}

export async function createCheckoutSession(
  workspaceId: string,
  plan: CheckoutPlan,
  customerEmail?: string,
  existingCustomerId?: string
) {
  const stripe = getStripe()
  const selectedPrice = priceIdForPlan(plan)

  const webBase = process.env.WEB_URL || process.env.API_URL || 'https://acaos.app'
  const sessionParams: Stripe.Checkout.SessionCreateParams = {
    mode: 'subscription',
    client_reference_id: workspaceId,
    line_items: [{ price: selectedPrice, quantity: 1 }],
    success_url: `${webBase}/billing/success?workspaceId=${workspaceId}`,
    cancel_url: `${webBase}/billing/cancel?workspaceId=${workspaceId}`,
    // Record the resolved plan (and price, for traceability) so the webhook
    // grants exactly the tier that was purchased.
    metadata: { workspaceId, plan, priceId: selectedPrice },
    allow_promotion_codes: true,
    billing_address_collection: 'auto'
  }

  if (existingCustomerId) {
    sessionParams.customer = existingCustomerId
  } else if (customerEmail) {
    sessionParams.customer_email = customerEmail
  }

  return stripeBreaker.call(() => stripe.checkout.sessions.create(sessionParams))
}

export async function createBillingPortalSession(customerId: string) {
  const stripe = getStripe()
  const webBase = process.env.WEB_URL || process.env.API_URL || 'https://acaos.app'
  return stripeBreaker.call(() => stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${webBase}/billing`
  }))
}

// Boot-time check: confirm each configured STRIPE_PRICE_* id actually resolves
// against the connected Stripe account/mode. validateConfig() only checks the
// env var is non-empty (presence-only) — it can't catch a transposed id or a
// test-mode price id paired with a live-mode secret key, which would silently
// grant a paying customer the wrong tier (or fail checkout) the first time a
// real customer hits it. This calls the API instead.
//
// Non-fatal: Stripe being entirely unconfigured (no STRIPE_SECRET_KEY) is a
// legitimate deploy state — e.g. local dev — so that case returns quietly,
// same as the other optional-integration checks in server.ts (redis's initial
// connect is a fire-and-forget `.catch(logger.warn)`, not a boot crash). A
// CONFIGURED-but-broken price is loud (logger.error), since silently granting
// the wrong plan tier is a real product/billing bug, not a "feature disabled"
// state.
export async function assertStripePricesConfigured(): Promise<void> {
  if (!hasEnv(['STRIPE_SECRET_KEY'])) return

  const stripe = getStripe()
  const checks: Array<{ envVar: string; plan: CheckoutPlan }> = [
    { envVar: 'STRIPE_PRICE_STARTER', plan: 'starter' },
    { envVar: 'STRIPE_PRICE_GROWTH', plan: 'growth' },
  ]

  for (const { envVar, plan } of checks) {
    const id = process.env[envVar]?.trim()
    // An unset price with Stripe otherwise configured is already flagged by
    // validateConfig() in production; nothing further to check here.
    if (!id) continue
    try {
      await stripe.prices.retrieve(id)
    } catch (err) {
      logger.error(
        `Stripe price check failed: ${envVar} ("${id}", the ${plan} plan) does not resolve against the ` +
          'configured STRIPE_SECRET_KEY — a transposed id or a test/live-mode mismatch would silently grant ' +
          'the wrong tier (or fail checkout) for a real customer.',
        { envVar, plan, err: err instanceof Error ? err.message : String(err) },
      )
    }
  }
}

export function constructWebhookEvent(payload: Buffer, sig: string) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET
  if (!secret) throw new ApiError(503, 'STRIPE_WEBHOOK_SECRET not configured')
  return getStripe().webhooks.constructEvent(payload, sig, secret)
}
