// Stage 2 of the OutreachIntent bridge: when a Recommendation is created, also
// create an OutreachIntent (PROPOSED) carrying a point-in-time evidence snapshot
// — the auditable "what we knew when we recommended this". Best-effort by design:
// callers wrap it so a bridge write never breaks the primary recommendation path.
import { prisma } from './prisma.js'
import { freshnessState, type SignalType } from './signalEngine.js'

export type SnapshotSignal = {
  type: SignalType
  detectedAt: Date
  title?: string | null
  source?: string | null
  evidenceSourceId?: string | null
}

/** Compact, auditable record of the signals that justified a recommendation. */
export function buildEvidenceSnapshot(signals: SnapshotSignal[]) {
  return {
    capturedAt: new Date().toISOString(),
    signalCount: signals.length,
    signals: signals.map((s) => ({
      type: s.type,
      title: s.title ?? null,
      source: s.source ?? null,
      detectedAt: s.detectedAt.toISOString(),
      freshness: freshnessState({ type: s.type, detectedAt: s.detectedAt }),
      hasEvidence: !!s.evidenceSourceId,
    })),
  }
}

export async function createOutreachIntentForRecommendation(input: {
  workspaceId: string
  prospectId: string
  recommendationId: string
  messageAngle?: string | null
  channel?: string | null
  signals: SnapshotSignal[]
  missionId?: string | null
  campaignId?: string | null
}) {
  return prisma.outreachIntent.create({
    data: {
      workspaceId: input.workspaceId,
      prospectId: input.prospectId,
      recommendationId: input.recommendationId,
      status: 'PROPOSED',
      messageAngle: input.messageAngle ?? null,
      channel: input.channel ?? null,
      evidenceSnapshot: buildEvidenceSnapshot(input.signals),
      missionId: input.missionId ?? null,
      campaignId: input.campaignId ?? null,
    },
  })
}
