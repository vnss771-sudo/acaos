// Pure-DB queue processors, extracted from worker.ts so they can be unit-tested
// against a real database without instantiating BullMQ Workers (which connect to
// Redis on construction). worker.ts wires these into Workers; tests call them
// directly.

import { prisma } from '@acaos/backend-core/lib/prisma.js'
import { DEFAULT_SCORING_WEIGHTS, DEFAULT_MESSAGE_RELEVANCE, getOrCreateScoringModel, maybeRecomputeScoringWeights, explainLeadScore, getWorkspaceWeights, getWorkspaceIcpTargets, type ScoringWeights } from '@acaos/backend-core/lib/scoring.js'
import {
  calculateOpportunityScores,
  detectBuyingStage,
  calcWinProbability,
  toRawSignal,
  MAX_SIGNALS_FOR_SCORING,
} from '@acaos/backend-core/lib/signalEngine.js'
import type { SignalType, SignalWeights } from '@acaos/backend-core/lib/signalEngine.js'
import { calibrate, buildRecommendationDrafts, sameJson } from '@acaos/backend-core/lib/learningLoop.js'
import { learningAdaptationMode } from '@acaos/backend-core/lib/learningMode.js'
import { recordPreSendFeatures } from '@acaos/backend-core/lib/messageRelevance.js'
import { SelectionRecorder } from '@acaos/backend-core/lib/selectionTracking.js'
import { holdoutPercent, isHeldOut } from '@acaos/backend-core/lib/holdout.js'
import { AUTO_RECOMMEND_THRESHOLD } from '@acaos/backend-core/lib/recommendationPolicy.js'
import { isCommercialOpportunityEngineEnabled, loadOfferCatalog, refreshCommercialOpportunities, type OfferCatalog } from '@acaos/backend-core/lib/commercialOpportunityStore.js'
import { generateLeadResearch, generateOutreach, outreachGenerationMeta, toIcpContext } from '@acaos/backend-core/services/openai.js'
import { resolvePromptVersionId } from '@acaos/backend-core/lib/aiPromptRegistry.js'
import { effectiveReplyClassification, REPLY_STAGE, replyOutcomeFor } from '@acaos/backend-core/lib/replyGating.js'
import { parseRiskFlags } from '@acaos/backend-core/lib/riskEscalation.js'
import { sensitiveKinds } from '@acaos/backend-core/lib/sensitiveData.js'
import { resolveResearchAction } from '@acaos/backend-core/lib/researchGate.js'
import { resolveOutreachGate } from '@acaos/backend-core/lib/outreachGate.js'
import { replaceLeadEvidence } from '@acaos/backend-core/lib/leadEvidence.js'
import { parseAiJson, parseLeadResearchJson, OutreachDraftOutputSchema, type OutreachDraftOutput, type ReplyAnalysisOutput } from '@acaos/backend-core/lib/aiSchemas.js'
import { sendMail, isMailConfigured, type SmtpConfig } from '@acaos/backend-core/services/mail.js'
import { checkAndIncrementAiUsage, refundAiUsage, reserveDailySendSlot, reserveDomainSendSlot, utcMonthStart, assertAiUsageAllowed } from '@acaos/backend-core/lib/limits.js'
import { trackEvent } from '@acaos/backend-core/lib/analytics.js'
import { emitWebhookEvent } from '@acaos/backend-core/lib/webhooks.js'
import { effectiveApprovalMode, effectiveDailySendLimit, isComplianceGateEnabled } from '@acaos/backend-core/lib/launchControls.js'
import { bulkCheckConsent } from '@acaos/backend-core/lib/consent.js'
import { recordAudit, recordCriticalAudit } from '@acaos/backend-core/lib/audit.js'
import { applyWarmupCap } from '@acaos/backend-core/lib/warmup.js'
import { perDomainDailyCap, emailDomain } from '@acaos/backend-core/lib/sendPacing.js'
import { resolveSendWindow, isWithinSendWindow } from '@acaos/backend-core/lib/sendWindow.js'
import type { Prisma } from '@prisma/client'
import { bulkCheckSuppression } from '@acaos/backend-core/lib/suppressions.js'
import { checkDraftPolicy, checkClaimGrounding, sensitiveDataViolation, type DraftPolicyConfig, type DraftPolicyViolation } from '@acaos/backend-core/lib/policyCheck.js'
import { assertOutreachTone, OutreachToneError } from '@acaos/backend-core/lib/outreachTone.js'
import { buildOutreachEmail, resolveUnsubscribeBaseUrl } from '@acaos/backend-core/lib/emailFooter.js'
import { isDeliverableEmail } from '@acaos/backend-core/lib/normalize.js'
import { contactEventData } from '@acaos/backend-core/lib/contactEvents.js'
import { campaignDailyStatsUpsertArgs, utcDayStart } from '@acaos/backend-core/lib/campaignStats.js'
import { scheduleNextFollowup } from '@acaos/backend-core/services/followups.js'
import { authorizeOutboundSend } from '@acaos/backend-core/services/sendAuthorization.js'
import { getSource, type ProspectCandidate, type ProspectSearchInput } from '@acaos/backend-core/lib/prospectSources.js'
import { importDiscoveredProspects } from '@acaos/backend-core/lib/discoveryImport.js'
import { enqueueScoreProspects } from '@acaos/backend-core/lib/queues.js'
import type { ICPConfig } from '@acaos/backend-core/lib/signalEngine.js'
import { randomBytes } from 'crypto'
import type { LeadStage, FollowupTaskStatus } from '@acaos/shared'
import { incReputationBlock, incSendOutcome, incAiCost } from '../lib/metrics.js'

