import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireVerifiedForMutation } from '../middleware/auth.js'
import { asyncHandler, ApiError, requireUser } from '../lib/http.js'
import { prisma } from '@acaos/backend-core/lib/prisma.js'
import { userBelongsToWorkspace } from '../lib/workspaces.js'
import { parseQuery, parseBody, parseParams, workspaceIdField, idField } from '../lib/validate.js'
import { sendMail, isMailConfigured } from '../services/mail.js'
import { recordAudit } from '@acaos/backend-core/lib/audit.js'
import { isSuppressed } from '@acaos/backend-core/lib/suppressions.js'
import { contactEventData } from '@acaos/backend-core/lib/contactEvents.js'
import { escapeHtml } from '../lib/html.js'

// GET /api/inbox — the replies surface. Lists sends that received a reply, with
// the AI-derived classification metadata stamped on by the analyze-reply worker.
// POST /api/inbox/reply/:replyId/send — send a user-written reply to the original sender
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

// OutreachSent.id is a Prisma cuid(), not a UUID — idField (not .uuid()) is
// what matches real ids here.
const replyParamsSchema = z.object({
  replyId: idField,
})

const sendReplySchema = z.object({
  workspaceId: workspaceIdField,
  // The reply text the user wrote or approved. Required: there is no server-side
  // fallback copy (see the send route).
  body: z.string().trim().min(1).max(5000),
  // Client-generated per compose session (e.g. crypto.randomUUID()); a retry
  // with the same key never sends twice.
  idempotencyKey: z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/),
})

