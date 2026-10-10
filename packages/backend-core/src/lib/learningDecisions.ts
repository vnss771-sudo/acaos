// Human decisions on LearningRecommendations: approve, reject, revert.
//
// This is the ONLY path by which a learning proposal changes a workspace's
// strategy, and it always carries a human actor. Safety properties:
//   - Race-safe: every transition is a conditional status update, so a
//     double-click or two admins deciding at once apply a change at most once.
//   - Stale-safe: approve applies only if the live config still equals the
//     proposal's recorded currentValue; revert only if it still equals the
//     applied proposedValue. Otherwise 409 — a human edit is never clobbered.
//   - Expiring: proposals older than the TTL can't be approved (evidence ages).
//   - Validated: stored values are re-validated before they touch config.
//   - Atomic + audited: the status change, the config change and the audit
//     event commit in ONE transaction — all succeed or nothing changes.

import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { prisma } from './prisma.js'
import { auditCreateData } from './audit.js'
import { sameJson } from './learningLoop.js'
import { DEFAULT_SCORING_WEIGHTS, DEFAULT_SCORING_METRICS } from './scoring.js'
import { OPPORTUNITY_CAUSE_TYPE } from './outcomeCauses.js'
import { WEIGHT_MAX, WEIGHT_MIN, heldOutOf } from './signalCalibration.js'

/**
 * Advisory proposal types (outcomeLearning.ts): approving one records that a
 * human reviewed it; nothing in the workspace's configuration changes, so there
 * is nothing to revert.
 */
export const ADVISORY_TYPES: ReadonlySet<string> = new Set([OPPORTUNITY_CAUSE_TYPE])

export type DecisionAction = 'approve' | 'reject' | 'revert'

export class DecisionError extends Error {
  constructor(public status: 404 | 409 | 410 | 422, message: string) { super(message) }
}

/** Days a PENDING recommendation stays approvable (default 30, 1–365). */
export function learningRecommendationTtlDays(): number {
  const n = Number(process.env.LEARNING_RECOMMENDATION_TTL_DAYS)
  return Number.isInteger(n) && n >= 1 && n <= 365 ? n : 30
}

export function isExpired(createdAt: Date, now: Date): boolean {
  return now.getTime() - createdAt.getTime() > learningRecommendationTtlDays() * 86_400_000
}

const valueSchemas = {
  ICP_INDUSTRY: z.array(z.string().trim().min(1).max(200)).max(50),
  ICP_SIZE: z.object({ minEmployees: z.number().int().min(0).nullable(), maxEmployees: z.number().int().min(0).nullable() }),
  SIGNAL_WEIGHT: z.record(z.string(), z.number().finite().min(0).max(1000)),
  // Event-kind calibration weights (signalCalibration.ts): bounded multipliers.
  EVENT_KIND_WEIGHT: z.record(z.string().max(64), z.number().finite().min(WEIGHT_MIN).max(WEIGHT_MAX)),
} as const
type RecType = keyof typeof valueSchemas

type Tx = Prisma.TransactionClient

async function readLive(tx: Tx, workspaceId: string, type: RecType): Promise<unknown> {
  if (type === 'EVENT_KIND_WEIGHT') {
    const m = await tx.scoringModel.findUnique({ where: { workspaceId }, select: { eventKindWeights: true } })
    return m?.eventKindWeights ?? {}
  }
  if (type === 'SIGNAL_WEIGHT') {
    const m = await tx.scoringModel.findUnique({ where: { workspaceId }, select: { signalWeights: true } })
    return m?.signalWeights ?? {}
  }
  const icp = await tx.workspaceICP.findUnique({
    where: { workspaceId }, select: { targetIndustries: true, minEmployees: true, maxEmployees: true },
  })
  return type === 'ICP_INDUSTRY'
    ? icp?.targetIndustries ?? []
    : { minEmployees: icp?.minEmployees ?? null, maxEmployees: icp?.maxEmployees ?? null }
}

async function writeLive(tx: Tx, workspaceId: string, type: RecType, raw: unknown): Promise<void> {
  const parsed = valueSchemas[type].safeParse(raw)
  if (!parsed.success) throw new DecisionError(422, 'Stored recommendation value is invalid; refusing to apply it')
  const v = parsed.data
  if (type === 'EVENT_KIND_WEIGHT') {
    const eventKindWeights = v as Record<string, number>
    await tx.scoringModel.upsert({
      where: { workspaceId },
      create: { workspaceId, weights: DEFAULT_SCORING_WEIGHTS, performanceMetrics: DEFAULT_SCORING_METRICS, eventKindWeights },
      update: { eventKindWeights, lastWeightUpdate: new Date(), updateCount: { increment: 1 } },
    })
    return
  }
  if (type === 'SIGNAL_WEIGHT') {
    const signalWeights = v as Record<string, number>
    await tx.scoringModel.upsert({
      where: { workspaceId },
      create: { workspaceId, weights: DEFAULT_SCORING_WEIGHTS, performanceMetrics: DEFAULT_SCORING_METRICS, signalWeights },
      update: { signalWeights, lastWeightUpdate: new Date(), updateCount: { increment: 1 } },
    })
    return
  }
  const data = type === 'ICP_INDUSTRY'
    ? { targetIndustries: v as string[] }
    : (v as { minEmployees: number | null; maxEmployees: number | null })
  await tx.workspaceICP.upsert({
    where: { workspaceId },
    create: { workspaceId, targetIndustries: [], targetGeos: [], ...data },
    update: data,
  })
}

