// Pure-DB queue processors, extracted from worker.ts so they can be unit-tested
// against a real database without instantiating BullMQ Workers (which connect to
// Redis on construction). worker.ts wires these into Workers; tests call them
// directly.

import { prisma } from '../../api/src/lib/prisma.js'
import { DEFAULT_SCORING_WEIGHTS } from '../../api/src/lib/scoring.js'
import {
  calculateOpportunityScores,
  detectBuyingStage,
  calcWinProbability,
  toRawSignal,
} from '../../api/src/lib/signalEngine.js'
import type { SignalWeights } from '../../api/src/lib/signalEngine.js'
import { calibrate } from '../../api/src/lib/learningLoop.js'

type Progress = (n: number) => unknown

/** Recompute opportunity scores for every prospect in a workspace. */
export async function scoreProspects(
  workspaceId: string,
  progress?: Progress
): Promise<{ workspaceId: string; updated: number }> {
  const prospects = await prisma.prospect.findMany({
    where: { workspaceId },
    include: { signals: true },
  })
  await progress?.(10)

  const [icp, scoringModel] = await Promise.all([
    prisma.workspaceICP.findUnique({ where: { workspaceId } }),
    prisma.scoringModel.findUnique({ where: { workspaceId }, select: { signalWeights: true } }),
  ])
  const signalWeights = (scoringModel?.signalWeights ?? null) as SignalWeights | null

  // Shape the raw WorkspaceICP record into the engine's ICPConfig (null → undefined).
  const icpConfig = icp
    ? {
        targetIndustries: icp.targetIndustries,
        minEmployees: icp.minEmployees ?? undefined,
        maxEmployees: icp.maxEmployees ?? undefined,
        targetGeos: icp.targetGeos,
        mustHaveEmail: icp.mustHaveEmail,
      }
    : undefined

  let updated = 0
  for (const prospect of prospects) {
    const rawSignals = prospect.signals.map(toRawSignal)
    const scores = calculateOpportunityScores(rawSignals, {
      industry: prospect.industry,
      employeeCount: prospect.employeeCount,
      contactEmail: prospect.contactEmail,
      contactName: prospect.contactName,
      domain: prospect.domain,
      location: prospect.location,
    }, icpConfig, signalWeights ?? undefined)
    const buyingStage = detectBuyingStage(rawSignals, scores.opportunityScore)
    const winProbability = calcWinProbability(buyingStage, scores.opportunityScore)
    await prisma.prospect.update({
      where: { id: prospect.id },
      data: { ...scores, buyingStage, winProbability },
    })
    updated++
  }

  await progress?.(100)
  return { workspaceId, updated }
}

/**
 * Recalibrate signal weights and the workspace ICP from WON/LOST prospect
 * outcomes. No-ops (returns uncalibrated stats) below the minimum sample size.
 */
export async function calibrateScoring(
  workspaceId: string,
  progress?: Progress
): Promise<{ calibrated: boolean; reason?: string; totalOutcomes: number; baselineWinRate: number }> {
  await progress?.(10)

  const rawOutcomes = await prisma.prospectOutcome.findMany({
    where: { workspaceId, stage: { in: ['WON', 'LOST'] } },
    include: { prospect: { include: { signals: true } } },
    orderBy: { recordedAt: 'desc' },
    take: 100,
  })
  await progress?.(30)

  const outcomes = rawOutcomes.map((o) => ({
    stage: o.stage as 'WON' | 'LOST',
    prospect: {
      industry: o.prospect.industry,
      employeeCount: o.prospect.employeeCount,
      signals: o.prospect.signals.map((s) => ({ type: s.type })),
    },
  }))

  const result = calibrate(outcomes)
  await progress?.(60)

  if (!result.stats.calibrated) {
    return result.stats
  }

  const performanceMetrics = {
    totalOutcomes: result.stats.totalOutcomes,
    winRate: result.stats.baselineWinRate,
    calibratedAt: new Date().toISOString(),
  }

  await prisma.scoringModel.upsert({
    where: { workspaceId },
    create: {
      workspaceId,
      weights: DEFAULT_SCORING_WEIGHTS,
      signalWeights: result.signalWeights,
      performanceMetrics,
    },
    update: {
      signalWeights: result.signalWeights,
      lastWeightUpdate: new Date(),
      updateCount: { increment: 1 },
      performanceMetrics,
    },
  })
  await progress?.(80)

  if (Object.keys(result.icpUpdate).length > 0) {
    await prisma.workspaceICP.upsert({
      where: { workspaceId },
      create: {
        workspaceId,
        targetIndustries: result.icpUpdate.targetIndustries ?? [],
        minEmployees: result.icpUpdate.minEmployees ?? 1,
        maxEmployees: result.icpUpdate.maxEmployees ?? 999999,
        targetGeos: [],
        mustHaveEmail: false,
      },
      update: {
        ...(result.icpUpdate.targetIndustries && { targetIndustries: result.icpUpdate.targetIndustries }),
        ...(result.icpUpdate.minEmployees !== undefined && { minEmployees: result.icpUpdate.minEmployees }),
        ...(result.icpUpdate.maxEmployees !== undefined && { maxEmployees: result.icpUpdate.maxEmployees }),
      },
    })
  }

  await progress?.(100)
  return result.stats
}
