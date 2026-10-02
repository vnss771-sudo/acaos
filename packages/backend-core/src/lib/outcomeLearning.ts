// Closed-loop learning (phase 11): attribute each closed or stalled opportunity
// to a cause (outcomeCauses.ts) and record the repeated causes as one advisory
// LearningRecommendation (type OPPORTUNITY_CAUSE) for a human to review — one,
// because the schema allows a single PENDING proposal per type.
//
// Advisory only: approving one acknowledges it — nothing in the workspace's
// configuration changes (learningDecisions.ts). Proposals are always PENDING,
// in every mode including `live`; `off` does nothing at all.
//
// Like the scoring calibration, an identical PENDING proposal stays as-is; a
// different one is superseded by the fresh review (or by nothing, when no
// cause clears the bars any more).
import type { Prisma } from '@prisma/client'
import { prisma } from './prisma.js'
import { learningAdaptationMode, type LearningAdaptationMode } from './learningMode.js'
import { learningLoopMinOutcomes, sameJson } from './learningLoop.js'
import { loadCausedChains } from './outcomeGraphStore.js'
import {
  buildCauseProposal, summarizeCauses, OPPORTUNITY_CAUSE_TYPE,
  type CausedOpportunity, type OutcomeCause,
} from './outcomeCauses.js'

export type OutcomeLearningResult = {
  learned: boolean
  reason?: string
  attributed: number
  byCause: Record<OutcomeCause, number> | null
  /** Findings in the fresh proposal (0 when none was created). */
  findings: number
  proposed: number
  superseded: number
}

export async function learnFromOutcomes(
  workspaceId: string,
  opts: { now?: Date; mode?: LearningAdaptationMode; minSample?: number } = {},
): Promise<OutcomeLearningResult> {
  const mode = opts.mode ?? learningAdaptationMode()
  if (mode === 'off') return { learned: false, reason: 'learning disabled', attributed: 0, byCause: null, findings: 0, proposed: 0, superseded: 0 }
  const now = opts.now ?? new Date()

  const { items } = await loadCausedChains(workspaceId, { now })
  const caused: CausedOpportunity[] = items
    .filter(i => i.cause)
    .map(i => ({
      opportunityId: i.opportunity.id,
      cause: i.cause!.cause,
      eventType: i.opportunity.eventType,
      offerKey: i.opportunity.offerKey,
      buyingStage: i.opportunity.buyingStage,
    }))
  const summary = summarizeCauses(caused)
  const minSample = opts.minSample ?? learningLoopMinOutcomes()
  const draft = buildCauseProposal(caused, minSample)
  const drafts = draft ? [draft] : []

  const pending = await prisma.learningRecommendation.findMany({
    where: { workspaceId, status: 'PENDING', type: OPPORTUNITY_CAUSE_TYPE },
    select: { id: true, proposedValue: true },
  }) as Array<{ id: string; proposedValue: unknown }>
  const fresh = drafts.filter(d => !pending.some(p => sameJson(p.proposedValue, d.proposedValue)))
  const stale = pending.filter(p => !drafts.some(d => sameJson(p.proposedValue, d.proposedValue)))

  if (fresh.length || stale.length) {
    try {
      await prisma.$transaction(async (tx) => {
        if (stale.length) {
          await tx.learningRecommendation.updateMany({
            where: { workspaceId, status: 'PENDING', id: { in: stale.map(p => p.id) } },
            data: { status: 'SUPERSEDED', decidedAt: now, decidedBy: 'system' },
          })
        }
        for (const d of fresh) {
          await tx.learningRecommendation.create({
            data: {
              workspaceId,
              type: d.type,
              status: 'PENDING',
              proposedValue: d.proposedValue as unknown as Prisma.InputJsonValue,
              evidence: d.evidence as unknown as Prisma.InputJsonValue,
              sampleSize: d.sampleSize,
              mode,
            },
          })
        }
      })
    } catch (e) {
      // A concurrent run already left its PENDING review (one per type): keep it.
      if ((e as { code?: string }).code !== 'P2002') throw e
      return { learned: true, reason: 'a concurrent run proposed first', attributed: summary.total, byCause: summary.byCause, findings: 0, proposed: 0, superseded: 0 }
    }
  }

  return {
    learned: true,
    attributed: summary.total,
    byCause: summary.byCause,
    findings: fresh[0]?.proposedValue.findings.length ?? 0,
    proposed: fresh.length,
    superseded: stale.length,
  }
}
