import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireFreshAuth, requireVerifiedForMutation } from '../middleware/auth.js'
import { asyncHandler, ApiError } from '../lib/http.js'
import { parseBody, parseQuery, workspaceIdField } from '../lib/validate.js'
import { createCheckoutSession, constructWebhookEvent, createBillingPortalSession } from '../services/stripe.js'
import { assertWorkspacePermission } from '../lib/permissions.js'
import { getMonthlyUsage, getPlanCatalog } from '../lib/limits.js'
import { prisma } from '../lib/prisma.js'
import { isMailConfigured, sendMail } from '../services/mail.js'
import { recordAudit } from '../lib/audit.js'
import type { BillingPlan } from '@acaos/shared'

export const billingRouter = Router()

// Accept a server-side plan enum, never a raw Stripe price id from the client. A
// client-supplied price could point at an arbitrary (cheaper or unintended) price
// in the Stripe account; the price is resolved server-side from the chosen plan.
const checkoutSchema = z.object({
  workspaceId: workspaceIdField,
  plan: z.enum(['starter', 'growth']),
})
const workspaceQuerySchema = z.object({ workspaceId: workspaceIdField })
const workspaceBodySchema = z.object({ workspaceId: workspaceIdField })

billingRouter.post(
  '/checkout',
  requireAuth,
  requireVerifiedForMutation,
  requireFreshAuth,
  asyncHandler(async (req, res) => {
    const user = req.user!
    const { workspaceId, plan } = parseBody(checkoutSchema, req)

    await assertWorkspacePermission(user.id, workspaceId, 'billing:manage')

    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true, subscriptionStatus: true, stripeCustomerId: true }
    })
    if (!workspace) throw new ApiError(404, 'Workspace not found')

    if (workspace.subscriptionStatus === 'active') {
      throw new ApiError(409, 'Workspace already has an active subscription')
    }

    const session = await createCheckoutSession(workspaceId, plan, user.email, workspace.stripeCustomerId ?? undefined)
    if (!session.url) throw new ApiError(502, 'Stripe checkout URL unavailable')

    res.json({ url: session.url })
  })
)

// Plan catalog: the canonical per-plan limits the backend enforces. The billing
// UI renders its comparison numbers from this so they can never drift from
// enforcement. Auth'd (the billing page is authed) but workspace-agnostic.
billingRouter.get(
  '/plans',
  requireAuth,
  asyncHandler(async (_req, res) => {
    res.json({ plans: getPlanCatalog() })
  })
)

billingRouter.get(
  '/status',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.user!
    const { workspaceId } = parseQuery(workspaceQuerySchema, req)

    await assertWorkspacePermission(user.id, workspaceId, 'billing:manage')

    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { plan: true, subscriptionStatus: true, stripeSubscriptionId: true }
    })
    if (!workspace) throw new ApiError(404, 'Workspace not found')

    const usage = await getMonthlyUsage(workspaceId)
    res.json({
      plan: workspace.plan,
      status: workspace.subscriptionStatus ?? 'none',
      hasSubscription: Boolean(workspace.stripeSubscriptionId),
      usage
    })
  })
)

billingRouter.post(
  '/portal',
  requireAuth,
  requireVerifiedForMutation,
  requireFreshAuth,
  asyncHandler(async (req, res) => {
    const user = req.user!
    const { workspaceId } = parseBody(workspaceBodySchema, req)

    await assertWorkspacePermission(user.id, workspaceId, 'billing:manage')

    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { stripeCustomerId: true }
    })
    if (!workspace?.stripeCustomerId) throw new ApiError(404, 'No billing account found')

    const session = await createBillingPortalSession(workspace.stripeCustomerId)
    res.json({ url: session.url })
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
      // Audit the verification failure. Never log the raw signature header or the
      // webhook secret — only the safe error reason.
      void recordAudit({
        type: 'billing.webhook.verification_failed',
        entityType: 'stripeWebhook',
        metadata: { reason: err instanceof Error ? err.message : 'unknown' },
      })
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
      // Audit the processing failure. Record only the event id/type + safe error
      // reason — never any signature or secret material.
      void recordAudit({
        type: 'billing.webhook.processing_failed',
        entityType: 'stripeWebhook', entityId: event.id,
        metadata: { eventType: event.type, reason: err instanceof Error ? err.message : 'unknown' },
      })
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
          metadata?: { workspaceId?: string; plan?: string; priceId?: string }
          subscription?: string
        }
        const workspaceId = session.metadata?.workspaceId
        if (workspaceId) {
          const plan = resolveCheckoutPlan(session.metadata)
          // Always activate the paid subscription, but never grant a tier by
          // guessing: if the plan/price is unrecognized, leave the existing plan
          // untouched rather than defaulting to starter.
          const data: Record<string, unknown> = {
            stripeCustomerId: session.customer ?? undefined,
            stripeSubscriptionId: session.subscription ?? undefined,
            subscriptionStatus: 'active',
          }
          if (plan !== null) {
            data.plan = plan
          } else {
            console.error(`[billing] checkout.session.completed workspace=${workspaceId} with unrecognized plan/price; activating without changing plan tier`)
          }
          await prisma.workspace.update({ where: { id: workspaceId }, data })
          console.log(`[billing] checkout.session.completed workspace=${workspaceId} plan=${plan ?? 'unchanged'}`)
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
            // Send dunning email to the workspace owner
            if (isMailConfigured()) {
              const ownerMembership = await prisma.membership.findFirst({
                where: { workspaceId: ws.id, role: 'owner' },
                select: { user: { select: { email: true } } }
              })
              const ownerEmail = ownerMembership?.user?.email
              if (ownerEmail) {
                const appUrl = process.env.APP_URL || 'http://localhost:5173'
                const billingUrl = `${appUrl}/settings/billing`
                await sendMail(
                  ownerEmail,
                  'Action required: payment failed for your ACAOS subscription',
                  `<p>Hi,</p>
<p>We were unable to process the payment for your ACAOS subscription. Your workspace has been marked as <strong>past due</strong>.</p>
<p>Please update your billing information to avoid any interruption to your service:</p>
<p><a href="${billingUrl}">${billingUrl}</a></p>
<p>If you have any questions, please reply to this email.</p>
<p>Thanks,<br>The ACAOS Team</p>`
                ).catch(() => {})
              }
            }
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
function resolvePlanFromPrice(priceId: string | undefined): BillingPlan | null {
  if (!priceId) return null
  if (priceId === process.env.STRIPE_PRICE_GROWTH) return 'growth'
  if (priceId === process.env.STRIPE_PRICE_STARTER) return 'starter'
  return null
}

// Resolves the plan for a completed checkout from its session metadata. Prefers
// the server-set `plan` field (which the checkout route now controls) and falls
// back to mapping the price id for sessions created before that change. Returns
// null when neither yields a known plan.
function resolveCheckoutPlan(metadata: { plan?: string; priceId?: string } | undefined): BillingPlan | null {
  const p = metadata?.plan
  if (p === 'starter' || p === 'growth') return p
  return resolvePlanFromPrice(metadata?.priceId)
}