type Progress = (n: number) => unknown

type DbSignalRow = {
  type: SignalType
  strength: number
  sourceReliability: number
  industryRelevance: number
  detectedAt: Date
}

type ScoreProspectRow = {
  id: string
  industry: string | null
  employeeCount: number | null
  contactEmail: string | null
  contactName: string | null
  domain: string | null
  location: string | null
  isExample: boolean
  signals: DbSignalRow[]
}

type CalibrationOutcomeRow = {
  stage: string
  recordedAt: Date
  prospect: {
    industry: string | null
    employeeCount: number | null
    signals: Array<{ type: SignalType }>
  }
}

type CampaignLeadRow = {
  id: string
  businessName: string
  category: string | null
  city: string | null
  contactName: string | null
  email: string | null
  aiSummary: string | null
  outreachAngle: string | null
  notes: string | null
  outreachDrafts: Array<{ id?: string; subject: string; emailBody: string }>
  score: number
}

/** Recompute opportunity scores for every prospect in a workspace. */

export async function scoreProspects(
  workspaceId: string,
  progress?: Progress
): Promise<{ workspaceId: string; updated: number; toRecommend: string[] }> {
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
  await progress?.(10)

  // Walk the workspace's prospects in cursor-paginated pages rather than loading
  // every prospect (and its signals) into memory at once — bounds memory while
  // still rescoring all of them. Collect the real (non-example) prospects that
  // clear the auto-recommend threshold so the worker layer can enqueue
  // recommendation generation (kept out of here to keep this processor Redis-free
  // and unit-testable).
  const PAGE = 500
  const BATCH = 100 // parallel writes per page, to not overwhelm the pool
  const toRecommend: string[] = []
  let cursor: string | undefined
  let updated = 0
  // Opportunity engine: reassess each scored page against the workspace's offers.
  // Best-effort — a failure here is logged and never fails the rescore.
  const opportunitiesEnabled = isCommercialOpportunityEngineEnabled()
  let offerCatalog: OfferCatalog | null = null

  for (;;) {
    const page = await prisma.prospect.findMany({
      where: { workspaceId },
      include: { signals: { orderBy: { detectedAt: 'desc' }, take: MAX_SIGNALS_FOR_SCORING } },
      orderBy: { id: 'asc' },
      take: PAGE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    }) as ScoreProspectRow[]
    if (page.length === 0) break

    const updates = page.map((prospect: ScoreProspectRow) => {
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
      if (!prospect.isExample && scores.opportunityScore >= AUTO_RECOMMEND_THRESHOLD) {
        toRecommend.push(prospect.id)
      }
      return prisma.prospect.update({
        where: { id: prospect.id },
        data: { ...scores, buyingStage, winProbability },
      })
    })

    for (let i = 0; i < updates.length; i += BATCH) {
      await Promise.all(updates.slice(i, i + BATCH))
    }

    if (opportunitiesEnabled) {
      try {
        offerCatalog ??= await loadOfferCatalog(workspaceId)
        await refreshCommercialOpportunities(workspaceId, page.map(p => p.id), { catalog: offerCatalog })
      } catch (err) {
        console.error(`[score-prospects] opportunity refresh failed for workspace ${workspaceId}: ${err instanceof Error ? err.message : err}`)
      }
    }

    updated += page.length
    cursor = page[page.length - 1].id
    if (page.length < PAGE) break
  }

  await progress?.(100)
  return { workspaceId, updated, toRecommend }
}

/**
 * Research a lead via AI: fetch it (tenant-scoped), generate research framed
 * by the workspace's ICP, deterministically score it, and persist the
 * intelligence snapshot + normalized evidence rows atomically. Extracted from
 * worker.ts's research-lead handler so it's unit-testable against a real
 * database without instantiating a BullMQ Worker.
 */
