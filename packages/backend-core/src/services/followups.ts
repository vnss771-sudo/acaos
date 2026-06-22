import type { Prisma, PrismaClient } from '@prisma/client'
import { prisma } from '../lib/prisma.js'

// Follow-up scheduling + cancellation. Centralized so every lifecycle path uses
// the same idempotent scheduling (the @@unique([campaignId, leadId, stepNumber])
// constraint is the real guard) and the same cancellation, rather than scattering
// follow-up logic across routes/workers.

type Db = PrismaClient | Prisma.TransactionClient

export type FollowupCancelReason =
  | 'REPLY_RECEIVED'
  | 'BOUNCE'
  | 'UNSUBSCRIBE'
  | 'LEAD_TERMINAL'
  | 'CAMPAIGN_PAUSED'
  | 'MISSION_PAUSED'

/**
 * After a send at `currentStep`, schedule the next active sequence step as a
 * FollowupTask — but ONLY when the campaign opted in (autoFollowupsEnabled). No-op
 * otherwise, so existing one-off campaigns are unaffected. Idempotent: the unique
 * (campaignId, leadId, stepNumber) constraint collapses a duplicate schedule
 * (P2002 swallowed). Returns the created task id, or null when nothing scheduled.
 */
export async function scheduleNextFollowup(input: {
  workspaceId: string
  campaignId: string
  leadId: string
  outreachSentId?: string | null
  currentStep: number
  sentAt: Date
  autoFollowupsEnabled: boolean
}): Promise<string | null> {
  if (!input.autoFollowupsEnabled) return null

  const nextStepNumber = input.currentStep + 1
  const step = await prisma.outreachSequenceStep.findUnique({
    where: { campaignId_stepNumber: { campaignId: input.campaignId, stepNumber: nextStepNumber } },
    select: { isActive: true, delayDays: true },
  })
  if (!step || !step.isActive) return null

  const scheduledFor = new Date(input.sentAt.getTime() + step.delayDays * 24 * 60 * 60 * 1000)

  try {
    const task = await prisma.followupTask.create({
      data: {
        workspaceId: input.workspaceId,
        campaignId: input.campaignId,
        leadId: input.leadId,
        outreachSentId: input.outreachSentId ?? null,
        stepNumber: nextStepNumber,
        status: 'SCHEDULED',
        scheduledFor,
      },
      select: { id: true },
    })
    return task.id
  } catch (err) {
    // A follow-up for this (campaign, lead, step) already exists — idempotent no-op.
    if ((err as { code?: string }).code === 'P2002') return null
    throw err
  }
}

/**
 * Cancel every still-pending (SCHEDULED) follow-up for a lead — on reply, bounce,
 * unsubscribe, terminal stage, or a campaign/mission pause. Accepts a tx client so
 * it can run in the SAME transaction as the event that triggers it (e.g. a reply),
 * guaranteeing a follow-up can never fire after the reply that should have stopped
 * it. Scoped to campaignId when given. Returns the number cancelled.
 */
export async function cancelPendingFollowups(
  client: Db,
  input: { workspaceId: string; leadId: string; campaignId?: string | null; reason: FollowupCancelReason }
): Promise<number> {
  const res = await client.followupTask.updateMany({
    where: {
      workspaceId: input.workspaceId,
      leadId: input.leadId,
      ...(input.campaignId ? { campaignId: input.campaignId } : {}),
      status: 'SCHEDULED',
    },
    data: { status: 'CANCELLED', cancelledReason: input.reason },
  })
  return res.count
}
