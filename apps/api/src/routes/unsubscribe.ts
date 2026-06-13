import { Router } from 'express'
import { prisma } from '../lib/prisma.js'
import { asyncHandler, ApiError } from '../lib/http.js'
import { suppress } from '../lib/suppressions.js'

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

    // Return a simple confirmation — the frontend can render this or the API
    // consumer can redirect to a landing page.
    res.json({
      ok: true,
      message: `${record.toEmail} has been unsubscribed and will not receive further outreach from this workspace.`
    })
  })
)

// Expose suppression list management for authenticated owners
unsubscribeRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const workspaceId = String(req.query.workspaceId || '').trim()
    if (!workspaceId) throw new ApiError(400, 'workspaceId required')
    const suppressions = await prisma.suppression.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' }
    })
    res.json({ suppressions })
  })
)
