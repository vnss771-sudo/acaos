import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireVerifiedForMutation } from '../middleware/auth.js'
import { asyncHandler, ApiError, requireUser } from '../lib/http.js'
import { prisma } from '@acaos/backend-core/lib/prisma.js'
import { userBelongsToWorkspace } from '../lib/workspaces.js'
import { parseQuery, parseBody, parseParams, workspaceIdField } from '../lib/validate.js'
import { sendMail, isMailConfigured } from '../services/mail.js'
import { recordAudit } from '@acaos/backend-core/lib/audit.js'

// GET /api/inbox — the replies surface. Lists sends that received a reply, with
// the AI-derived classification metadata stamped on by the analyze-reply worker.
// POST /api/inbox/reply/:replyId/send — send an AI-suggested reply to the original sender
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

const replyParamsSchema = z.object({
  replyId: z.string().uuid(),
})

const sendReplySchema = z.object({
  workspaceId: workspaceIdField,
  // Optional: use custom body instead of suggestion
  customBody: z.string().min(1).max(5000).optional(),
})

inboxRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
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

// POST /api/inbox/reply/:replyId/send — send a reply to the original sender.
// Accepts either the suggested reply (replySuggestedAction) or a custom body.
// Creates audit trail. This is the Inbox Assistant core flow.
// Returns: { success: true, sentAt: ISO string, message: string }
inboxRouter.post(
  '/reply/:replyId/send',
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
    const { replyId } = parseParams(replyParamsSchema, req)
    const { workspaceId, customBody } = parseBody(sendReplySchema, req)

    const member = await userBelongsToWorkspace(user.id, workspaceId)
    if (!member) throw new ApiError(403, 'Access denied')

    const reply = await prisma.outreachSent.findUnique({
      where: { id: replyId },
      select: {
        id: true,
        workspaceId: true,
        toEmail: true,
        subject: true,
        replySuggestedAction: true,
        repliedAt: true,
        status: true,
        lead: { select: { id: true, businessName: true } },
      },
    })

    if (!reply) throw new ApiError(404, 'Reply not found')
    if (reply.workspaceId !== workspaceId) throw new ApiError(403, 'Reply belongs to different workspace')
    if (reply.status !== 'REPLIED') throw new ApiError(400, 'Can only send replies to messages that have received a reply')

    // Ensure mail is configured
    if (!isMailConfigured()) {
      throw new ApiError(503, 'Email service not configured for this workspace')
    }

    // Use custom body or fall back to suggestion
    const replyBody = customBody || reply.replySuggestedAction || 'Thank you for your reply.'
    const replySubject = reply.subject?.startsWith('Re:') ? reply.subject : `Re: ${reply.subject || '(no subject)'}`

    // Send the reply email
    try {
      await sendMail(reply.toEmail, replySubject, replyBody)
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Email service error'
      // Classify errors for better user messaging
      let statusCode = 502
      let userMessage = `Failed to send reply: ${errorMsg}`

      if (errorMsg.includes('invalid email') || errorMsg.includes('malformed')) {
        statusCode = 400
        userMessage = `Invalid recipient email address: ${reply.toEmail}`
      } else if (errorMsg.includes('timeout') || errorMsg.includes('ECONNREFUSED')) {
        statusCode = 503
        userMessage = 'Email service temporarily unavailable. Please try again.'
      }

      throw new ApiError(statusCode, userMessage)
    }

    const sentAt = new Date()

    // Audit trail (for compliance + learning)
    await recordAudit({
      workspaceId,
      actorUserId: user.id,
      type: 'inbox.reply_sent',
      entityType: 'outreachSent',
      entityId: replyId,
      metadata: {
        toEmail: reply.toEmail,
        hasCustomBody: !!customBody,
        replyClassification: reply.replySuggestedAction ? 'suggested' : 'custom',
      },
    })

    res.json({
      success: true,
      sentAt: sentAt.toISOString(),
      message: `✓ Reply sent to ${reply.toEmail}`,
    })
  })
)
