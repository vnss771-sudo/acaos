import type { Router } from 'express'
import { asyncHandler, ApiError } from '../../lib/http.js'
import { prisma } from '../../lib/prisma.js'
import { z } from 'zod'
import { parseBody, parseParams, idField } from '../../lib/validate.js'
import { assertWorkspacePermission } from '../../lib/permissions.js'
import type { Assert, Extends, UpdateIcpRequest } from '@acaos/shared'

// Compile-time contract for PUT /:id/icp, pinned to the shared type so the
// accepted body shape can't drift from UpdateIcpRequest.
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

// :id route param.
const workspaceParamsSchema = z.object({ id: idField })

// Runtime request schema. This is the previous defensive, per-field parsing
// expressed as Zod so its *output* is identical to what the handler computed by
// hand: array fields keep only string elements (else undefined); min/max
// employees → number, else (present) null, else undefined; outreachTone only the
// allowed set, else undefined; dailySendLimit a positive number clamped to ≤ 500,
// else undefined; businessType trimmed (blank → null); playbook blank → null.
// Invalid-but-present values are tolerated (mapped to the same fallback the old
// code produced) so behaviour is unchanged — only the field *types* are pinned.
const stringArrayRuntime = z.unknown().optional().transform(v =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : undefined
)
const updateIcpRuntimeSchema = z.object({
  targetIndustries:   stringArrayRuntime,
  targetGeos:         stringArrayRuntime,
  excludedIndustries: stringArrayRuntime,
  // NB: the old handler set these to null for absent OR non-number, and ALWAYS
  // included them in the upsert data — mirror that (never undefined).
  minEmployees:       z.unknown().optional().transform(v => (typeof v === 'number' ? v : null)),
  maxEmployees:       z.unknown().optional().transform(v => (typeof v === 'number' ? v : null)),
  mustHaveEmail:      z.unknown().optional().transform(v => (typeof v === 'boolean' ? v : undefined)),
  businessType:       z.unknown().optional().transform(v => (typeof v === 'string' ? v.trim() || null : undefined)),
  outreachTone:       z.unknown().optional().transform(v => (typeof v === 'string' && ['professional', 'casual', 'direct'].includes(v) ? v : undefined)),
  approvalMode:       z.unknown().optional().transform(v => (typeof v === 'boolean' ? v : undefined)),
  dailySendLimit:     z.unknown().optional().transform(v => (typeof v === 'number' && v > 0 ? Math.min(v, 500) : undefined)),
  playbook:           z.unknown().optional().transform(v => (typeof v === 'string' ? v || null : undefined)),
})

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
      const { id: workspaceId } = parseParams(workspaceParamsSchema, req)

      await assertWorkspacePermission(user.id, workspaceId, 'icp:update')

      const {
        targetIndustries, targetGeos, excludedIndustries,
        minEmployees, maxEmployees, mustHaveEmail, businessType,
        outreachTone, approvalMode, dailySendLimit, playbook,
      } = parseBody(updateIcpRuntimeSchema, { body: req.body ?? {} })

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
