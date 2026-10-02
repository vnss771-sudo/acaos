// Signal calibration, loaders and proposals (phase 12).
//
// Builds the calibration report (signalCalibration.ts) from the workspace's
// outcome chains plus the commercial events detected at each company, and
// proposes event-kind weights as one EVENT_KIND_WEIGHT LearningRecommendation.
//
// Config-writing, but never automatic: the proposal is PENDING in every mode,
// `live` included; only a human approval (learningDecisions.ts, stale-safe and
// revertible) writes ScoringModel.eventKindWeights. `off` does nothing.
import type { Prisma } from '@prisma/client'
import { prisma } from './prisma.js'
import { learningAdaptationMode, type LearningAdaptationMode } from './learningMode.js'
import { sameJson } from './learningLoop.js'
import { loadCausedChains } from './outcomeGraphStore.js'
import { reachedStages } from './outcomeGraph.js'
import {
  buildCalibrationReport, proposeEventKindWeights,
  type CalibrationItem, type CalibrationReport,
} from './signalCalibration.js'

export const EVENT_KIND_WEIGHT_TYPE = 'EVENT_KIND_WEIGHT'

export async function loadCalibrationItems(workspaceId: string, opts: { now?: Date } = {}): Promise<CalibrationItem[]> {
  const now = opts.now ?? new Date()
  const { items } = await loadCausedChains(workspaceId, { now })
  if (items.length === 0) return []
  const prospectIds = [...new Set(items.map(i => i.opportunity.prospectId))]
  const events = await prisma.commercialEvent.findMany({
    where: { workspaceId, prospectId: { in: prospectIds } },
    select: { prospectId: true, kind: true, firstDetectedAt: true },
  }) as Array<{ prospectId: string; kind: string; firstDetectedAt: Date }>

  return items.map(({ chain, opportunity }) => {
    const finalNode = chain.final ? chain.nodes.filter(n => n.stage === chain.final).at(-1) : null
    // The kinds known at the company by the time it closed (or by now, if open).
    const cutoff = finalNode ? Date.parse(finalNode.at) : now.getTime()
    const kinds = events
      .filter(e => e.prospectId === opportunity.prospectId && e.firstDetectedAt.getTime() <= cutoff)
      .map(e => e.kind)
    return {
      opportunityId: opportunity.id,
      eventType: opportunity.eventType,
      eventKinds: [...new Set(kinds)].sort(),
      reached: [...reachedStages(chain)],
      final: chain.final,
      revenueCents: chain.revenueCents,
    }
  })
}

async function liveWeights(workspaceId: string): Promise<Record<string, number>> {
  const m = await prisma.scoringModel.findUnique({ where: { workspaceId }, select: { eventKindWeights: true } }) as { eventKindWeights: unknown } | null
  return (m?.eventKindWeights ?? {}) as Record<string, number>
}

/** The report plus the live weights and what would be proposed now. */
export async function loadCalibration(workspaceId: string, opts: { now?: Date; minClosed?: number } = {}): Promise<{
  report: CalibrationReport
  currentWeights: Record<string, number>
  proposedWeights: Record<string, number>
}> {
  const report = buildCalibrationReport(await loadCalibrationItems(workspaceId, opts), opts)
  const currentWeights = await liveWeights(workspaceId)
  const learned = proposeEventKindWeights(report, opts)
  // Kinds without enough data keep their approved weight.
  return { report, currentWeights, proposedWeights: Object.keys(learned).length ? { ...currentWeights, ...learned } : currentWeights }
}

export type CalibrationLearningResult = {
  learned: boolean
  reason?: string
  closed: number
  proposed: number
  superseded: number
}

export async function learnSignalCalibration(
  workspaceId: string,
  opts: { now?: Date; mode?: LearningAdaptationMode; minClosed?: number } = {},
): Promise<CalibrationLearningResult> {
  const mode = opts.mode ?? learningAdaptationMode()
  if (mode === 'off') return { learned: false, reason: 'learning disabled', closed: 0, proposed: 0, superseded: 0 }
  const now = opts.now ?? new Date()
  const { report, currentWeights, proposedWeights } = await loadCalibration(workspaceId, { now, minClosed: opts.minClosed })
  const changed = !sameJson(currentWeights, proposedWeights)

  const pending = await prisma.learningRecommendation.findMany({
    where: { workspaceId, status: 'PENDING', type: EVENT_KIND_WEIGHT_TYPE },
    select: { id: true, proposedValue: true, currentValue: true },
  }) as Array<{ id: string; proposedValue: unknown; currentValue: unknown }>
  const keep = changed && pending.some(p => sameJson(p.proposedValue, proposedWeights) && sameJson(p.currentValue, currentWeights))
  const stale = keep ? [] : pending
  const create = changed && !keep

  if (stale.length || create) {
    try {
      await prisma.$transaction(async (tx) => {
        if (stale.length) {
          await tx.learningRecommendation.updateMany({
            where: { workspaceId, status: 'PENDING', id: { in: stale.map(p => p.id) } },
            data: { status: 'SUPERSEDED', decidedAt: now, decidedBy: 'system' },
          })
        }
        if (create) {
          await tx.learningRecommendation.create({
            data: {
              workspaceId,
              type: EVENT_KIND_WEIGHT_TYPE,
              status: 'PENDING',
              currentValue: currentWeights as Prisma.InputJsonValue,
              proposedValue: proposedWeights as Prisma.InputJsonValue,
              evidence: {
                basis: `${report.won} wins in ${report.closed} closed opportunities`,
                totalOutcomes: report.closed,
                baselineWinRate: report.baselineWinRate,
                funnels: report.funnels,
                combinations: report.combinations.slice(0, 10),
              } as unknown as Prisma.InputJsonValue,
              sampleSize: report.closed,
              mode,
            },
          })
        }
      })
    } catch (e) {
      // A concurrent run already left its PENDING proposal (one per type): keep it.
      if ((e as { code?: string }).code !== 'P2002') throw e
      return { learned: true, reason: 'a concurrent run proposed first', closed: report.closed, proposed: 0, superseded: 0 }
    }
  }
  return { learned: true, closed: report.closed, proposed: create ? 1 : 0, superseded: stale.length }
}
