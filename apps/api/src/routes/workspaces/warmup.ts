import type { Router } from 'express'
import { asyncHandler, requireUser } from '../../lib/http.js'
import { prisma } from '@acaos/backend-core/lib/prisma.js'
import { assertWorkspacePermission } from '../../lib/permissions.js'
import { recordAudit } from '@acaos/backend-core/lib/audit.js'
import { parseParams, idField } from '../../lib/validate.js'
import { z } from 'zod'

// :id route param.
const workspaceParamsSchema = z.object({ id: idField })

// Manual domain-warmup control. Auto-start (see emailConfig.ts) covers the common
// case — the first time a workspace saves a real SMTP config — but an operator
// needs an explicit lever too: resetting a sender's reputation after a long
// sending pause, or kicking off warmup for a workspace that configured SMTP
// before this feature existed. Unlike auto-start, this ALWAYS (re)stamps
// warmupStartedAt to now, restarting the ramp from day one — that's the point of
// a manual "start/restart" action. Same trust boundary as other ICP/sending
// controls (icp:update — admin+).
export function registerWarmupRoutes(workspaceRouter: Router) {
  workspaceRouter.post(
    '/:id/warmup/start',
    asyncHandler(async (req, res) => {
      const user = requireUser(req)
      const { id: workspaceId } = parseParams(workspaceParamsSchema, req)

      await assertWorkspacePermission(user.id, workspaceId, 'icp:update')

      const warmupStartedAt = new Date()
      await prisma.workspaceICP.upsert({
        where: { workspaceId },
        create: {
          workspaceId, warmupStartedAt,
          targetIndustries: [], targetGeos: [], excludedIndustries: [],
        },
        update: { warmupStartedAt },
      })

      void recordAudit({
        workspaceId, actorUserId: user.id, type: 'workspace.warmup.started',
        entityType: 'workspaceICP', entityId: workspaceId,
        metadata: { warmupStartedAt: warmupStartedAt.toISOString(), trigger: 'manual' },
      })

      res.json({ warmupStartedAt: warmupStartedAt.toISOString() })
    })
  )
}
