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
import { contactEventData, recordContactEvent } from '@acaos/backend-core/lib/contactEvents.js'
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

const resolveParamsSchema = z.object({
  replyId: idField,
  sendId: idField,
})

const resolveSendSchema = z.object({
  workspaceId: workspaceIdField,
  outcome: z.enum(['sent', 'not_sent']),
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
        // An open (SENDING) Inbox reply on this thread, if any — the UI shows it
        // as in flight or, past the window, asks the user to resolve it.
        inboxReplySends: {
          where: { workspaceId, status: 'SENDING' },
          orderBy: { attemptedAt: 'desc' },
          take: 1,
          select: { id: true, attemptedAt: true, body: true },
        },
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

    const now = Date.now()
    res.json({
      replies: replies.map(({ inboxReplySends, ...r }) => {
        const open = inboxReplySends[0]
        return {
          ...r,
          pendingSend: open
            ? {
                id: open.id,
                attemptedAt: open.attemptedAt.toISOString(),
                outcomeUnknown: now - open.attemptedAt.getTime() >= INBOX_SEND_IN_FLIGHT_MS,
                bodyPreview: open.body.slice(0, 200),
              }
            : null,
        }
      }),
      counts,
      total,
    })
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
//  - at most one open (SENDING) reply per thread, whatever the key: claims are
//    serialized on the OutreachSent row, and a SENDING row past the in-flight
//    window is "outcome unknown" (the provider may have accepted it) and blocks
//    further replies until a person resolves it — never auto-resent;
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
      select: { outreachSentId: true, status: true, sentAt: true, attemptedAt: true },
    })
    if (prior && prior.outreachSentId !== reply.id) throw new ApiError(409, 'Idempotency key already used for a different reply')
    if (prior?.status === 'SENT') return res.json(sentResponse(reply.toEmail, prior.sentAt, true))
    if (prior?.status === 'SENDING') throw openSendError(prior.attemptedAt)

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

    // Subject is folded to one line and length-capped: CR/LF must never reach a
    // header, and RFC 5322 caps a line at 998 chars.
    const baseSubject = (reply.subject ?? '').replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, 900)
    const replySubject = /^re:/i.test(baseSubject) ? baseSubject : `Re: ${baseSubject || '(no subject)'}`

    // Claim first, serialized per thread: lock the OutreachSent row so two
    // requests with DIFFERENT keys can't both pass the open-send check. Any
    // SENDING row on the thread blocks — in flight, or outcome unknown after a
    // crash / post-acceptance DB failure — so a fresh key can never re-send a
    // reply that may already have been delivered. A FAILED prior attempt with
    // the same key is re-claimed.
    try {
      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "OutreachSent" WHERE "id" = ${reply.id} FOR UPDATE`
        const open = await tx.inboxReplySend.findFirst({
          where: { workspaceId, outreachSentId: reply.id, status: 'SENDING' },
          orderBy: { attemptedAt: 'desc' },
          select: { attemptedAt: true },
        })
        if (open) throw openSendError(open.attemptedAt)
        if (prior?.status === 'FAILED') {
          const reclaimed = await tx.inboxReplySend.updateMany({
            where: { workspaceId, idempotencyKey, status: 'FAILED' },
            data: { status: 'SENDING', body, subject: replySubject, actorUserId: user.id, lastError: null, attemptedAt: new Date() },
          })
          if (reclaimed.count === 0) throw new ApiError(409, IN_FLIGHT_MESSAGE)
        } else {
          await tx.inboxReplySend.create({
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
        }
      })
    } catch (err) {
      if ((err as { code?: string })?.code === 'P2002') throw new ApiError(409, IN_FLIGHT_MESSAGE)
      throw err
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

    // From here the provider has ACCEPTED the message: it is out, and nothing
    // below may turn that into an error response (the user would retry and send
    // it twice). Finalize atomically; if that fails, fall back to recording just
    // the SENT status so the thread isn't blocked. If even that fails the row
    // stays SENDING, becomes "outcome unknown", and blocks further replies on the
    // thread until someone resolves it — fail-closed, never auto-resent.
    const sentAt = new Date()
    const msgId = (info as { messageId?: string } | undefined)?.messageId ?? null
    const ledgerEvent = {
      workspaceId,
      email: reply.toEmail,
      type: 'SENT' as const,
      leadId: reply.leadId,
      outreachSentId: reply.id,
      occurredAt: sentAt,
      metadata: { source: 'inbox_reply', campaignId: reply.campaignId },
    }
    try {
      await prisma.$transaction([
        prisma.inboxReplySend.updateMany({
          where: { workspaceId, idempotencyKey },
          data: { status: 'SENT', sentAt, messageId: msgId },
        }),
        // campaignId stays off the ledger row: CampaignDailyStats rebuilds and the
        // reconciliation sweep count every campaign-tagged SENT event as a campaign
        // send, and a conversational reply isn't one. The link lives in metadata.
        prisma.contactEvent.create({ data: contactEventData(ledgerEvent) }),
      ])
    } catch (err) {
      console.error(`[inbox] reply ${replyId} accepted by SMTP (${msgId ?? 'no message-id'}) but finalize failed: ${err instanceof Error ? err.message : err}`)
      const marked = await prisma.inboxReplySend.updateMany({
        where: { workspaceId, idempotencyKey, status: 'SENDING' },
        data: { status: 'SENT', sentAt, messageId: msgId },
      }).catch(() => null)
      if (marked?.count) await recordContactEvent(ledgerEvent).catch(() => {})
      else console.error(`[inbox] reply ${replyId} left SENDING after SMTP acceptance — needs resolution before the thread can be replied to again`)
    }

    await recordAudit({
      workspaceId,
      actorUserId: user.id,
      type: 'inbox.reply_sent',
      entityType: 'outreachSent',
      entityId: replyId,
      metadata: { toEmail: reply.toEmail, messageId: msgId },
    }).catch(() => {})

    res.json(sentResponse(reply.toEmail, sentAt, false))
  })
}

// A SENDING claim younger than this is treated as a live request; older, its
// outcome is unknown. Comfortably above the worst-case SMTP send (connection 15s
// + greeting 10s + socket idle 20s per step, plus DNS pinning).
export const INBOX_SEND_IN_FLIGHT_MS = 5 * 60_000
const IN_FLIGHT_MESSAGE = 'A reply on this thread is already being sent'
const OUTCOME_UNKNOWN_MESSAGE =
  'A previous reply on this thread may already have been delivered. Check your mailbox\'s Sent folder, then mark it as sent or not sent before replying again.'

function openSendError(attemptedAt: Date): ApiError {
  return Date.now() - attemptedAt.getTime() < INBOX_SEND_IN_FLIGHT_MS
    ? new ApiError(409, IN_FLIGHT_MESSAGE)
    : new ApiError(409, OUTCOME_UNKNOWN_MESSAGE)
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

// POST /api/inbox/reply/:replyId/sends/:sendId/resolve — a person settles a reply
// whose outcome is unknown (SENDING past the in-flight window: the process died,
// or the DB failed after the provider accepted it). Only they can check the
// mailbox's Sent folder. 'sent' records it as delivered (status + contact
// ledger); 'not_sent' marks it FAILED. Either unblocks the thread. A claim still
// inside the in-flight window can't be resolved (its request may yet finish).
// Returns: { success: true, status: 'SENT' | 'FAILED' }
inboxRouter.post(
  '/reply/:replyId/sends/:sendId/resolve',
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
    const { replyId, sendId } = parseParams(resolveParamsSchema, req)
    const { workspaceId, outcome } = parseBody(resolveSendSchema, req)

    const member = await userBelongsToWorkspace(user.id, workspaceId)
    if (!member) throw new ApiError(403, 'Access denied')

    const send = await prisma.inboxReplySend.findFirst({
      where: { id: sendId, workspaceId, outreachSentId: replyId },
      select: { id: true, status: true, attemptedAt: true, toEmail: true, messageId: true, outreachSent: { select: { leadId: true, campaignId: true } } },
    })
    if (!send) throw new ApiError(404, 'Reply send not found')

    const target = outcome === 'sent' ? 'SENT' : 'FAILED'
    if (send.status === target) return res.json({ success: true, status: target })
    if (send.status !== 'SENDING') throw new ApiError(409, `This reply is already marked ${send.status === 'SENT' ? 'sent' : 'not sent'}`)
    if (Date.now() - send.attemptedAt.getTime() < INBOX_SEND_IN_FLIGHT_MS) throw new ApiError(409, IN_FLIGHT_MESSAGE)

    const now = new Date()
    const claim = prisma.inboxReplySend.updateMany({
      where: { id: send.id, workspaceId, status: 'SENDING' },
      data: outcome === 'sent'
        ? { status: 'SENT', sentAt: now, resolvedByUserId: user.id }
        : { status: 'FAILED', lastError: 'Resolved as not sent', resolvedByUserId: user.id },
    })
    const [updated] = outcome === 'sent'
      ? await prisma.$transaction([claim, prisma.contactEvent.create({
          data: contactEventData({
            workspaceId,
            email: send.toEmail,
            type: 'SENT',
            leadId: send.outreachSent.leadId,
            outreachSentId: replyId,
            occurredAt: send.attemptedAt,
            metadata: { source: 'inbox_reply', campaignId: send.outreachSent.campaignId, resolved: true },
          }),
        })])
      : await prisma.$transaction([claim])
    if (updated.count === 0) throw new ApiError(409, 'This reply was resolved by someone else')

    await recordAudit({
      workspaceId,
      actorUserId: user.id,
      type: 'inbox.reply_send_resolved',
      entityType: 'outreachSent',
      entityId: replyId,
      metadata: { sendId: send.id, outcome },
    })

    res.json({ success: true, status: target })
  })
)

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
