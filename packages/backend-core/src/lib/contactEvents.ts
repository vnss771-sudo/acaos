import type { Prisma } from '@prisma/client'
import { prisma } from './prisma.js'
import { normalizeEmail } from './normalize.js'

// Append-only contact lifecycle ledger. The durable source of truth that
// contact-policy (recency / monthly cap), campaign stats, and forensic timelines
// read from — so they don't have to scan/interpret OutreachSent. emailKey is
// always normalized here so both writes and policy reads key on the same value.

export type ContactEventType = 'SENT' | 'REPLIED' | 'BOUNCED' | 'UNSUBSCRIBED' | 'FAILED'

export interface ContactEventInput {
  workspaceId: string
  email: string
  type: ContactEventType
  leadId?: string | null
  campaignId?: string | null
  outreachSentId?: string | null
  occurredAt?: Date
  metadata?: Record<string, unknown>
}

/**
 * Build the create-data for a ContactEvent (emailKey normalized). Pure — return it
 * to a `prisma.$transaction([...])` array so the ledger row commits atomically with
 * the lifecycle write it records (e.g. the SENT update), or pass to
 * recordContactEvent for a standalone best-effort write.
 */
export function contactEventData(input: ContactEventInput): Prisma.ContactEventCreateInput {
  return {
    workspace: { connect: { id: input.workspaceId } },
    emailKey: normalizeEmail(input.email),
    type: input.type,
    leadId: input.leadId ?? null,
    campaignId: input.campaignId ?? null,
    outreachSentId: input.outreachSentId ?? null,
    ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
    ...(input.metadata ? { metadata: input.metadata as Prisma.InputJsonValue } : {}),
  }
}

/** Standalone ledger write. Callers that aren't already in a transaction use this. */
export async function recordContactEvent(input: ContactEventInput): Promise<void> {
  await prisma.contactEvent.create({ data: contactEventData(input) })
}
