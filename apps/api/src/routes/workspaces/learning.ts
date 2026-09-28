import type { Router } from 'express'
import { z } from 'zod'
import { asyncHandler, requireUser, ApiError } from '../../lib/http.js'
import { prisma } from '@acaos/backend-core/lib/prisma.js'
import { assertWorkspacePermission } from '../../lib/permissions.js'
import { parseParams, idField } from '../../lib/validate.js'
import { compareHoldout } from '@acaos/backend-core/lib/holdout.js'
import { decideRecommendation, DecisionError, isExpired, type DecisionAction } from '@acaos/backend-core/lib/learningDecisions.js'

const listParams = z.object({ id: idField })
const decideParams = z.object({ id: idField, recId: idField })

// Learning Centre: what ACAOS has learned and proposes. Reading is open to any
// member; deciding (approve / reject / revert) changes strategy, so it needs
// the same permission as editing the ICP by hand.
export function registerLearningRoutes(workspaceRouter: Router) {
  workspaceRouter.get(
    '/:id/learning-recommendations',
    asyncHandler(async (req, res) => {
      const user = requireUser(req)
      const { id: workspaceId } = parseParams(listParams, req)
      const membership = await prisma.membership.findFirst({ where: { userId: user.id, workspaceId }, select: { role: true } })
      if (!membership) throw new ApiError(403, 'Access denied')

      const rows = await prisma.learningRecommendation.findMany({
        where: { workspaceId, status: { not: 'SUPERSEDED' } },
        orderBy: { createdAt: 'desc' },
        take: 50,
      })
      const now = new Date()
      res.json({
        recommendations: rows.map(r => ({
          ...r,
          createdAt: r.createdAt.toISOString(),
          decidedAt: r.decidedAt?.toISOString() ?? null,
          expired: r.status === 'PENDING' && isExpired(r.createdAt, now),
        })),
      })
    })
  )

  // Contacted vs held-back comparison group (lib/holdout.ts).
  workspaceRouter.get(
    '/:id/learning/holdout',
    asyncHandler(async (req, res) => {
      const user = requireUser(req)
      const { id: workspaceId } = parseParams(listParams, req)
      const membership = await prisma.membership.findFirst({ where: { userId: user.id, workspaceId }, select: { role: true } })
      if (!membership) throw new ApiError(403, 'Access denied')
      res.json(await compareHoldout(workspaceId))
    })
  )

  for (const action of ['approve', 'reject', 'revert'] as const satisfies readonly DecisionAction[]) {
    workspaceRouter.post(
      `/:id/learning-recommendations/:recId/${action}`,
      asyncHandler(async (req, res) => {
        const user = requireUser(req)
        const { id: workspaceId, recId } = parseParams(decideParams, req)
        await assertWorkspacePermission(user.id, workspaceId, 'icp:update')
        try {
          const rec = await decideRecommendation({ workspaceId, recommendationId: recId, actorUserId: user.id, action })
          res.json({ recommendation: { ...rec, createdAt: rec.createdAt.toISOString(), decidedAt: rec.decidedAt?.toISOString() ?? null } })
        } catch (err) {
          if (err instanceof DecisionError) throw new ApiError(err.status, err.message)
          throw err
        }
      })
    )
  }
}
