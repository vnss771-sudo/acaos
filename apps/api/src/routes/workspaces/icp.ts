import type { Router } from 'express'
import { asyncHandler, ApiError } from '../../lib/http.js'
import { prisma } from '../../lib/prisma.js'
import { z } from 'zod'
import type { Assert, Extends, UpdateIcpRequest } from '@acaos/shared'

// Request contract for PUT /:id/icp, pinned to the shared type so the accepted
// body shape can't drift from UpdateIcpRequest. The handler parses req.body
// defensively (below) rather than through this schema, so this is a compile-time
// guard only — adding runtime validation would change behaviour.
const _updateIcpSchema = z.object({
  businessType:       z.string().nullish(),
  playbook:           z.string().nullish(),
  targetIndustries:   z.array(z.string()),
  targetGeos:         z.array(z.string()),
  minEmployees:       z.number().nullish(),
  maxEmployees:       z.number().nullish(),
  mustHaveEmail:      z.boolean().optional(),
  outreachTone:       z.string().optional(),
  dailySendLimit:     z.number().optional(),
  approvalMode:       z.boolean().optional(),
  excludedIndustries: z.array(z.string()).optional(),
})
type _UpdateIcpConforms = Assert<Extends<z.infer<typeof _updateIcpSchema>, UpdateIcpRequest>>

export function registerIcpRoutes(workspaceRouter: Router) {
  workspaceRouter.get(
    '/:id/icp',
    asyncHandler(async (req, res) => {
      const user = req.user!
      const workspaceId = req.params.id as string

      const membership = await prisma.membership.findFirst({
        where: { userId: user.id, workspaceId },
        select: { role: true }
      })
      if (!membership) throw new ApiError(403, 'Access denied')

      const icp = await prisma.workspaceICP.findUnique({ where: { workspaceId } })
      res.json({ icp: icp ?? null })
    })
  )

  workspaceRouter.put(
    '/:id/icp',
    asyncHandler(async (req, res) => {
      const user = req.user!
      const workspaceId = req.params.id as string

      const canManage = await prisma.membership.findFirst({
        where: { userId: user.id, workspaceId, role: { in: ['owner', 'admin'] } }
      })
      if (!canManage) throw new ApiError(403, 'Must be owner or admin to update ICP')

      const body = req.body ?? {}
      const arr = (v: unknown): string[] | undefined =>
        Array.isArray(v) ? v.filter((s: unknown) => typeof s === 'string') : undefined

      const targetIndustries = arr(body.targetIndustries)
      const targetGeos = arr(body.targetGeos)
      const excludedIndustries = arr(body.excludedIndustries)
      const minEmployees = typeof body.minEmployees === 'number' ? body.minEmployees : null
      const maxEmployees = typeof body.maxEmployees === 'number' ? body.maxEmployees : null
      const mustHaveEmail = typeof body.mustHaveEmail === 'boolean' ? body.mustHaveEmail : undefined
      const businessType = typeof body.businessType === 'string' ? body.businessType.trim() || null : undefined
      const outreachTone = typeof body.outreachTone === 'string' && ['professional', 'casual', 'direct'].includes(body.outreachTone) ? body.outreachTone : undefined
      const approvalMode = typeof body.approvalMode === 'boolean' ? body.approvalMode : undefined
      const dailySendLimit = typeof body.dailySendLimit === 'number' && body.dailySendLimit > 0 ? Math.min(body.dailySendLimit, 500) : undefined
      const playbook = typeof body.playbook === 'string' ? body.playbook || null : undefined

      const data: Record<string, unknown> = {}
      if (targetIndustries !== undefined) data.targetIndustries = targetIndustries
      if (targetGeos !== undefined) data.targetGeos = targetGeos
      if (excludedIndustries !== undefined) data.excludedIndustries = excludedIndustries
      if (minEmployees !== undefined) data.minEmployees = minEmployees
      if (maxEmployees !== undefined) data.maxEmployees = maxEmployees
      if (mustHaveEmail !== undefined) data.mustHaveEmail = mustHaveEmail
      if (businessType !== undefined) data.businessType = businessType
      if (outreachTone !== undefined) data.outreachTone = outreachTone
      if (approvalMode !== undefined) data.approvalMode = approvalMode
      if (dailySendLimit !== undefined) data.dailySendLimit = dailySendLimit
      if (playbook !== undefined) data.playbook = playbook

      const icp = await prisma.workspaceICP.upsert({
        where: { workspaceId },
        create: {
          workspaceId,
          targetIndustries: (data.targetIndustries as string[]) ?? [],
          targetGeos: (data.targetGeos as string[]) ?? [],
          excludedIndustries: (data.excludedIndustries as string[]) ?? [],
          minEmployees: (data.minEmployees as number | null) ?? null,
          maxEmployees: (data.maxEmployees as number | null) ?? null,
          mustHaveEmail: (data.mustHaveEmail as boolean) ?? false,
          businessType: (data.businessType as string | null) ?? null,
          outreachTone: (data.outreachTone as string) ?? 'professional',
          approvalMode: (data.approvalMode as boolean) ?? true,
          dailySendLimit: (data.dailySendLimit as number) ?? 50,
          playbook: (data.playbook as string | null) ?? null,
        },
        update: data,
      })

      res.json({ icp })
    })
  )
}
