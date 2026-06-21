import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireVerifiedForMutation } from '../middleware/auth.js'
import { asyncHandler, ApiError } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import { userBelongsToWorkspace } from '../lib/workspaces.js'
import { parseQuery, workspaceIdField } from '../lib/validate.js'

// GET /api/inbox — the replies surface. Lists sends that received a reply, with
// the AI-derived classification metadata stamped on by the analyze-reply worker.
// Read-only; the raw inbound body is never stored, so only derived fields here.
export const inboxRouter = Router()
inboxRouter.use(requireAuth)
inboxRouter.use(requireVerifiedForMutation)

const REPLY_CLASSIFICATIONS = [
  'INTERESTED', 'NOT_INTERESTED', 'NEEDS_MORE_INFO', 'NOT_NOW', 'OUT_OF_OFFICE', 'REFERRAL',
] as const

const inboxQuerySchema = z.object({
  workspaceId: workspaceIdField,
  // Optional filter by classification; 'all' (or omitted) returns everything.
  classification: z.enum(REPLY_CLASSIFICATIONS).optional(),
})

inboxRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const user = req.user!
    const { workspaceId, classification } = parseQuery(inboxQuerySchema, req)

    const member = await userBelongsToWorkspace(user.id, workspaceId)
    if (!member) throw new ApiError(403, 'Access denied')

    const replies = await prisma.outreachSent.findMany({
      where: {
        workspaceId,
        status: 'REPLIED',
        ...(classification ? { replyIntent: classification } : {}),
      },
      orderBy: { repliedAt: 'desc' },
      take: 100,
      select: {
        id: true,
        toEmail: true,
        subject: true,
        sentAt: true,
        repliedAt: true,
        replyIntent: true,
        replySummary: true,
        replyKeyQuote: true,
        replySuggestedAction: true,
        replyUrgency: true,
        replyConfidence: true,
        replyIsAutoReply: true,
        lead: { select: { id: true, businessName: true, stage: true } },
      },
    })

    // Counts per classification for the filter chips (whole workspace, not the
    // filtered page) so the UI can show how many of each await attention.
    const grouped = await prisma.outreachSent.groupBy({
      by: ['replyIntent'],
      where: { workspaceId, status: 'REPLIED' },
      _count: { _all: true },
    })
    const counts: Record<string, number> = {}
    let total = 0
    for (const g of grouped) {
      const n = g._count._all
      total += n
      if (g.replyIntent) counts[g.replyIntent] = n
    }

    res.json({ replies, counts, total })
  })
)
