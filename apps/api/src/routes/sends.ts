import { Router } from 'express'
import { z } from 'zod'
import { requireAuth } from '../middleware/auth.js'
import { asyncHandler, ApiError } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import { userBelongsToWorkspace } from '../lib/workspaces.js'
import { parseQuery, workspaceIdField } from '../lib/validate.js'

// GET /api/sends/summary — workspace-level outreach delivery health for the Radar
// Send Monitor, so live sending isn't invisible. Read-only; mirrors the
// tenant-scoping of /api/stats and /api/inbox.
export const sendsRouter = Router()
sendsRouter.use(requireAuth)

const summaryQuerySchema = z.object({ workspaceId: workspaceIdField })

sendsRouter.get(
  '/summary',
  asyncHandler(async (req, res) => {
    const user = req.user!
    const { workspaceId } = parseQuery(summaryQuerySchema, req)

    const member = await userBelongsToWorkspace(user.id, workspaceId)
    if (!member) throw new ApiError(403, 'Access denied')

    const grouped = await prisma.outreachSent.groupBy({
      by: ['status'],
      where: { workspaceId },
      _count: { _all: true },
    })
    const counts: Record<string, number> = {}
    for (const g of grouped) counts[g.status] = g._count._all

    const sent = counts.SENT ?? 0
    const replied = counts.REPLIED ?? 0
    const bounced = counts.BOUNCED ?? 0
    const failed = counts.FAILED ?? 0
    const sending = counts.SENDING ?? 0

    // "Delivered" mirrors the campaign-stats convention: SENT + REPLIED + BOUNCED
    // (a message that reached the MTA), excluding never-sent FAILED/SENDING.
    const delivered = sent + replied + bounced
    const replyRate = delivered > 0 ? Math.round((replied / delivered) * 1000) / 10 : 0

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const last24hSent = await prisma.outreachSent.count({
      where: { workspaceId, sentAt: { gte: since }, status: { in: ['SENT', 'REPLIED', 'BOUNCED'] } },
    })

    res.json({
      total: sent + replied + bounced + failed + sending,
      delivered,
      sent,
      replied,
      bounced,
      failed,
      sending,
      last24hSent,
      replyRate,
    })
  })
)