/**
 * Apply a human decision. Throws DecisionError (404/409/410/422) when the
 * transition isn't allowed; on success returns the updated recommendation.
 */
export async function decideRecommendation(input: {
  workspaceId: string
  recommendationId: string
  actorUserId: string
  action: DecisionAction
  now?: Date
}) {
  const { workspaceId, recommendationId, actorUserId, action } = input
  const now = input.now ?? new Date()

  const { rec } = await prisma.$transaction(async (tx) => {
    const rec = await tx.learningRecommendation.findFirst({ where: { id: recommendationId, workspaceId } })
    if (!rec) throw new DecisionError(404, 'Recommendation not found')
    const type = rec.type as RecType
    const advisory = ADVISORY_TYPES.has(rec.type)
    if (!advisory && !(type in valueSchemas)) throw new DecisionError(422, `Unsupported recommendation type ${rec.type}`)

    // Claim the transition atomically: only one decider can move it out of `from`.
    const transition = async (from: string[], to: string) => {
      const claimed = await tx.learningRecommendation.updateMany({
        where: { id: rec.id, workspaceId, status: { in: from } },
        data: { status: to, decidedAt: now, decidedBy: actorUserId },
      })
      if (claimed.count === 0) throw new DecisionError(409, 'This recommendation was already decided')
    }

    const audit = (before: unknown, after: unknown) => tx.auditEvent.create({
      data: auditCreateData({
        workspaceId, actorUserId,
        type: `learning.recommendation.${action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'reverted'}`,
        entityType: 'LearningRecommendation', entityId: rec.id,
        metadata: { recommendationType: rec.type, before, after, sampleSize: rec.sampleSize, mode: rec.mode } as Record<string, unknown>,
      }),
    })

    if (action === 'reject') {
      await transition(['PENDING'], 'REJECTED')
      await audit(null, null)
      return { rec, before: null, after: null }
    }

    if (advisory) {
      if (action === 'revert') throw new DecisionError(422, 'This recommendation is advisory — approving it changed nothing, so there is nothing to revert')
      if (rec.status !== 'PENDING') throw new DecisionError(409, 'This recommendation was already decided')
      if (isExpired(rec.createdAt, now)) {
        await transition(['PENDING'], 'EXPIRED')
        return { rec: null, before: null, after: null }
      }
      await transition(['PENDING'], 'APPROVED')
      await audit(null, null)
      return { rec, before: null, after: null }
    }

    const live = await readLive(tx, workspaceId, type)
    if (action === 'approve') {
      if (rec.status !== 'PENDING') throw new DecisionError(409, 'This recommendation was already decided')
      if (isExpired(rec.createdAt, now)) {
        await transition(['PENDING'], 'EXPIRED')
        return { rec: null, before: null, after: null }
      }
      if (!sameJson(live, rec.currentValue ?? null)) {
        throw new DecisionError(409, 'Your settings changed since this was proposed — it no longer applies. A fresh recommendation will be generated.')
      }
      // UQ-29: event-kind weights change live win probabilities, so they go
      // live only when the method beat the current weights on unseen outcomes.
      if (type === 'EVENT_KIND_WEIGHT') {
        const heldOut = heldOutOf(rec.evidence)
        if (!heldOut) throw new DecisionError(409, 'This proposal predates held-out testing — a fresh, tested one will be generated at the next learning run.')
        if (heldOut.verdict !== 'IMPROVED') throw new DecisionError(409, `Not applied: on the newest outcomes it held back, this calibration did not beat the current weights (${heldOut.verdict.toLowerCase().replace('_', ' ')}). ${heldOut.reason}.`)
      }
      await transition(['PENDING'], 'APPROVED')
      await writeLive(tx, workspaceId, type, rec.proposedValue)
      await audit(live, rec.proposedValue)
      return { rec, before: live, after: rec.proposedValue }
    }

    // revert
    if (!sameJson(live, rec.proposedValue)) {
      throw new DecisionError(409, 'Settings changed since this was applied; reverting would overwrite newer changes')
    }
    await transition(['APPROVED', 'APPLIED_AUTOMATICALLY'], 'REVERTED')
    await writeLive(tx, workspaceId, type, rec.currentValue ?? (type === 'SIGNAL_WEIGHT' || type === 'EVENT_KIND_WEIGHT' ? {} : type === 'ICP_INDUSTRY' ? [] : { minEmployees: null, maxEmployees: null }))
    await audit(live, rec.currentValue)
    return { rec, before: live, after: rec.currentValue }
  })

  if (!rec) throw new DecisionError(410, 'This recommendation expired — its evidence is out of date')

  return prisma.learningRecommendation.findUniqueOrThrow({ where: { id: rec.id } })
}
