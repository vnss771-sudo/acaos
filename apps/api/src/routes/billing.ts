import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { asyncHandler, ApiError } from '../lib/http.js'
import { createCheckoutSession, constructWebhookEvent } from '../services/stripe.js'
import { userCanManageWorkspaceBilling } from '../lib/workspaces.js'
import { prisma } from '../lib/prisma.js'
import type { AuthedRequest } from '../types/auth.js'

export const billingRouter = Router()

billingRouter.post(
  '/checkout',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const workspaceId = String(req.body?.workspaceId || '').trim()
    const priceId = typeof req.body?.priceId === 'string' ? req.body.priceId.trim() : undefined

    if (!workspaceId) throw new ApiError(400, 'workspaceId required')

    const allowed = await userCanManageWorkspaceBilling(user.id, workspaceId)
    if (!allowed) throw new ApiError(403, 'Workspace billing access denied')

    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true, subscriptionStatus: true, stripeCustomerId: true }
    })
    if (!workspace) throw new ApiError(404, 'Workspace not found')

    if (workspace.subscriptionStatus === 'active') {
      throw new ApiError(409, 'Workspace already has an active subscription')
    }

    const session = await createCheckoutSession(workspaceId, user.email, workspace.stripeCustomerId ?? undefined, priceId)
    if (!session.url) throw new ApiError(502, 'Stripe checkout URL unavailable')

    res.json({ url: session.url })
  })
)

billingRouter.get(
  '/status',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const workspaceId = String(req.query.workspaceId || '').trim()
    if (!workspaceId) throw new ApiError(400, 'workspaceId required')

    const allowed = await userCanManageWorkspaceBilling(user.id, workspaceId)
    if (!allowed) throw new ApiError(403, 'Access denied')

    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { plan: true, subscriptionStatus: true, stripeSubscriptionId: true }
    })
    if (!workspace) throw new ApiError(404, 'Workspace not found')

    res.json({
      plan: workspace.plan,
      status: workspace.subscriptionStatus ?? 'none',
      hasSubscription: Boolean(workspace.stripeSubscriptionId)
    })
  })
)

// Stripe webhook — body is raw Buffer (wired in server.ts)
billingRouter.post(
  '/webhook',
  asyncHandler(async (req, res) => {
    const sig = req.headers['stripe-signature']
    if (typeof sig !== 'string') throw new ApiError(400, 'Missing stripe-signature header')

    let event
    try {
      event = constructWebhookEvent(req.body as Buffer, sig)
    } catch (err) {
      throw new ApiError(400, `Webhook signature invalid: ${err instanceof Error ? err.message : ''}`)
    }

    // Idempotency: Stripe delivers at-least-once. Claim the event id first; if
    // it already exists we've handled this delivery, so acknowledge and stop.
    try {
      await prisma.processedStripeEvent.create({ data: { id: event.id, type: event.type } })
    } catch {
      return res.json({ received: true, duplicate: true })
    }

    try {
      await handleWebhookEvent(event)
    } catch (err) {
      // Processing failed after claiming the event — release the claim so
      // Stripe's redelivery is reprocessed rather than skipped as a duplicate.
      await prisma.processedStripeEvent.delete({ where: { id: event.id } }).catch(() => {})
      throw err
    }

    res.json({ received: true })
  })
)

async function handleWebhookEvent(event: { type: string; data: { object: unknown } }) {
  switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as {
          customer?: string
          metadata?: { workspaceId?: string; priceId?: string }
          subscription?: string
        }
        const workspaceId = session.metadata?.workspaceId
        if (workspaceId) {
          // New subscription: default an unrecognized price to starter, but log it.
          const plan = resolvePlanFromPrice(session.metadata?.priceId) ?? 'starter'
          if (!resolvePlanFromPrice(session.metadata?.priceId)) {
            console.warn(`[billing] unrecognized priceId on checkout for workspace=${workspaceId}; defaulting to starter`)
          }
          await prisma.workspace.update({
            where: { id: workspaceId },
            data: {
              stripeCustomerId: session.customer ?? undefined,
              stripeSubscriptionId: session.subscription ?? undefined,
              subscriptionStatus: 'active',
              plan
            }
          })
          console.log(`[billing] checkout.session.completed workspace=${workspaceId} plan=${plan}`)
        }
        break
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object as {
          id: string
          status: string
          customer: string
          items?: { data?: Array<{ price?: { id: string } }> }
        }
        const priceId = sub.items?.data?.[0]?.price?.id
        const plan = resolvePlanFromPrice(priceId)

        const ws = await prisma.workspace.findFirst({
          where: { stripeSubscriptionId: sub.id },
          select: { id: true }
        })
        if (ws) {
          // Only touch the plan when the price maps to a known plan. An
          // unrecognized price (proration line, add-on, or an env not set in
          // this service) must NOT silently downgrade a paying customer.
          if (plan === null) {
            console.warn(`[billing] subscription.updated ws=${ws.id} unrecognized priceId=${priceId}; preserving existing plan`)
          }
          await prisma.workspace.update({
            where: { id: ws.id },
            data: { subscriptionStatus: sub.status, ...(plan !== null ? { plan } : {}) }
          })
          console.log(`[billing] subscription.updated ws=${ws.id} status=${sub.status}`)
        }
        break
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object as { id: string; status: string }
        const ws = await prisma.workspace.findFirst({
          where: { stripeSubscriptionId: sub.id },
          select: { id: true }
        })
        if (ws) {
          await prisma.workspace.update({
            where: { id: ws.id },
            data: { subscriptionStatus: 'canceled', plan: 'free', stripeSubscriptionId: null }
          })
          console.log(`[billing] subscription.deleted ws=${ws.id}`)
        }
        break
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as { subscription?: string }
        if (invoice.subscription) {
          const ws = await prisma.workspace.findFirst({
            where: { stripeSubscriptionId: invoice.subscription as string },
            select: { id: true }
          })
          if (ws) {
            await prisma.workspace.update({
              where: { id: ws.id },
              data: { subscriptionStatus: 'past_due' }
            })
            console.log(`[billing] invoice.payment_failed ws=${ws.id}`)
          }
        }
        break
      }

      case 'invoice.payment_succeeded': {
        const invoice = event.data.object as { subscription?: string }
        if (invoice.subscription) {
          const ws = await prisma.workspace.findFirst({
            where: { stripeSubscriptionId: invoice.subscription as string },
            select: { id: true }
          })
          if (ws) {
            await prisma.workspace.update({
              where: { id: ws.id },
              data: { subscriptionStatus: 'active' }
            })
          }
        }
        break
      }

      default:
        // Silently acknowledge unknown events
        break
    }
}

// Maps a Stripe price id to a plan, or null when the price is not recognized.
// Callers decide whether an unrecognized price should default (new checkout) or
// be preserved (subscription update) — it must never blindly downgrade.
function resolvePlanFromPrice(priceId: string | undefined): string | null {
  if (!priceId) return null
  if (priceId === process.env.STRIPE_PRICE_GROWTH) return 'growth'
  if (priceId === process.env.STRIPE_PRICE_STARTER) return 'starter'
  return null
}