const classificationFeedbackSchema = z.object({
  workspaceId: workspaceIdField,
  feedback: z.enum(['correct', 'incorrect', 'unsure']),
  correctedIntent: z.enum(REPLY_CLASSIFICATIONS).optional(),
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

// POST /api/inbox/reply/:replyId/send — send a human-written reply to the
// prospect who answered a campaign send. This is the Inbox Assistant core flow.
//
// The body is ALWAYS what the user wrote (or approved) in the composer. The
// stored replySuggestedAction is an internal next-step note addressed to the
// user ("Propose three call slots this week."), never prospect-facing copy, so it
// is never sent — the route used to fall back to it (and then to a canned
// "Thank you for your reply."), emailing internal notes to real prospects.
//
// Guardrails mirror the campaign sender:
//  - sends through the WORKSPACE mailbox only (never the platform SMTP_FROM), so
//    the reply comes from the address the prospect wrote back to;
//  - blocks suppressed recipients (unsubscribed / bounced / complained) and
//    operator-suspended workspaces;
//  - claim-first on (workspaceId, idempotencyKey) so a double-click or network
//    retry can't send twice;
//  - threads the reply (In-Reply-To / References) onto the prospect's message;
//  - records a SENT ContactEvent in the contact ledger plus an audit event.
// Returns: { success: true, sentAt: ISO string, message: string, duplicate?: true }
export function createInboxReplySendHandler(deps: { sendMail?: typeof sendMail } = {}) {
  const sendMailFn = deps.sendMail ?? sendMail
  return asyncHandler(async (req, res) => {
    const user = requireUser(req)
    const { replyId } = parseParams(replyParamsSchema, req)
    const { workspaceId, body, idempotencyKey } = parseBody(sendReplySchema, req)

    const member = await userBelongsToWorkspace(user.id, workspaceId)
    if (!member) throw new ApiError(403, 'Access denied')

    const reply = await prisma.outreachSent.findUnique({
      where: { id: replyId },
      select: {
        id: true,
        workspaceId: true,
        leadId: true,
        campaignId: true,
        toEmail: true,
        subject: true,
        messageId: true,
        status: true,
      },
    })

    if (!reply) throw new ApiError(404, 'Reply not found')
    if (reply.workspaceId !== workspaceId) throw new ApiError(403, 'Reply belongs to different workspace')
    if (reply.status !== 'REPLIED') throw new ApiError(400, 'Can only send replies to messages that have received a reply')

    // A retry of a request that already went out answers with the original
    // result instead of sending again (checked before the send-time gates so a
    // retry after e.g. a later unsubscribe still reports what actually happened).
    const prior = await prisma.inboxReplySend.findUnique({
      where: { workspaceId_idempotencyKey: { workspaceId, idempotencyKey } },
      select: { outreachSentId: true, status: true, sentAt: true },
    })
    if (prior && prior.outreachSentId !== reply.id) throw new ApiError(409, 'Idempotency key already used for a different reply')
    if (prior?.status === 'SENT') return res.json(sentResponse(reply.toEmail, prior.sentAt, true))
    if (prior?.status === 'SENDING') throw new ApiError(409, 'This reply is already being sent')

    const [smtpCfg, workspace] = await Promise.all([
      prisma.workspaceEmailConfig.findUnique({ where: { workspaceId } }),
      prisma.workspace.findUnique({ where: { id: workspaceId }, select: { sendSuppressed: true } }),
    ])
    if (workspace?.sendSuppressed) throw new ApiError(403, 'Sending is suspended for this workspace')
    // Workspace mailbox only: falling back to the platform SMTP would send the
    // reply from our address, not the one the prospect wrote back to.
    if (!isMailConfigured(smtpCfg)) {
      throw new ApiError(409, 'Workspace mailbox not configured — connect your sending mailbox in Settings before replying')
    }
    if (await isSuppressed(workspaceId, reply.toEmail)) {
      throw new ApiError(409, 'This recipient has unsubscribed or is suppressed — reply not sent')
    }

    const replySubject = /^re:/i.test(reply.subject ?? '') ? reply.subject! : `Re: ${reply.subject || '(no subject)'}`

    // Claim first. A FAILED prior attempt with the same key is re-claimed
    // atomically; a concurrent duplicate loses on the unique key.
    if (prior?.status === 'FAILED') {
      const reclaimed = await prisma.inboxReplySend.updateMany({
        where: { workspaceId, idempotencyKey, status: 'FAILED' },
        data: { status: 'SENDING', body, subject: replySubject, actorUserId: user.id, lastError: null },
      })
      if (reclaimed.count === 0) throw new ApiError(409, 'This reply is already being sent')
    } else {
      try {
        await prisma.inboxReplySend.create({
          data: {
            workspaceId,
            outreachSentId: reply.id,
            idempotencyKey,
            actorUserId: user.id,
            toEmail: reply.toEmail,
            subject: replySubject,
            body,
          },
        })
      } catch (err) {
        if ((err as { code?: string })?.code === 'P2002') throw new ApiError(409, 'This reply is already being sent')
        throw err
      }
    }

    const headers = await threadingHeaders(workspaceId, reply.id, reply.messageId)

    let info: unknown
    try {
      info = await sendMailFn(reply.toEmail, replySubject, plainTextToHtml(body), smtpCfg, { text: body, headers })
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Email service error'
      await prisma.inboxReplySend.updateMany({
        where: { workspaceId, idempotencyKey, status: 'SENDING' },
        data: { status: 'FAILED', lastError: errorMsg.slice(0, 500) },
      }).catch(() => {})
      // SSRF / validation rejections of the workspace SMTP host are already
      // user-facing ApiErrors.
      if (err instanceof ApiError) throw err
      // Classify by nodemailer's actual error shape (err.code / err.responseCode),
      // not by guessing substrings of err.message — the SMTP server's own text
      // ("Recipient address rejected", "550 User unknown", etc.) never contains
      // literal words like "invalid email" or "malformed".
      const code = (err as { code?: string })?.code
      const responseCode = (err as { responseCode?: number })?.responseCode
      let statusCode = 502
      let userMessage = `Failed to send reply: ${errorMsg}`

      if (code === 'EENVELOPE' || (responseCode !== undefined && responseCode >= 550 && responseCode < 560)) {
        statusCode = 400
        userMessage = `Invalid recipient email address: ${reply.toEmail}`
      } else if (code === 'ETIMEDOUT' || code === 'ECONNECTION' || (responseCode !== undefined && responseCode >= 400 && responseCode < 500)) {
        statusCode = 503
        userMessage = 'Email service temporarily unavailable. Please try again.'
      }

      throw new ApiError(statusCode, userMessage)
    }

    const sentAt = new Date()
    const msgId = (info as { messageId?: string } | undefined)?.messageId ?? null
    await prisma.$transaction([
      prisma.inboxReplySend.updateMany({
        where: { workspaceId, idempotencyKey },
        data: { status: 'SENT', sentAt, messageId: msgId },
      }),
      // campaignId stays off the ledger row: CampaignDailyStats rebuilds and the
      // reconciliation sweep count every campaign-tagged SENT event as a campaign
      // send, and a conversational reply isn't one. The link lives in metadata.
      prisma.contactEvent.create({
        data: contactEventData({
          workspaceId,
          email: reply.toEmail,
          type: 'SENT',
          leadId: reply.leadId,
          outreachSentId: reply.id,
          occurredAt: sentAt,
          metadata: { source: 'inbox_reply', campaignId: reply.campaignId },
        }),
      }),
    ])

    await recordAudit({
      workspaceId,
      actorUserId: user.id,
      type: 'inbox.reply_sent',
      entityType: 'outreachSent',
      entityId: replyId,
      metadata: { toEmail: reply.toEmail, messageId: msgId },
    })

    res.json(sentResponse(reply.toEmail, sentAt, false))
  })
}

function sentResponse(toEmail: string, sentAt: Date | null, duplicate: boolean) {
  return {
    success: true,
    sentAt: (sentAt ?? new Date()).toISOString(),
    message: `✓ Reply sent to ${toEmail}`,
    ...(duplicate ? { duplicate: true } : {}),
  }
}

// Message-IDs arrive from SMTP servers / IMAP envelopes; only pass through
// well-formed ids so nothing odd (whitespace, CR/LF) reaches a header.
function normalizeMessageId(id: string | null | undefined): string | null {
  if (!id) return null
  const trimmed = id.trim()
  const wrapped = trimmed.startsWith('<') ? trimmed : `<${trimmed}>`
  return /^<[^<>\s]+>$/.test(wrapped) ? wrapped : null
}

// Thread the reply onto the conversation: In-Reply-To is the prospect's latest
// message (recorded by the mailbox sync when it matched their reply to this
// send), and References walks back through our original send and any earlier
// Inbox replies on the same thread. Falls back to our original send's id.
async function threadingHeaders(
  workspaceId: string,
  outreachSentId: string,
  originalMessageId: string | null,
): Promise<Record<string, string> | undefined> {
  const [inbound, priorReplies] = await Promise.all([
    prisma.processedEmail.findMany({
      where: { workspaceId, matchedOutreachSentId: outreachSentId, messageId: { not: null } },
      orderBy: { processedAt: 'asc' },
      select: { messageId: true, processedAt: true },
      take: 20,
    }),
    prisma.inboxReplySend.findMany({
      where: { workspaceId, outreachSentId, status: 'SENT', messageId: { not: null } },
      orderBy: { sentAt: 'asc' },
      select: { messageId: true, sentAt: true },
      take: 20,
    }),
  ])
  const thread = [
    ...inbound.map(m => ({ id: m.messageId, at: m.processedAt })),
    ...priorReplies.map(m => ({ id: m.messageId, at: m.sentAt ?? new Date(0) })),
  ].sort((a, b) => a.at.getTime() - b.at.getTime())

  const refs: string[] = []
  for (const id of [originalMessageId, ...thread.map(t => t.id)]) {
    const n = normalizeMessageId(id)
    if (n && !refs.includes(n)) refs.push(n)
  }
  if (refs.length === 0) return undefined
  const latestInbound = normalizeMessageId(inbound.at(-1)?.messageId)
  return { 'In-Reply-To': latestInbound ?? refs[refs.length - 1], References: refs.join(' ') }
}

// The composer is plain text; render it as escaped HTML with line breaks kept.
function plainTextToHtml(text: string): string {
  return `<div>${escapeHtml(text).replace(/\r?\n/g, '<br>')}</div>`
}

inboxRouter.post('/reply/:replyId/send', createInboxReplySendHandler())

// PATCH /api/inbox/reply/:replyId/feedback — record user feedback on classification
// This feeds the learning loop to improve future classifications.
// Returns: { success: true, message: string }
inboxRouter.patch(
  '/reply/:replyId/feedback',
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
    const { replyId } = parseParams(replyParamsSchema, req)
    const { workspaceId, feedback, correctedIntent } = parseBody(classificationFeedbackSchema, req)

    const member = await userBelongsToWorkspace(user.id, workspaceId)
    if (!member) throw new ApiError(403, 'Access denied')

    const reply = await prisma.outreachSent.findUnique({
      where: { id: replyId },
      select: {
        id: true,
        workspaceId: true,
        replyIntent: true,
        replyConfidence: true,
        status: true,
      },
    })

    if (!reply) throw new ApiError(404, 'Reply not found')
    if (reply.workspaceId !== workspaceId) throw new ApiError(403, 'Reply belongs to different workspace')
    if (reply.status !== 'REPLIED') throw new ApiError(400, 'Can only provide feedback on messages with replies')

    // Record the feedback as metadata for the learning loop
    const correctedIntentValue = feedback === 'incorrect' ? correctedIntent : null
    const feedbackMessage = feedback === 'correct'
      ? 'Classification marked as correct'
      : feedback === 'incorrect'
        ? `Classification corrected to ${correctedIntentValue || reply.replyIntent}`
        : 'Classification marked as uncertain'

    // Record audit trail for feedback
    await recordAudit({
      workspaceId,
      actorUserId: user.id,
      type: 'inbox.classification_feedback',
      entityType: 'outreachSent',
      entityId: replyId,
      metadata: {
        originalIntent: reply.replyIntent,
        correctedIntent: correctedIntentValue,
        feedback,
        confidence: reply.replyConfidence,
      },
    })

    res.json({
      success: true,
      message: feedbackMessage,
    })
  })
)