export async function calibrateScoring(
  workspaceId: string,
  progress?: Progress
): Promise<{ calibrated: boolean; reason?: string; totalOutcomes: number; baselineWinRate: number }> {
  const mode = learningAdaptationMode()
  if (mode === 'off') return { calibrated: false, reason: 'learning disabled', totalOutcomes: 0, baselineWinRate: 0 }
  await progress?.(10)

  const rawOutcomes = await prisma.prospectOutcome.findMany({
    // Never learn signal weights / ICP from example prospects — that would poison
    // the real model with demo data.
    where: { workspaceId, stage: { in: ['WON', 'LOST'] }, prospect: { isExample: false } },
    include: { prospect: { include: { signals: { orderBy: { detectedAt: 'desc' }, take: MAX_SIGNALS_FOR_SCORING } } } },
    orderBy: { recordedAt: 'desc' },
    take: 100,
  }) as CalibrationOutcomeRow[]
  await progress?.(30)

  const outcomes = rawOutcomes.map((o: CalibrationOutcomeRow) => ({
    stage: o.stage as 'WON' | 'LOST',
    // Feeds calibrate()'s recency weighting so a recent WON/LOST outweighs an
    // old one of otherwise-identical shape (see learningLoop.ts).
    recordedAt: o.recordedAt,
    prospect: {
      industry: o.prospect.industry,
      employeeCount: o.prospect.employeeCount,
      signals: o.prospect.signals.map((s: { type: SignalType }) => ({ type: s.type })),
    },
  }))

  const result = calibrate(outcomes)
  await progress?.(60)

  if (!result.stats.calibrated) {
    return result.stats
  }

  const [model, icp] = await Promise.all([
    prisma.scoringModel.findUnique({ where: { workspaceId }, select: { signalWeights: true } }),
    prisma.workspaceICP.findUnique({ where: { workspaceId }, select: { targetIndustries: true, minEmployees: true, maxEmployees: true } }),
  ])
  const drafts = buildRecommendationDrafts(result, {
    targetIndustries: icp?.targetIndustries ?? [],
    minEmployees: icp?.minEmployees ?? null,
    maxEmployees: icp?.maxEmployees ?? null,
    signalWeights: (model?.signalWeights as Record<string, number> | null) ?? {},
  })
  // An identical proposal that's already PENDING stays as-is (no churn); a
  // different proposal supersedes the pending one of the same type.
  const pending = await prisma.learningRecommendation.findMany({
    where: { workspaceId, status: 'PENDING' }, select: { type: true, proposedValue: true },
  })
  const freshDrafts = drafts.filter(d => !pending.some((p: { type: string; proposedValue: unknown }) =>
    p.type === d.type && sameJson(p.proposedValue, d.proposedValue)))
  const applySignalWeights = mode === 'live' && freshDrafts.some(d => d.type === 'SIGNAL_WEIGHT')

  await prisma.$transaction(async (tx) => {
    const types = freshDrafts.map(d => d.type)
    if (types.length > 0) {
      await tx.learningRecommendation.updateMany({
        where: { workspaceId, status: 'PENDING', type: { in: types } },
        data: { status: 'SUPERSEDED', decidedAt: new Date(), decidedBy: 'system' },
      })
    }
    for (const d of freshDrafts) {
      const auto = applySignalWeights && d.type === 'SIGNAL_WEIGHT'
      await tx.learningRecommendation.create({
        data: {
          workspaceId,
          type: d.type,
          status: auto ? 'APPLIED_AUTOMATICALLY' : 'PENDING',
          currentValue: d.currentValue as Prisma.InputJsonValue,
          proposedValue: d.proposedValue as Prisma.InputJsonValue,
          evidence: d.evidence as Prisma.InputJsonValue,
          sampleSize: d.sampleSize,
          mode,
          ...(auto && { decidedAt: new Date(), decidedBy: 'system' }),
        },
      })
    }
    const performanceMetrics = {
      totalOutcomes: result.stats.totalOutcomes,
      winRate: result.stats.baselineWinRate,
      calibratedAt: new Date().toISOString(),
      mode,
    }
    await tx.scoringModel.upsert({
      where: { workspaceId },
      create: {
        workspaceId,
        weights: DEFAULT_SCORING_WEIGHTS,
        ...(applySignalWeights && { signalWeights: result.signalWeights }),
        performanceMetrics,
      },
      update: applySignalWeights
        ? { signalWeights: result.signalWeights, lastWeightUpdate: new Date(), updateCount: { increment: 1 }, performanceMetrics }
        : { performanceMetrics },
    })
  })
  await progress?.(100)
  return result.stats
}

// Why a lead was skipped (vs sent/failed). Surfaced so the API/UI/operator can
// answer "why didn't this send?" instead of a bare total.
