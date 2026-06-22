import type { Prisma } from '@prisma/client'

// Attribute an inbound reply to exactly ONE OutreachSent. Conservative by design:
// a wrong match is worse than no match, so we only fall back to email when the
// In-Reply-To header doesn't resolve, and we still pick a single deterministic
// row (the most recent send) rather than flipping every send for the contact.
//
// Token/thread matching (REPLY_TOKEN / THREAD_KEY) are intentionally omitted until
// outbound carries a reply-token hash / thread key; In-Reply-To → messageId plus
// the email fallback is the high-value core.

export type ReplyMatchMethod =
  | 'MESSAGE_ID'
  | 'EMAIL_UNIQUE'
  | 'MOST_RECENT_LEAD_SEND'
  | 'NO_MATCH'

export interface ReplyMatch {
  outreachSentId: string | null
  leadId: string | null
  campaignId: string | null
  toEmail: string | null
  method: ReplyMatchMethod
}

const SELECT = { id: true, leadId: true, campaignId: true, toEmail: true } as const

/**
 * Find the single OutreachSent a reply belongs to. Runs inside the caller's
 * transaction so the match and the REPLIED flip commit together.
 *   1. In-Reply-To header → OutreachSent.messageId (the only unambiguous signal).
 *   2. The sender's lead has SENT rows → the most recent one (EMAIL_UNIQUE when
 *      it's the only candidate, MOST_RECENT_LEAD_SEND when there were several so
 *      the ambiguity is recorded).
 *   3. Otherwise NO_MATCH (recorded, not guessed).
 */
export async function findBestMatchingOutreachSent(
  tx: Prisma.TransactionClient,
  input: { workspaceId: string; inReplyTo: string | null; leadId: string | null }
): Promise<ReplyMatch> {
  if (input.inReplyTo) {
    const byMsgId = await tx.outreachSent.findFirst({
      where: { workspaceId: input.workspaceId, messageId: input.inReplyTo },
      select: SELECT,
    })
    if (byMsgId) {
      return { outreachSentId: byMsgId.id, leadId: byMsgId.leadId, campaignId: byMsgId.campaignId, toEmail: byMsgId.toEmail, method: 'MESSAGE_ID' }
    }
  }

  if (input.leadId) {
    const sent = await tx.outreachSent.findMany({
      where: { workspaceId: input.workspaceId, leadId: input.leadId, status: 'SENT' },
      orderBy: { sentAt: 'desc' },
      take: 2,
      select: SELECT,
    })
    if (sent.length > 0) {
      const top = sent[0]
      return {
        outreachSentId: top.id,
        leadId: top.leadId,
        campaignId: top.campaignId,
        toEmail: top.toEmail,
        method: sent.length === 1 ? 'EMAIL_UNIQUE' : 'MOST_RECENT_LEAD_SEND',
      }
    }
  }

  return { outreachSentId: null, leadId: input.leadId, campaignId: null, toEmail: null, method: 'NO_MATCH' }
}
