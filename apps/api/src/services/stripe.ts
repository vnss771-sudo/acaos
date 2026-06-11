import Stripe from 'stripe'
import { ApiError } from '../lib/http.js'
import { hasEnv, cfg } from '../lib/env.js'

function getStripe() {
  if (!hasEnv(['STRIPE_SECRET_KEY', 'WEB_URL'])) {
    throw new ApiError(503, 'Stripe is not configured')
  }
  return new Stripe(cfg.stripeSecretKey!, { apiVersion: '2024-06-20' })
}

export async function createCheckoutSession(
  workspaceId: string,
  customerEmail?: string,
  existingCustomerId?: string,
  priceId?: string
) {
  const stripe = getStripe()
  const selectedPrice = priceId || cfg.stripePriceStarter
  if (!selectedPrice) throw new ApiError(503, 'No Stripe price configured')

  const webUrl = cfg.webUrl ?? ''
  const sessionParams: Stripe.Checkout.SessionCreateParams = {
    mode: 'subscription',
    client_reference_id: workspaceId,
    line_items: [{ price: selectedPrice, quantity: 1 }],
    success_url: `${webUrl}/billing/success?workspaceId=${workspaceId}`,
    cancel_url:  `${webUrl}/billing/cancel?workspaceId=${workspaceId}`,
    metadata: { workspaceId, priceId: selectedPrice },
    allow_promotion_codes: true,
    billing_address_collection: 'auto'
  }

  if (existingCustomerId) {
    sessionParams.customer = existingCustomerId
  } else if (customerEmail) {
    sessionParams.customer_email = customerEmail
  }

  return stripe.checkout.sessions.create(sessionParams)
}

export async function createBillingPortalSession(customerId: string) {
  const stripe = getStripe()
  return stripe.billingPortal.sessions.create({
    customer:   customerId,
    return_url: `${cfg.webUrl ?? ''}/billing`
  })
}

export function constructWebhookEvent(payload: Buffer, sig: string) {
  if (!cfg.stripeWebhookSecret) throw new ApiError(503, 'STRIPE_WEBHOOK_SECRET not configured')
  return getStripe().webhooks.constructEvent(payload, sig, cfg.stripeWebhookSecret)
}

export function priceIdToPlan(priceId: string): string | null {
  if (priceId === cfg.stripePriceGrowth)   return 'growth'
  if (priceId === cfg.stripePriceStarter)  return 'starter'
  return null
}
