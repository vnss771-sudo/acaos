// Stage 2 of the OutreachIntent bridge: when a Recommendation is created, also
// create an OutreachIntent (PROPOSED) carrying a point-in-time evidence snapshot
// — the auditable "what we knew when we recommended this". Best-effort by design:
// callers wrap it so a bridge write never breaks the primary recommendation path.
import { prisma } from './prisma.js'
import { freshnessState, signalEventAt, type SignalType } from './signalEngine.js'
import type { OutreachInput, IcpContext } from '../services/openai.js'
import { groundedSummary, type GroundingRecord } from './draftGrounding.js'

export type SnapshotSignal = {
  type: SignalType
  detectedAt: Date
  publishedAt?: Date | null
  title?: string | null
  source?: string | null
  evidenceSourceId?: string | null
}

/** Compact, auditable record of the signals that justified a recommendation. */
export function buildEvidenceSnapshot(signals: SnapshotSignal[]) {
  return {
    capturedAt: new Date().toISOString(),
    signalCount: signals.length,
    signals: signals.map((s) => {
      const eventAt = signalEventAt(s)
      return {
        type: s.type,
        title: s.title ?? null,
        source: s.source ?? null,
        detectedAt: s.detectedAt.toISOString(),
        publishedAt: s.publishedAt?.toISOString() ?? null,
        eventAt: eventAt.toISOString(),
        freshness: freshnessState({ type: s.type, detectedAt: eventAt }),
        hasEvidence: !!s.evidenceSourceId,
      }
    }),
  }
}

export type OutreachIntentOrigin = 'RECOMMENDATION' | 'ONBOARDING'

export async function createOutreachIntentForRecommendation(input: {
  workspaceId: string
  prospectId: string
  recommendationId: string
  messageAngle?: string | null
  channel?: string | null
  signals: SnapshotSignal[]
  missionId?: string | null
  campaignId?: string | null
  origin?: OutreachIntentOrigin
}) {
  return prisma.outreachIntent.create({
    data: {
      workspaceId: input.workspaceId,
      prospectId: input.prospectId,
      recommendationId: input.recommendationId,
      status: 'PROPOSED',
      origin: input.origin ?? 'RECOMMENDATION',
      messageAngle: input.messageAngle ?? null,
      channel: input.channel ?? null,
      evidenceSnapshot: buildEvidenceSnapshot(input.signals),
      missionId: input.missionId ?? null,
      campaignId: input.campaignId ?? null,
    },
  })
}

/**
 * Build the outreach-generation input from an intent's evidence context — the
 * "draft from evidence" path. The recommendation's reasoning becomes the
 * research summary; the intent's angle (or the recommendation's) is the hook;
 * industry comes from the prospect, never the seller's ICP.
 */
export function buildIntentDraftInput(args: {
  prospect: { companyName: string; industry?: string | null; contactName?: string | null; location?: string | null }
  recommendation?: { reasoning?: string | null; messageAngle?: string | null } | null
  intent: { messageAngle?: string | null }
  icp?: IcpContext
  /** An opportunity intent's grounding: the draft is written from its facts only. */
  grounding?: Pick<GroundingRecord, 'facts'> | null
}): OutreachInput {
  const facts = args.grounding?.facts ?? []
  return {
    businessName: args.prospect.companyName,
    category: args.prospect.industry ?? undefined,
    city: args.prospect.location ?? undefined,
    contactName: args.prospect.contactName ?? undefined,
    aiSummary: facts.length ? groundedSummary(facts) : args.recommendation?.reasoning ?? undefined,
    outreachAngle: args.intent.messageAngle ?? args.recommendation?.messageAngle ?? undefined,
    icp: args.icp,
  }
}
