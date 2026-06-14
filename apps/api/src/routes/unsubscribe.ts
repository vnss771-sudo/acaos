import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { prisma } from '../lib/prisma.js'
import { asyncHandler, ApiError } from '../lib/http.js'
import { suppress } from '../lib/suppressions.js'
import { userHasWorkspaceAccess } from '../lib/workspaces.js'
import type { AuthedRequest } from '../types/auth.js'

export const unsubscribeRouter = Router()

// Public — no auth. Linked from every outreach email footer.
unsubscribeRouter.get(
  '/:token',
  asyncHandler(async (req, res) => {
    const token = String(req.params.token || '').trim()
    if (!token) throw new ApiError(400, 'Token required')

    const record = await prisma.outreachSent.findUnique({
      where: { unsubscribeToken: token },
      select: { id: true, toEmail: true, workspaceId: true }
    })

    if (!record) throw new ApiError(404, 'Unsubscribe link not found')

    await suppress(record.workspaceId, record.toEmail, 'UNSUBSCRIBED')

    res.json({
      ok: true,
      message: `${record.toEmail} has been unsubscribed and will not receive further outreach from this workspace.`
    })
  })
)

// Authenticated owners only — suppression list management
unsubscribeRouter.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const workspaceId = String(req.query.workspaceId || '').trim()
    if (!workspaceId) throw new ApiError(400, 'workspaceId required')

    const userId = (req as AuthedRequest).user.id
    if (!await userHasWorkspaceAccess(userId, workspaceId)) throw new ApiError(403, 'Access denied')

    const suppressions = await prisma.suppression.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' }
    })
    res.json({ suppressions })
  })
)
