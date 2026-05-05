import Stripe from 'stripe'
import { ApiError } from '../lib/http.js'
import { hasEnv } from '../lib/env.js'

function getStripe() {
  if (!hasEnv(['STRIPE_SECRET_KEY', 'STRIPE_PRICE_STARTER', 'WEB_URL'])) {
    throw new ApiError(503, 'Stripe checkout is not configured')
  }

  return new Stripe(process.env.STRIPE_SECRET_KEY as string)
}

export async function createCheckoutSession(workspaceId: string) {
  const stripe = getStripe()

  return stripe.checkout.sessions.create({
    mode: 'subscription',
    client_reference_id: workspaceId,
    line_items: [{ price: process.env.STRIPE_PRICE_STARTER as string, quantity: 1 }],
    success_url: `${process.env.WEB_URL}/billing/success?workspaceId=${workspaceId}`,
    cancel_url: `${process.env.WEB_URL}/billing/cancel?workspaceId=${workspaceId}`,
    metadata: { workspaceId }
  })
}

export function constructWebhookEvent(payload: Buffer, sig: string) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET
  if (!secret) throw new ApiError(503, 'STRIPE_WEBHOOK_SECRET not configured')

  return new Stripe(process.env.STRIPE_SECRET_KEY as string).webhooks.constructEvent(
    payload,
    sig,
    secret
  )
}
