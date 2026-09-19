import { Router } from 'express'
import { asyncHandler, ApiError, requireUser } from '../../lib/http.js'
import { userBelongsToWorkspace } from '../../lib/workspaces.js'
import { parseQuery, workspaceIdField } from '../../lib/validate.js'
import { z } from 'zod'
import {
  getEffectiveRateLimit,
  getWorkspaceRateLimits,
  getUpgradeRecommendation,
  BASE_LIMITS,
  PLAN_MULTIPLIERS,
} from '../../lib/planAwareRateLimit.js'
import { prisma } from '@acaos/backend-core/lib/prisma.js'

// Phase 4.1: Rate limit visibility endpoints. Shows users their effective
// rate limits based on plan tier and what they'd get with an upgrade.
// Helps sales understand why a customer is hitting limits.

const querySchema = z.object({ workspaceId: workspaceIdField })

export function registerRateLimitRoutes(router: Router): void {
  // GET /api/workspaces/:id/rate-limits — User-facing rate limit info
  router.get(
    '/:id/rate-limits',
    asyncHandler(async (req, res) => {
      const user = requireUser(req)
      const workspaceId = req.params.id

      if (!(await userBelongsToWorkspace(user.id, workspaceId))) {
        throw new ApiError(403, 'Access denied')
      }

      const ws = await prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { plan: true, subscriptionStatus: true },
      })

      if (!ws) throw new ApiError(404, 'Workspace not found')

      const [mailLimit, aiLimit] = await Promise.all([
        getEffectiveRateLimit(workspaceId, 'mail'),
        getEffectiveRateLimit(workspaceId, 'ai'),
      ])

      const plan = (ws.plan || 'free') as 'free' | 'starter' | 'growth'
      const multiplier = PLAN_MULTIPLIERS[plan]
      const upgrade = getUpgradeRecommendation(plan)

      res.json({
        workspaceId,
        plan,
        subscriptionStatus: ws.subscriptionStatus,
        current: {
          mailPerMinute: mailLimit,
          aiCallsPerHour: aiLimit,
          description: `${plan} tier — ${multiplier}x baseline limits`,
        },
        baseline: BASE_LIMITS,
        upgrade: {
          nextPlan: upgrade.nextPlan,
          mailIncrease: upgrade.mailIncrease,
          aiIncrease: upgrade.aiIncrease,
          nextMailPerMinute: mailLimit + upgrade.mailIncrease,
          nextAiCallsPerHour: aiLimit + upgrade.aiIncrease,
        },
        note: 'These are burst limits per minute (mail) or hour (AI). Monthly quota from plan cap is the billing-relevant ceiling.',
      })
    })
  )

  // GET /api/workspaces?workspaceId=... rate-limits — Query param version
  // (matches pattern used by other workspace endpoints)
  router.get(
    '/limits',
    asyncHandler(async (req, res) => {
      const user = requireUser(req)
      const { workspaceId } = parseQuery(querySchema, req)

      if (!(await userBelongsToWorkspace(user.id, workspaceId))) {
        throw new ApiError(403, 'Access denied')
      }

      const limits = await getWorkspaceRateLimits(workspaceId)
      res.json({
        workspaceId,
        limits,
      })
    })
  )
}
