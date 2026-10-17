import type { Router } from 'express'
import { z } from 'zod'
import { asyncHandler, requireUser, ApiError } from '../../lib/http.js'
import { prisma } from '@acaos/backend-core/lib/prisma.js'
import { recordAudit } from '@acaos/backend-core/lib/audit.js'
import { ESTIMATE_PCT_LIMITS } from '@acaos/backend-core/lib/quoteEstimate.js'
import { assertWorkspacePermission } from '../../lib/permissions.js'
import { parseParams, parseBody, idField } from '../../lib/validate.js'
import type { Assert, Extends, QuotingDefaults } from '@acaos/shared'

const paramsSchema = z.object({ id: idField })
const pct = (max: number) => z.number().finite().min(0).max(max).nullable()
// Every field is required: null clears a default (the builder field starts blank),
// 0 is a real 0. Strict, so a typo can't be silently ignored.
const defaultsSchema = z.object({
  defaultOnCostPct: pct(ESTIMATE_PCT_LIMITS.onCostPct),
  defaultOverheadPct: pct(ESTIMATE_PCT_LIMITS.overheadPct),
  defaultTargetMarginPct: pct(ESTIMATE_PCT_LIMITS.targetMarginPct),
}).strict()
type _DefaultsConforms = Assert<Extends<z.infer<typeof defaultsSchema>, QuotingDefaults>>

const SELECT = { defaultOnCostPct: true, defaultOverheadPct: true, defaultTargetMarginPct: true } as const

// Quoting defaults for the estimate builder. Admin-only (ops:manage), like quotes,
// rates and margins. The builder copies them into a new estimate once, when it
// opens; saved estimates keep their own inputs, so changing a default never
// alters a saved quote.
export function registerQuotingDefaultsRoutes(workspaceRouter: Router) {
  workspaceRouter.get(
    '/:id/quoting-defaults',
    asyncHandler(async (req, res) => {
      const user = requireUser(req)
      const { id: workspaceId } = parseParams(paramsSchema, req)
      await assertWorkspacePermission(user.id, workspaceId, 'ops:manage')
      const defaults = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: SELECT })
      if (!defaults) throw new ApiError(404, 'Workspace not found')
      res.json({ defaults })
    })
  )

  workspaceRouter.put(
    '/:id/quoting-defaults',
    asyncHandler(async (req, res) => {
      const user = requireUser(req)
      const { id: workspaceId } = parseParams(paramsSchema, req)
      await assertWorkspacePermission(user.id, workspaceId, 'ops:manage')
      const next = parseBody(defaultsSchema, req)
      const before = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: SELECT })
      if (!before) throw new ApiError(404, 'Workspace not found')
      const defaults = await prisma.workspace.update({ where: { id: workspaceId }, data: next, select: SELECT })
      await recordAudit({
        workspaceId, actorUserId: user.id, type: 'workspace.quoting_defaults', entityType: 'workspace', entityId: workspaceId,
        metadata: { from: before, to: defaults },
      })
      res.json({ defaults })
    })
  )
}
