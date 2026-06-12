import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { asyncHandler, ApiError } from '../lib/http.js'
import { createCheckoutSession, constructWebhookEvent } from '../services/stripe.js'
import { userCanManageWorkspaceBilling } from '../lib/workspaces.js'
import { prisma } from '../lib/prisma.js'
import { cfg } from '../lib/env.js'
import { logger } from '../lib/logger.js'
import type { AuthedRequest } from '../types/auth.js'

export const billingRouter = Router()

billingRouter.post(
  '/checkout',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const workspaceId = String(req.body?.workspaceId || '').trim()
    const rawPriceId = typeof req.body?.priceId === 'string' ? req.body.priceId.trim() : undefined

    if (!workspaceId) throw new ApiError(400, 'workspaceId required')

    // Allowlist priceId against configured Stripe price IDs — never accept arbitrary IDs from the client
    const ALLOWED_PRICE_IDS = [cfg.stripePriceStarter, cfg.stripePriceGrowth].filter(Boolean) as string[]
    if (rawPriceId && !ALLOWED_PRICE_IDS.includes(rawPriceId)) {
      throw new ApiError(400, 'Invalid priceId')
    }
    const priceId = rawPriceId

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

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as {
          customer?: string
          metadata?: { workspaceId?: string; priceId?: string }
          subscription?: string
        }
        const workspaceId = session.metadata?.workspaceId
        if (workspaceId) {
          const plan = resolvePlanFromPrice(session.metadata?.priceId)
          await prisma.workspace.update({
            where: { id: workspaceId },
            data: {
              stripeCustomerId: session.customer ?? undefined,
              stripeSubscriptionId: session.subscription ?? undefined,
              subscriptionStatus: 'active',
              plan
            }
          })
          logger.info({ workspaceId, plan }, '[billing] checkout.session.completed')
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
          await prisma.workspace.update({
            where: { id: ws.id },
            data: { subscriptionStatus: sub.status, plan }
          })
          logger.info({ workspaceId: ws.id, status: sub.status }, '[billing] subscription.updated')
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
          logger.info({ workspaceId: ws.id }, '[billing] subscription.deleted')
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
            logger.warn({ workspaceId: ws.id }, '[billing] invoice.payment_failed')
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

    res.json({ received: true })
  })
)

// GET /api/billing/usage?workspaceId= — returns current month usage counts
billingRouter.get('/usage', requireAuth, asyncHandler(async (req, res) => {
  const workspaceId = req.query.workspaceId as string
  if (!workspaceId) throw new ApiError(400, 'workspaceId required')

  const userId = (req as AuthedRequest).user.id
  const membership = await prisma.membership.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } }
  })
  if (!membership) throw new ApiError(403, 'Access denied')

  const month = new Date().toISOString().slice(0, 7) // YYYY-MM
  const records = await prisma.usageRecord.findMany({
    where: { workspaceId, month },
    select: { action: true, count: true }
  })

  const usage = Object.fromEntries(records.map(r => [r.action, r.count]))

  // Plan limits — for now hardcoded; later read from workspace.plan
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { plan: true }
  })
  const plan = workspace?.plan ?? 'free'
  const limits = plan === 'growth'  ? { AI_OUTREACH: 2000, AI_BRIEFS: 1000, AI_RESEARCH: 1000 }
               : plan === 'starter' ? { AI_OUTREACH: 500,  AI_BRIEFS: 200,  AI_RESEARCH: 200  }
               : /* free */           { AI_OUTREACH: 20,   AI_BRIEFS: 5,    AI_RESEARCH: 10   }

  res.json({ month, usage, limits, plan })
}))

function resolvePlanFromPrice(priceId: string | undefined): string {
  if (!priceId) return 'starter'
  if (cfg.stripePriceGrowth  && priceId === cfg.stripePriceGrowth)  return 'growth'
  if (cfg.stripePriceStarter && priceId === cfg.stripePriceStarter) return 'starter'
  return 'starter'
}
