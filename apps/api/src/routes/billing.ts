import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { asyncHandler, ApiError } from '../lib/http.js'
import { createCheckoutSession } from '../services/stripe.js'
import { userCanManageWorkspaceBilling } from '../lib/workspaces.js'
import type { AuthedRequest } from '../types/auth.js'

export const billingRouter = Router()

billingRouter.post(
  '/checkout',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const workspaceId = String(req.body?.workspaceId || '').trim()

    if (!workspaceId) {
      throw new ApiError(400, 'workspaceId required')
    }

    const allowed = await userCanManageWorkspaceBilling(user.id, workspaceId)
    if (!allowed) {
      throw new ApiError(403, 'Workspace billing access denied')
    }

    const session = await createCheckoutSession(workspaceId)
    if (!session.url) {
      throw new ApiError(502, 'Stripe checkout URL unavailable')
    }

    res.json({ url: session.url })
  })
)

// Stripe webhook — note: body is raw Buffer (wired in server.ts)
billingRouter.post(
  '/webhook',
  asyncHandler(async (req, res) => {
    const sig = req.headers['stripe-signature']
    if (typeof sig !== 'string') throw new ApiError(400, 'Missing stripe-signature header')

    let event
    try {
      const { constructWebhookEvent } = await import('../services/stripe.js')
      event = constructWebhookEvent(req.body as Buffer, sig)
    } catch (err) {
      throw new ApiError(400, `Webhook signature invalid: ${err instanceof Error ? err.message : ''}`)
    }

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as { metadata?: { workspaceId?: string }; subscription?: string }
        const workspaceId = session.metadata?.workspaceId
        if (workspaceId) {
          const { prisma } = await import('../lib/prisma.js')
          // Store subscription id on workspace — add subscriptionId field via migration if needed
          // For now log and acknowledge
          console.log(`Checkout completed: workspace=${workspaceId} subscription=${session.subscription}`)
        }
        break
      }
      case 'customer.subscription.deleted': {
        console.log('Subscription cancelled:', event.data.object)
        break
      }
      default:
        console.log(`Unhandled Stripe event: ${event.type}`)
    }

    res.json({ received: true })
  })
)
