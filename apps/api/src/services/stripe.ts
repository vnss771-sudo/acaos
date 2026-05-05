import Stripe from 'stripe'
import { ApiError } from '../lib/http.js'
import { hasEnv } from '../lib/env.js'

function getStripe() {
  if (!hasEnv(['STRIPE_SECRET_KEY', 'WEB_URL'])) {
    throw new ApiError(503, 'Stripe is not configured')
  }
  return new Stripe(process.env.STRIPE_SECRET_KEY as string, { apiVersion: '2024-06-20' })
}

export async function createCheckoutSession(
  workspaceId: string,
  customerEmail?: string,
  existingCustomerId?: string,
  priceId?: string
) {
  const stripe = getStripe()
  const selectedPrice = priceId || process.env.STRIPE_PRICE_STARTER
  if (!selectedPrice) throw new ApiError(503, 'No Stripe price configured')

  const sessionParams: Stripe.Checkout.SessionCreateParams = {
    mode: 'subscription',
    client_reference_id: workspaceId,
    line_items: [{ price: selectedPrice, quantity: 1 }],
    success_url: `${process.env.WEB_URL}/billing/success?workspaceId=${workspaceId}`,
    cancel_url: `${process.env.WEB_URL}/billing/cancel?workspaceId=${workspaceId}`,
    metadata: { workspaceId },
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
    customer: customerId,
    return_url: `${process.env.WEB_URL}/billing`
  })
}

export function constructWebhookEvent(payload: Buffer, sig: string) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET
  if (!secret) throw new ApiError(503, 'STRIPE_WEBHOOK_SECRET not configured')
  return getStripe().webhooks.constructEvent(payload, sig, secret)
}
