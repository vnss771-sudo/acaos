import type { Router } from 'express'
import { asyncHandler, ApiError } from '../../lib/http.js'
import { prisma } from '../../lib/prisma.js'
import { generateApiKey, hashApiKey } from '../../lib/apiKeys.js'
import { evictCachedWorkspace } from '../../lib/ingestCache.js'
import { recordAudit } from '../../lib/audit.js'

export function registerApiKeyRoutes(workspaceRouter: Router) {
  workspaceRouter.post(
    '/:id/api-key/rotate',
    asyncHandler(async (req, res) => {
      const user = req.user!
      const workspaceId = req.params.id as string

      const canManage = await prisma.membership.findFirst({
        where: { userId: user.id, workspaceId, role: { in: ['owner', 'admin'] } }
      })
      if (!canManage) throw new ApiError(403, 'Must be owner or admin')

      // F-05: Evict old hash from cache before rotating so the revoked key stops working immediately
      const beforeRotate = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { ingestApiKey: true } })
      if (beforeRotate?.ingestApiKey) evictCachedWorkspace(beforeRotate.ingestApiKey)

      const rawKey = generateApiKey()
      const hashedKey = hashApiKey(rawKey)

      await prisma.workspace.update({
        where: { id: workspaceId },
        data: { ingestApiKey: hashedKey }
      })

      // Never log the raw or hashed key — only that a rotation occurred.
      void recordAudit({
        workspaceId, actorUserId: user.id, type: 'workspace.api_key.rotate',
        entityType: 'workspace', entityId: workspaceId,
      })

      // Raw key shown ONCE — not stored anywhere
      res.json({ apiKey: rawKey, warning: 'Store this key securely — it will not be shown again' })
    })
  )

  workspaceRouter.delete(
    '/:id/api-key',
    asyncHandler(async (req, res) => {
      const user = req.user!
      const workspaceId = req.params.id as string

      const canManage = await prisma.membership.findFirst({
        where: { userId: user.id, workspaceId, role: { in: ['owner', 'admin'] } }
      })
      if (!canManage) throw new ApiError(403, 'Must be owner or admin')

      // F-05: Evict old hash from cache before deleting so the revoked key stops working immediately
      const existing = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { ingestApiKey: true } })
      if (existing?.ingestApiKey) evictCachedWorkspace(existing.ingestApiKey)

      await prisma.workspace.update({ where: { id: workspaceId }, data: { ingestApiKey: null } })

      // Never log the revoked key — only that a revocation occurred.
      void recordAudit({
        workspaceId, actorUserId: user.id, type: 'workspace.api_key.revoke',
        entityType: 'workspace', entityId: workspaceId,
      })

      res.json({ ok: true })
    })
  )
}
