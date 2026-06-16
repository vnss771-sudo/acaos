import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { asyncHandler, ApiError } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import { userBelongsToWorkspace } from '../lib/workspaces.js'
import { listPacks, getPack } from '../lib/packs/index.js'
import { recordAudit } from '../lib/audit.js'
import type { AuthedRequest } from '../types/auth.js'

export const packsRouter = Router()
packsRouter.use(requireAuth)

// List available industry packs (summaries).
packsRouter.get('/', asyncHandler(async (_req, res) => {
  res.json({ packs: listPacks() })
}))

// Full pack detail (ICP preset, signals, templates).
packsRouter.get('/:id', asyncHandler(async (req, res) => {
  const pack = getPack(req.params.id as string)
  if (!pack) throw new ApiError(404, 'Pack not found')
  res.json({ pack })
}))

// Apply a pack's ICP preset to a workspace (onboarding shortcut). The operator
// can still edit their ICP afterwards; this just seeds it from the vertical.
packsRouter.post('/:id/apply', asyncHandler(async (req, res) => {
  const user = (req as AuthedRequest).user
  const workspaceId = String(req.body?.workspaceId || '').trim()
  if (!workspaceId) throw new ApiError(400, 'workspaceId required')
  if (!(await userBelongsToWorkspace(user.id, workspaceId))) throw new ApiError(403, 'Access denied')

  const pack = getPack(req.params.id as string)
  if (!pack) throw new ApiError(404, 'Pack not found')

  const { icp } = pack
  const data = {
    targetIndustries: icp.targetIndustries,
    minEmployees: icp.minEmployees ?? null,
    maxEmployees: icp.maxEmployees ?? null,
    targetGeos: icp.targetGeos,
    businessType: icp.businessType ?? null,
    outreachTone: icp.outreachTone ?? null,
    excludedIndustries: icp.excludedIndustries ?? [],
    playbook: pack.id,
  }

  const saved = await prisma.workspaceICP.upsert({
    where: { workspaceId },
    create: { workspaceId, ...data },
    update: data,
  })

  void recordAudit({
    workspaceId, actorUserId: user.id, type: 'pack.applied',
    entityType: 'pack', entityId: pack.id, metadata: { pack: pack.id },
  })

  res.json({ icp: saved })
}))
