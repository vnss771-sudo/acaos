// Pure-DB queue processors, extracted from worker.ts so they can be unit-tested
// against a real database without instantiating BullMQ Workers (which connect to
// Redis on construction). worker.ts wires these into Workers; tests call them
// directly.

import { prisma } from '@acaos/backend-core/lib/prisma.js'
import { DEFAULT_SCORING_WEIGHTS, maybeRecomputeScoringWeights, explainLeadScore, getWorkspaceWeights, getWorkspaceIcpTargets, type ScoringWeights } from '@acaos/backend-core/lib/scoring.js'
import {
  calculateOpportunityScores,
  detectBuyingStage,
  calcWinProbability,
  toRawSignal,
  MAX_SIGNALS_FOR_SCORING,
} from '@acaos/backend-core/lib/signalEngine.js'
import type { SignalType, SignalWeights } from '@acaos/backend-core/lib/signalEngine.js'
import { calibrate } from '@acaos/backend-core/lib/learningLoop.js'
import { AUTO_RECOMMEND_THRESHOLD } from '@acaos/backend-core/lib/recommendationPolicy.js'
import { generateLeadResearch, generateOutreach, outreachGenerationMeta, toIcpContext } from '@acaos/backend-core/services/openai.js'
import { resolvePromptVersionId } from '@acaos/backend-core/lib/aiPromptRegistry.js'
import { effectiveReplyClassification } from '@acaos/backend-core/lib/replyGating.js'
import { resolveResearchAction } from '@acaos/backend-core/lib/researchGate.js'
import { resolveOutreachGate } from '@acaos/backend-core/lib/outreachGate.js'
import { replaceLeadEvidence } from '@acaos/backend-core/lib/leadEvidence.js'
import { parseAiJson, parseLeadResearchJson, OutreachDraftOutputSchema, type OutreachDraftOutput, type ReplyAnalysisOutput } from '@acaos/backend-core/lib/aiSchemas.js'
import { sendMail, isMailConfigured, type SmtpConfig } from '@acaos/backend-core/services/mail.js'
import { checkAndIncrementAiUsage, refundAiUsage, reserveDailySendSlot, reserveDomainSendSlot, utcMonthStart, assertAiUsageAllowed } from '@acaos/backend-core/lib/limits.js'
import { trackEvent } from '@acaos/backend-core/lib/analytics.js'
import { emitWebhookEvent } from '@acaos/backend-core/lib/webhooks.js'
import { effectiveApprovalMode, effectiveDailySendLimit, reputationGuardMode, isComplianceGateEnabled } from '@acaos/backend-core/lib/launchControls.js'
import { bulkCheckConsent, hasConsent } from '@acaos/backend-core/lib/consent.js'
import { recordAudit, recordCriticalAudit } from '@acaos/backend-core/lib/audit.js'
import { evaluateSenderReputation } from '@acaos/backend-core/lib/senderReputation.js'
import { applyWarmupCap } from '@acaos/backend-core/lib/warmup.js'
import { perDomainDailyCap, emailDomain } from '@acaos/backend-core/lib/sendPacing.js'
import { resolveSendWindow, isWithinSendWindow } from '@acaos/backend-core/lib/sendWindow.js'
import type { Prisma } from '@prisma/client'
import { bulkCheckSuppression } from '@acaos/backend-core/lib/suppressions.js'
import { checkDraftPolicy, checkClaimGrounding, type DraftPolicyConfig, type DraftPolicyViolation } from '@acaos/backend-core/lib/policyCheck.js'
import { assertOutreachTone, OutreachToneError } from '@acaos/backend-core/lib/outreachTone.js'
import { buildOutreachEmail } from '@acaos/backend-core/lib/emailFooter.js'
import { isDeliverableEmail } from '@acaos/backend-core/lib/normalize.js'
import { contactEventData } from '@acaos/backend-core/lib/contactEvents.js'
import { campaignDailyStatsUpsertArgs, utcDayStart } from '@acaos/backend-core/lib/campaignStats.js'
import { scheduleNextFollowup } from '@acaos/backend-core/services/followups.js'
import { canContactRecipient } from '@acaos/backend-core/services/contactPolicy.js'
import { getSource, type ProspectCandidate, type ProspectSearchInput } from '@acaos/backend-core/lib/prospectSources.js'
import { importDiscoveredProspects } from '@acaos/backend-core/lib/discoveryImport.js'
import { enqueueScoreProspects } from '@acaos/backend-core/lib/queues.js'
import type { ICPConfig } from '@acaos/backend-core/lib/signalEngine.js'
import { randomBytes } from 'crypto'
import type { LeadStage, FollowupTaskStatus } from '@acaos/shared'
import { incReputationBlock, incSendOutcome, incAiCost } from './lib/metrics.js'

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
  outreachDrafts: Array<{ subject: string; emailBody: string }>
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
export async function researchLead(
  leadId: string,
  workspaceId: string,
  progress?: Progress,
  // Optional injection seam: tests pass a `generateLeadResearch` stub so the
  // scoring/persistence path can be exercised without a real OpenAI call.
  // Defaults to the real generator, so production callers (worker.ts) are
  // unchanged. Mirrors the same seam on sendCampaignBatch.
  deps: { generateLeadResearch?: typeof generateLeadResearch } = {},
): Promise<{
  leadId: string
  aiSummary?: string
  outreachAngle?: string
  score: number
  scoreReasons: string[]
  signals: Record<string, number>
  evidence?: unknown[]
  riskFlags?: string[]
  recommendedAction?: string
}> {
  const generateLeadResearchFn = deps.generateLeadResearch ?? generateLeadResearch

  // Tenant-scoped fetch: never act on a lead outside the job's workspace.
  const lead = await prisma.lead.findFirst({ where: { id: leadId, workspaceId } })
  if (!lead) throw new Error(`Lead ${leadId} not found in workspace ${workspaceId}`)

  await progress?.(10)

  // Frame the research prompt for the workspace's actual vertical, not the
  // hardcoded field-service default — otherwise a SaaS/other-vertical workspace
  // gets analysis framed around plumbing/HVAC/etc.
  const wsIcp = await prisma.workspaceICP.findUnique({
    where: { workspaceId },
    select: { targetIndustries: true, businessType: true, outreachTone: true },
  })

  // Defense-in-depth re-check right before the model call: the enqueue-time
  // caller (jobs.ts, ingest.ts) already metered this call, but a job that
  // reached the queue any other way (a direct enqueue, a leaked producer
  // credential) must not get a free model call just because it skipped that
  // check. Read-only — the increment already happened at enqueue time.
  await assertAiUsageAllowed(workspaceId)

  const raw = await generateLeadResearchFn({
    businessName: lead.businessName,
    website: lead.website ?? undefined,
    category: lead.category ?? undefined,
    city: lead.city ?? undefined,
    notes: lead.notes ?? undefined,
    icp: toIcpContext(wsIcp),
  })

  await progress?.(60)

  // Lenient: research is best-effort enrichment, so a malformed field is
  // dropped (not fatal) and the scorer falls back to its computed score.
  const parsed = parseLeadResearchJson(raw)

  const enrichedLead = {
    businessName: lead.businessName,
    category: lead.category,
    contactName: lead.contactName,
    email: lead.email,
    website: lead.website,
    notes: lead.notes,
    aiSummary: parsed.aiSummary ?? null,
    outreachAngle: parsed.outreachAngle ?? null,
    estimatedTeamSize: parsed.estimatedTeamSize ?? null
  }

  const [weights, icpTargets] = await Promise.all([
    getWorkspaceWeights(lead.workspaceId),
    getWorkspaceIcpTargets(lead.workspaceId),
  ])
  // Deterministic score + its rationale (the "why 75"), so the breakdown is
  // captured in the job result/log rather than thrown away. Industry sub-score is
  // calibrated to the workspace's ICP (falls back to the default vertical if unset).
  const explanation = explainLeadScore(enrichedLead, weights, icpTargets)
  const computedScore = explanation.score
  const finalScore = (typeof parsed.icpScore === 'number' && parsed.icpScore >= 0 && parsed.icpScore <= 100)
    ? Math.round((parsed.icpScore + computedScore) / 2)
    : computedScore

  await progress?.(80)

  // Thin-research guard: lenient parsing can yield an empty result; never let that
  // flow through as auto_draft (it would produce generic, ungrounded outreach).
  const evidenceCount = parsed.evidence?.length ?? 0
  const noResearchSubstance = !(Boolean(parsed.aiSummary?.trim()) || evidenceCount > 0)
  const thinResearch = noResearchSubstance && parsed.recommendedAction !== 'skip'
  const safeRecommendedAction = resolveResearchAction({
    recommendedAction: parsed.recommendedAction,
    aiSummary: parsed.aiSummary,
    evidenceCount,
  })

  // Auditable intelligence snapshot persisted on the lead: the deterministic
  // score rationale plus the model's provenance-labelled evidence. JSON-only
  // values (no undefined) so it round-trips cleanly through the JSONB column.
  const aiIntelligence = {
    capturedAt: new Date().toISOString(),
    finalScore,
    computedScore,
    tier: explanation.tier,
    modelIcpScore: typeof parsed.icpScore === 'number' ? parsed.icpScore : null,
    topReasons: explanation.topReasons,
    signals: explanation.signals,
    evidence: parsed.evidence ?? [],
    riskFlags: thinResearch
      ? [...(parsed.riskFlags ?? []), 'Research returned no summary or evidence — held for manual review rather than auto-draft.']
      : (parsed.riskFlags ?? []),
    recommendedAction: safeRecommendedAction,
    confidence: parsed.confidence ?? null,
    digitalMaturity: parsed.digitalMaturity ?? null,
    estimatedTeamSize: parsed.estimatedTeamSize ?? null,
    hiringSignals: parsed.hiringSignals ?? null,
  }

  // Atomic: persist the lead's intelligence snapshot AND replace its normalized
  // evidence rows together, so a re-research can't leave stale evidence behind.
  await prisma.$transaction(async (tx) => {
    await tx.lead.update({
      where: { id: leadId },
      data: {
        aiSummary: parsed.aiSummary ?? null,
        outreachAngle: parsed.outreachAngle ?? null,
        aiIntelligence,
        score: finalScore,
        stage: 'RESEARCHED'
      }
    })
    await replaceLeadEvidence(tx, { workspaceId: lead.workspaceId, leadId, evidence: parsed.evidence, website: lead.website })
  })

  await progress?.(100)
  console.log(`[research-lead] Done leadId=${leadId} stage=RESEARCHED score=${finalScore} why=${explanation.topReasons.join('; ') || 'n/a'}`)
  return {
    leadId,
    aiSummary: parsed.aiSummary,
    outreachAngle: parsed.outreachAngle,
    score: finalScore,
    scoreReasons: explanation.topReasons,
    signals: explanation.signals,
    evidence: parsed.evidence,
    riskFlags: parsed.riskFlags,
    recommendedAction: parsed.recommendedAction,
  }
}

/**
 * Generate an outreach draft for a lead: honour the research-driven outreach
 * gate (skip a poor-fit lead unless a human overrides), call the model,
 * validate + tone-guard the output, and persist the draft. Extracted from
 * worker.ts's generate-outreach handler for the same reason as researchLead.
 */
export async function generateOutreachDraft(
  leadId: string,
  workspaceId: string,
  override: boolean | undefined,
  progress?: Progress,
  // Optional injection seam: tests pass a `generateOutreach` stub so the
  // gate/persistence/tone-guard paths can be exercised without a real OpenAI
  // call. Defaults to the real generator, so production callers (worker.ts)
  // are unchanged. Mirrors the same seam on sendCampaignBatch.
  deps: { generateOutreach?: typeof generateOutreach } = {},
): Promise<{
  leadId: string
  subject?: string
  email?: string
  followup?: string | null
  skipped?: boolean
  reason?: string
  toneWarnings?: string[]
}> {
  // Named distinctly from sendCampaignBatch's own `generateOutreachFn` local —
  // a source-text safety test (operational-chaos-safety-gates.test.ts) greps
  // this file for that exact call-site string to pin its position relative to
  // the send-loop's approval gate, and a second, earlier occurrence of the
  // same literal would silently point that test at the wrong call site.
  const generateOutreachDraftFn = deps.generateOutreach ?? generateOutreach

  // Tenant-scoped fetch: never act on a lead outside the job's workspace.
  const lead = await prisma.lead.findFirst({ where: { id: leadId, workspaceId } })
  if (!lead) throw new Error(`Lead ${leadId} not found in workspace ${workspaceId}`)

  // Outreach gate: honour the research recommendedAction. A poor-fit ("skip")
  // lead is suppressed (no model call) and marked for the review queue; a human
  // can override, which generates a draft into POLICY_REVIEW. manual_review and
  // override both force POLICY_REVIEW. auto_draft / none → normal DRAFTED flow.
  const intel = (lead.aiIntelligence ?? null) as { recommendedAction?: string } | null
  const gate = resolveOutreachGate({ recommendedAction: intel?.recommendedAction, override })

  if (!gate.generate) {
    await prisma.lead.update({
      where: { id: lead.id },
      data: { outreachSkippedAt: new Date(), outreachSkipReason: gate.skipReason },
    })
    // No model call was made — free the AI_OUTREACH credit the API metered up front.
    await refundAiUsage(lead.workspaceId, 'AI_OUTREACH')
    await progress?.(100)
    console.log(`[generate-outreach] suppressed leadId=${leadId}: ${gate.skipReason}`)
    return { leadId, skipped: true, reason: gate.skipReason }
  }

  await progress?.(10)

  // Frame outreach for the workspace's vertical/tone (not the field-service
  // default), mirroring the campaign send path.
  const wsIcp = await prisma.workspaceICP.findUnique({
    where: { workspaceId },
    select: { targetIndustries: true, businessType: true, outreachTone: true },
  })

  // Defense-in-depth re-check right before the model call — see the same
  // comment in researchLead above.
  await assertAiUsageAllowed(lead.workspaceId)

  const raw = await generateOutreachDraftFn({
    businessName: lead.businessName,
    category: lead.category ?? undefined,
    city: lead.city ?? undefined,
    contactName: lead.contactName ?? undefined,
    aiSummary: lead.aiSummary ?? undefined,
    outreachAngle: lead.outreachAngle ?? undefined,
    icp: toIcpContext(wsIcp),
  })

  await progress?.(80)

  // Strict: a draft missing subject/email is unusable. Fail closed — throwing
  // here marks the job failed so BullMQ retries rather than persisting garbage.
  const parsed = parseAiJson(OutreachDraftOutputSchema, raw, 'generate-outreach')

  // Tone guardrail: reject "creepy", presumptuous copy that asserts private
  // knowledge of the recipient's problems as fact (fail closed → BullMQ
  // regenerates). Buzzword warnings are surfaced but do not block.
  const toneWarnings = assertOutreachTone(parsed)
  if (toneWarnings.length > 0) {
    console.log(`[generate-outreach] tone warnings leadId=${leadId}: ${toneWarnings.map((w) => w.match).join(', ')}`)
  }

  // Record generation provenance (model + prompt version) so the draft is
  // auditable/reproducible. Best-effort — never blocks draft creation.
  const promptVersionId = await resolvePromptVersionId({ workspaceId: lead.workspaceId, ...outreachGenerationMeta() })

  await prisma.outreachDraft.create({
    data: {
      leadId: lead.id,
      workspaceId: lead.workspaceId,
      subject: parsed.subject,
      emailBody: parsed.email,
      followup: parsed.followup ?? null,
      // Gated status: POLICY_REVIEW when research asked for manual review or a
      // human overrode a skip (held for a human); otherwise the normal DRAFTED.
      status: gate.draftStatus,
      promptVersionId,
    }
  })

  // A successful (over)ride generation clears any prior poor-fit suppression.
  if (lead.outreachSkippedAt) {
    await prisma.lead.update({ where: { id: lead.id }, data: { outreachSkippedAt: null, outreachSkipReason: null } })
  }

  // Generating a draft is NOT a send. Do not advance the lead to
  // OUTREACH_SENT here — sendCampaignBatch excludes that stage from the send
  // selection, so marking it now would prevent the campaign from ever
  // sending the draft. sendCampaignBatch sets OUTREACH_SENT only after SMTP
  // delivery is recorded in OutreachSent.

  await progress?.(100)
  console.log(`[generate-outreach] Done leadId=${leadId}`)
  return { leadId, subject: parsed.subject, email: parsed.email, followup: parsed.followup, toneWarnings: toneWarnings.map((w) => w.match) }
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

// Why a lead was skipped (vs sent/failed). Surfaced so the API/UI/operator can
// answer "why didn't this send?" instead of a bare total.
export type SendSkipReason =
  | 'ALREADY_SENT'
  | 'SUPPRESSED'
  | 'WORKSPACE_SUPPRESSED'
  | 'INVALID_EMAIL'
  | 'NO_APPROVED_DRAFT'
  | 'POLICY_REVIEW'
  | 'AI_LIMIT'
  | 'AI_GENERATION_FAILED'
  | 'DAILY_CAP'
  | 'MONTHLY_CAP'
  | 'MISSION_PAUSED'
  | 'REPUTATION_BLOCKED'
  | 'DOMAIN_PACED'
  | 'OUTSIDE_SEND_WINDOW'
  | 'CONSENT_REQUIRED'

type SendCampaignResult = {
  campaignId: string
  sent: number
  skipped: number
  failed: number
  // Per-reason breakdown of `skipped` (sums to `skipped`).
  skippedByReason: Record<SendSkipReason, number>
}

// Mission pause/complete is the operator stop button. Returns a human-readable
// reason when sending must halt, else null. Best-effort: a missing or unlinked
// mission never blocks sending.
async function getMissionSendBlockReason(campaignId: string): Promise<string | null> {
  const mission = await prisma.mission
    .findUnique({ where: { campaignId }, select: { status: true } })
    .catch(() => null)
  if (mission?.status === 'PAUSED') return 'mission paused'
  if (mission?.status === 'COMPLETE') return 'mission complete'
  return null
}

// ── sendCampaignBatch and its named steps ──────────────────────────────────
// The batch is decomposed into the pipeline it actually runs, in order: load
// batch-level config → (per page) load fast-path lookup sets → (per lead)
// resolve where the draft comes from → claim a send slot → generate + police
// a fresh draft if needed → dispatch the email and record the outcome. Each
// step below is a standalone function so it can be read (and in several
// cases unit-tested) on its own; sendCampaignBatch itself is now just the
// control flow that calls them in sequence.

/** Workspace/campaign-level config a send batch needs before touching any lead. */
async function loadCampaignSendConfig(campaignId: string, workspaceId: string) {
  // Load workspace config and ICP settings together — both are needed before
  // querying leads (approvalMode determines which drafts are eligible to send).
  const [wsCfgRecord, icp, workspace, missionCtx, draftPolicyRecord, campaignRow] = await Promise.all([
    prisma.workspaceEmailConfig.findUnique({ where: { workspaceId } }),
    prisma.workspaceICP.findUnique({ where: { workspaceId } }),
    prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: {
        senderBusinessName: true, senderPostalAddress: true, sendSuppressed: true,
        lawfulBasis: true, targetsCanada: true,
      },
    }),
    // Per-mission outreach overrides (offer + target customer), if this campaign
    // is the execution arm of a mission. campaignId is unique on Mission.
    prisma.mission.findUnique({ where: { campaignId }, select: { targetCustomer: true, offer: true } }),
    // Per-workspace draft content policy (length, forbidden phrases, etc). Optional —
    // absent means the deterministic defaults in checkDraftPolicy apply.
    prisma.workspaceDraftPolicy.findUnique({ where: { workspaceId } }),
    // Whether this campaign opts into multi-step sequences (default false → no
    // follow-ups are scheduled, so one-off campaigns are unaffected).
    prisma.campaign.findUnique({ where: { id: campaignId }, select: { autoFollowupsEnabled: true } }),
  ])
  const autoFollowupsEnabled = Boolean(campaignRow?.autoFollowupsEnabled)
  // Build the policy config once for the whole batch. null/undefined fields fall
  // through to checkDraftPolicy's deterministic defaults.
  const draftPolicy: DraftPolicyConfig | undefined = draftPolicyRecord
    ? {
        minSubjectLength: draftPolicyRecord.minSubjectLength,
        maxSubjectLength: draftPolicyRecord.maxSubjectLength,
        minBodyLength: draftPolicyRecord.minBodyLength,
        maxBodyLength: draftPolicyRecord.maxBodyLength,
        forbiddenPhrases: draftPolicyRecord.forbiddenPhrases,
        requireTemplate: draftPolicyRecord.requireTemplate,
      }
    : undefined
  const smtpCfg: SmtpConfig | null = wsCfgRecord ?? null
  if (!isMailConfigured(smtpCfg)) throw new Error('SMTP not configured — set SMTP_HOST and SMTP_FROM')
  return { icp, workspace, missionCtx, draftPolicy, autoFollowupsEnabled, smtpCfg }
}

type CampaignSendConfig = Awaited<ReturnType<typeof loadCampaignSendConfig>>

/**
 * Per-page fast-path lookup sets so per-lead checks below are in-memory
 * membership tests instead of one query per lead. Pre-filters/caches only —
 * the atomic per-lead claim (unique (campaignId, leadId)) remains the real
 * race guard.
 */
async function loadPageFastPathSets(
  page: CampaignLeadRow[],
  workspaceId: string,
  campaignId: string,
  // Only bother querying ConsentRecord for this page when the workspace's
  // compliance posture actually requires it — see the CONSENT_REQUIRED check
  // in sendCampaignBatch for what sets this.
  consentRequired = false,
) {
  const pageLeadIds = page.map((l) => l.id)
  const pageEmails = page.map((l) => l.email!).filter(Boolean)
  const isSuppressed = pageEmails.length > 0
    ? await bulkCheckSuppression(workspaceId, pageEmails)
    : () => false
  // Fail-closed: when consent is required and there's nothing to check against
  // (no emails), `hasConsent` defaults to false rather than true — no bulk call
  // trivially "passes" a page it never inspected.
  const hasConsent = consentRequired && pageEmails.length > 0
    ? await bulkCheckConsent(workspaceId, pageEmails)
    : consentRequired
      ? () => false
      : () => true

  const alreadySentLeadIds: Set<string> = new Set(
    (await prisma.outreachSent.findMany({
      where: { campaignId, leadId: { in: pageLeadIds }, status: { in: ['SENT', 'SENDING', 'FAILED'] } },
      select: { leadId: true },
    }))
      .map((r: { leadId: string | null }) => r.leadId)
      .filter((id: string | null): id is string => id !== null)
  )

  const policyReviewLeadIds: Set<string> = new Set(
    (await prisma.outreachDraft.findMany({
      where: { leadId: { in: pageLeadIds }, status: 'POLICY_REVIEW' },
      select: { leadId: true },
    })).map((r: { leadId: string }) => r.leadId)
  )

  const linkedIntentRows = await prisma.outreachIntent
    .findMany({
      where: { leadId: { in: pageLeadIds }, status: 'APPROVED' },
      select: { leadId: true, id: true, recommendationId: true, evidenceSnapshot: true },
    })
    .catch(() => [])
  const linkedIntentByLeadId = new Map<string, (typeof linkedIntentRows)[number]>()
  for (const intent of linkedIntentRows) {
    if (intent.leadId !== null && !linkedIntentByLeadId.has(intent.leadId)) {
      linkedIntentByLeadId.set(intent.leadId, intent)
    }
  }

  return { isSuppressed, hasConsent, alreadySentLeadIds, policyReviewLeadIds, linkedIntentByLeadId }
}

export type DraftSourceDecision =
  | { action: 'reuse'; subject: string; body: string }
  | { action: 'generate' }
  | { action: 'skip'; reason: Extract<SendSkipReason, 'POLICY_REVIEW' | 'NO_APPROVED_DRAFT'> }

/**
 * Decide where a lead's send-batch draft comes from: an existing draft
 * (already approved, or eligible for reuse), a fresh AI generation, or a
 * skip (a POLICY_REVIEW draft awaiting human review, or approval required
 * with nothing approved yet). Pure — no I/O — so it's unit-testable directly.
 */
export function resolveDraftSource(
  lead: Pick<CampaignLeadRow, 'id' | 'outreachDrafts'>,
  opts: { approvalRequired: boolean; policyReviewLeadIds: Set<string> }
): DraftSourceDecision {
  if (lead.outreachDrafts[0]) {
    return { action: 'reuse', subject: lead.outreachDrafts[0].subject, body: lead.outreachDrafts[0].emailBody }
  }
  // A draft already flagged POLICY_REVIEW is awaiting human review — skip
  // without regenerating (the selection query excludes it, so it never lands
  // in outreachDrafts[0], but its lead still appears here in non-approval mode).
  if (opts.policyReviewLeadIds.has(lead.id)) return { action: 'skip', reason: 'POLICY_REVIEW' }
  // Approval mode: only human-approved drafts may be sent. The caller's query
  // includes APPROVED drafts only, so an empty drafts array here means this
  // lead has nothing approved — it must be skipped, never sent with freshly
  // generated copy. (Without this guard, generating would bypass the entire
  // approval gate.)
  if (opts.approvalRequired) return { action: 'skip', reason: 'NO_APPROVED_DRAFT' }
  return { action: 'generate' }
}

/** True for a Prisma unique-constraint violation (P2002). */
export function isUniqueConstraintViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002'
}

/**
 * Run the deterministic tone/content/grounding checks on a candidate draft
 * and collect every violation. Pure and deterministic — no I/O — so it's
 * unit-testable directly, unlike the DB-tier-only path it used to only be
 * reachable through. Block-severity tone violations ("creepy"/presumptuous
 * copy that asserts private knowledge of the recipient's problems) must
 * never auto-send; folded in here (rather than left to throw) so one bad
 * draft routes to POLICY_REVIEW instead of failing the whole batch. (Warn-
 * level buzzwords are non-blocking.) Grounding = the lead facts the copy was
 * generated from; a claim not supported by them is flagged as fabricated.
 */
export function collectDraftViolations(
  draft: { subject: string; body: string; followup: string | null },
  grounding: { text: string; hasPriorConnection: boolean },
  draftPolicy: DraftPolicyConfig | undefined
): DraftPolicyViolation[] {
  const toneViolations: DraftPolicyViolation[] = []
  try {
    assertOutreachTone({ subject: draft.subject, email: draft.body, followup: draft.followup })
  } catch (e) {
    if (e instanceof OutreachToneError) {
      toneViolations.push(...e.violations.map((v) => ({ code: `TONE_${v.kind.toUpperCase()}`, message: v.match })))
    } else {
      throw e
    }
  }
  return [
    ...checkDraftPolicy({ subject: draft.subject, emailBody: draft.body }, draftPolicy),
    ...checkClaimGrounding(draft.body, { grounding: grounding.text, hasPriorConnection: grounding.hasPriorConnection }),
    ...toneViolations,
  ]
}

type ClaimOutcome =
  | { claimed: true; claimId: string; release: () => Promise<void> }
  | { claimed: false; reason: 'DAILY_CAP' | 'DOMAIN_PACED' | 'ALREADY_SENT' }

/**
 * Reserve the daily-cap (and, if configured, per-domain-cap) slot and insert
 * the unique outbox row in ONE advisory-locked transaction, BEFORE any
 * generation/send. The unique (campaignId, leadId) constraint guarantees
 * at-most-once delivery: a racing attempt — or a retry after a post-send
 * crash — gets a P2002 and is reported as already claimed, having spent no
 * AI. The per-domain check happens here (not just as an in-memory
 * pre-check by the caller) because concurrent send-campaign/send-followup
 * jobs for the same workspace/domain would otherwise each pass an
 * independent pre-check and collectively burst past the cap. A `claimed:
 * false` result means the corresponding live cap is now reached.
 */
async function claimOutboxSlot(params: {
  workspaceId: string
  campaignId: string
  lead: CampaignLeadRow
  subject: string | null
  body: string | null
  dailySendLimit: number | null
  startOfToday: Date
  perDomainCap: number | null
  linkedIntent: { id: string; recommendationId: string | null; evidenceSnapshot: Prisma.JsonValue | null } | null
  unsubscribeToken: string
}): Promise<ClaimOutcome> {
  const { workspaceId, campaignId, lead, subject, body, dailySendLimit, startOfToday, perDomainCap, linkedIntent, unsubscribeToken } = params
  const domain = emailDomain(lead.email)
  try {
    const claim = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      if (dailySendLimit != null) {
        const ok = await reserveDailySendSlot(tx, workspaceId, dailySendLimit, startOfToday)
        if (!ok) return 'DAILY_CAP' as const
      }
      if (perDomainCap != null && domain) {
        const ok = await reserveDomainSendSlot(tx, workspaceId, domain, perDomainCap, startOfToday)
        if (!ok) return 'DOMAIN_PACED' as const
      }
      return tx.outreachSent.create({
        data: {
          workspaceId, campaignId, leadId: lead.id,
          toEmail: lead.email!, toEmailDomain: domain, subject, body,
          unsubscribeToken, status: 'SENDING',
          ...(linkedIntent ? {
            outreachIntentId: linkedIntent.id,
            recommendationId: linkedIntent.recommendationId,
            evidenceSnapshot: linkedIntent.evidenceSnapshot ?? undefined,
          } : {}),
        },
        select: { id: true },
      })
    })
    if (claim === 'DAILY_CAP' || claim === 'DOMAIN_PACED') return { claimed: false, reason: claim }
    const claimId = claim.id
    // Release the claim on a pre-dispatch abort: nothing was sent, so delete the
    // row (freeing its reserved cap slot) and leave the lead eligible for a later run.
    const release = async () => { await prisma.outreachSent.delete({ where: { id: claimId } }).catch(() => {}) }
    return { claimed: true, claimId, release }
  } catch (err) {
    // Unique violation — another attempt already owns this send. No AI spent.
    if (isUniqueConstraintViolation(err)) return { claimed: false, reason: 'ALREADY_SENT' }
    throw err
  }
}

type GenerateDraftOutcome =
  | { kind: 'generated'; subject: string; body: string }
  | { kind: 'ai_limit' }
  | { kind: 'invalid_json' }
  | { kind: 'policy_review'; violations: DraftPolicyViolation[] }
  | { kind: 'error'; message: string }

/**
 * Generate (via AI), validate, and persist a fresh draft for a lead whose
 * claimed send slot has no existing draft to reuse. Re-checks the AI quota
 * right before the model call, parses+validates the model's JSON, runs the
 * tone/policy/grounding checks (collectDraftViolations), and on a violation
 * persists the draft as POLICY_REVIEW instead of continuing to send. Any AI
 * spend already reserved is refunded on every non-`generated` outcome.
 */
async function generateDraftForSend(
  lead: CampaignLeadRow,
  ctx: {
    workspaceId: string
    claimId: string
    icp: CampaignSendConfig['icp']
    missionCtx: CampaignSendConfig['missionCtx']
    draftPolicy: DraftPolicyConfig | undefined
    generateOutreachFn: typeof generateOutreach
  }
): Promise<GenerateDraftOutcome> {
  const { workspaceId, claimId, icp, missionCtx, draftPolicy, generateOutreachFn } = ctx
  try {
    await checkAndIncrementAiUsage(workspaceId, 'AI_OUTREACH')
  } catch {
    return { kind: 'ai_limit' }
  }

  try {
    const raw = await generateOutreachFn({
      businessName: lead.businessName,
      category:      lead.category   ?? undefined,
      city:          lead.city        ?? undefined,
      contactName:   lead.contactName ?? undefined,
      aiSummary:     lead.aiSummary   ?? undefined,
      outreachAngle: lead.outreachAngle ?? undefined,
      // Pass the workspace ICP (tone + product) merged with any per-mission
      // override (offer + target customer), so a mission's sends reflect that
      // mission rather than the generic seller profile.
      icp: (icp || missionCtx) ? {
        targetIndustries: icp?.targetIndustries,
        businessType: icp?.businessType ?? undefined,
        outreachTone: icp?.outreachTone ?? undefined,
        offer: missionCtx?.offer ?? undefined,
        targetCustomer: missionCtx?.targetCustomer ?? undefined,
      } : undefined,
    })
    // The provider call was made — record its estimated spend for the
    // acaos_ai_cost_cents_total metric (independent of quota refunds below,
    // which track plan usage, not real dollars already spent).
    incAiCost('AI_OUTREACH')
    // Strict, schema-validated parse. A draft with bad JSON or a missing
    // subject/body is unusable — refund the reserved call and report failure
    // rather than failing the whole batch.
    let parsed: OutreachDraftOutput
    try {
      parsed = parseAiJson(OutreachDraftOutputSchema, raw, 'send-campaign')
    } catch {
      await refundAiUsage(workspaceId, 'AI_OUTREACH').catch(() => {})
      return { kind: 'invalid_json' }
    }
    const subject = parsed.subject
    const body    = parsed.email
    const followup = parsed.followup ?? null

    // Record generation provenance (model + prompt version) so the draft is
    // auditable/reproducible. Best-effort — never blocks the send.
    const promptVersionId = await resolvePromptVersionId({ workspaceId, ...outreachGenerationMeta() })

    // Deterministic policy check on freshly generated copy. On a violation,
    // persist the draft as POLICY_REVIEW and report it — never auto-send
    // unreviewed copy that tripped a policy. (Unsubscribe compliance is NOT
    // checked here: the send footer guarantees a List-Unsubscribe link.)
    const grounding = [lead.businessName, lead.category, lead.city, lead.aiSummary, lead.outreachAngle, lead.notes]
      .filter(Boolean).join(' ')
    const violations = collectDraftViolations(
      { subject, body, followup },
      { text: grounding, hasPriorConnection: Boolean(lead.notes?.trim()) },
      draftPolicy,
    )
    if (violations.length > 0) {
      await prisma.outreachDraft.create({
        data: {
          leadId: lead.id, workspaceId, subject, emailBody: body, followup, promptVersionId,
          status: 'POLICY_REVIEW',
          policyViolations: { violations: violations.map(v => ({ code: v.code, message: v.message })) } as Prisma.InputJsonValue,
        }
      })
      console.log(`[send-campaign] Draft for lead ${lead.id} flagged POLICY_REVIEW: ${violations.map(v => v.code).join(', ')}`)
      return { kind: 'policy_review', violations }
    }

    // Persist the draft for reuse and fill the claim with the generated copy.
    await prisma.outreachDraft.create({
      data: { leadId: lead.id, workspaceId, subject, emailBody: body, followup, promptVersionId }
    })
    await prisma.outreachSent.update({ where: { id: claimId }, data: { subject, body } })
    return { kind: 'generated', subject, body }
  } catch (err) {
    console.error(`[send-campaign] Draft generation failed for lead ${lead.id}: ${(err as Error).message}`)
    // Generation failed after reserving the AI call — refund it.
    await refundAiUsage(workspaceId, 'AI_OUTREACH').catch(() => {})
    return { kind: 'error', message: err instanceof Error ? err.message : 'unknown error' }
  }
}

/**
 * Render and send the actual email for a claimed lead, then record the
 * outcome: on success, mark the outbox row SENT, advance the lead's stage,
 * append the ledger event, bump daily stats, and best-effort schedule the
 * next sequence step — all atomically with the send. On failure, mark the
 * outbox row FAILED (fail-closed: never auto-resent) and append a FAILED
 * ledger event, mirroring the success path's bookkeeping.
 */
async function dispatchOutreachEmail(p: {
  sendMailFn: typeof sendMail
  smtpCfg: SmtpConfig | null
  lead: CampaignLeadRow
  subject: string
  body: string
  claimId: string
  workspaceId: string
  campaignId: string
  appUrl: string
  unsubscribeToken: string
  senderBusinessName: string | null | undefined
  senderPostalAddress: string | null | undefined
  linkedIntent: { id: string } | null
  autoFollowupsEnabled: boolean
}): Promise<{ ok: true } | { ok: false }> {
  // Shared renderer: CAN-SPAM/CASL sender identity + physical address, unsubscribe
  // link, and a clean text/plain alternative — identical to the follow-up path.
  const { htmlBody, textBody, unsubscribeUrl } = buildOutreachEmail({
    body: p.body, appUrl: p.appUrl, unsubscribeToken: p.unsubscribeToken,
    senderBusinessName: p.senderBusinessName, senderPostalAddress: p.senderPostalAddress,
  })

  try {
    // RFC 2369 / 8058 one-click unsubscribe headers — the /api/unsubscribe
    // endpoint already serves a safe GET confirmation and a POST one-click
    // handler. Major mailbox providers require these for bulk senders.
    const info = await p.sendMailFn(p.lead.email!, p.subject, htmlBody, p.smtpCfg, {
      text: textBody,
      headers: {
        'List-Unsubscribe': `<${unsubscribeUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    })
    const msgId = (info as any).messageId ?? null

    await prisma.$transaction([
      prisma.outreachSent.update({
        where: { id: p.claimId },
        data: { messageId: msgId, status: 'SENT', sentAt: new Date() }
      }),
      prisma.lead.update({
        where: { id: p.lead.id },
        data: { stage: 'OUTREACH_SENT', lastContactedAt: new Date() }
      }),
      // Append the SENT lifecycle event to the contact ledger in the SAME
      // transaction as the send, so the ledger can never disagree with the outbox.
      prisma.contactEvent.create({
        data: contactEventData({ workspaceId: p.workspaceId, email: p.lead.email!, type: 'SENT', leadId: p.lead.id, campaignId: p.campaignId, outreachSentId: p.claimId }),
      }),
      // Increment the campaign's daily SENT counter atomically with the send.
      prisma.campaignDailyStats.upsert(campaignDailyStatsUpsertArgs({ workspaceId: p.workspaceId, campaignId: p.campaignId, date: new Date(), field: 'sent' })),
      // Advance the linked intent to SENT in the same transaction as the send.
      ...(p.linkedIntent ? [prisma.outreachIntent.update({ where: { id: p.linkedIntent.id }, data: { status: 'SENT' } })] : []),
    ])

    // Schedule the next sequence step (best-effort; no-op unless the campaign
    // opted into auto-followups and an active next step exists).
    void scheduleNextFollowup({
      workspaceId: p.workspaceId, campaignId: p.campaignId, leadId: p.lead.id, outreachSentId: p.claimId,
      currentStep: 1, sentAt: new Date(), autoFollowupsEnabled: p.autoFollowupsEnabled,
    }).catch(() => {})

    return { ok: true }
  } catch (err) {
    // Known SMTP rejection (nodemailer throws only when the provider did NOT
    // accept the message). Mark the claim FAILED with the error + failedAt for
    // operator review instead of deleting it — fail-closed: it won't be
    // auto-resent. (A crash AFTER provider acceptance leaves the row SENDING,
    // also never resent.) Operators can clear FAILED rows to deliberately retry.
    const message = err instanceof Error ? err.message : 'SMTP send failed'
    console.error(`[send-campaign] SMTP failed for lead ${p.lead.id}: ${message}`)
    // Mark the claim FAILED, append the FAILED ledger event, and bump the daily
    // failed counter ATOMICALLY (mirrors the SENT path) so the ledger/stats can't
    // disagree with the outbox. The whole tx is best-effort wrapped — a ledger
    // hiccup must never mask the SMTP failure itself (we still count it failed).
    await prisma.$transaction([
      prisma.outreachSent.update({
        where: { id: p.claimId },
        data: { status: 'FAILED', failedAt: new Date(), lastError: message.slice(0, 500) },
      }),
      prisma.contactEvent.create({
        data: contactEventData({ workspaceId: p.workspaceId, email: p.lead.email!, type: 'FAILED', leadId: p.lead.id, campaignId: p.campaignId, outreachSentId: p.claimId, metadata: { error: message.slice(0, 200) } }),
      }),
      prisma.campaignDailyStats.upsert(campaignDailyStatsUpsertArgs({ workspaceId: p.workspaceId, campaignId: p.campaignId, date: new Date(), field: 'failed' })),
    ]).catch((e) => console.error(`[send-campaign] FAILED-record tx error for lead ${p.lead.id}: ${e instanceof Error ? e.message : e}`))
    return { ok: false }
  }
}

/**
 * Execute a campaign: generate personalised outreach for each eligible lead
 * (or reuse an existing draft), send via SMTP, and record in OutreachSent for
 * closed-loop reply tracking. Processes leads serially to stay within plan limits.
 */
export async function sendCampaignBatch(
  campaignId: string,
  workspaceId: string,
  leadIds: string[] | undefined,
  progress?: Progress,
  // Optional injection seam: tests pass a `sendMail` stub so the suppression,
  // idempotency, and fail-closed paths can be exercised without real SMTP (the
  // real mailer does network I/O and SSRF-pins public hosts). Defaults to the
  // real mailer, so production callers (worker.ts) are unchanged. `pageSize`
  // lets a test exercise multi-page paging without seeding hundreds of leads.
  deps: { sendMail?: typeof sendMail; generateOutreach?: typeof generateOutreach; pageSize?: number } = {}
): Promise<SendCampaignResult> {
  const sendMailFn = deps.sendMail ?? sendMail
  // Injection seam (tests): generation is otherwise a live OpenAI call, so the
  // failure→refund/skip paths can't be exercised without it. Defaults to the real
  // generator, so production callers (worker.ts) are unchanged.
  const generateOutreachFn = deps.generateOutreach ?? generateOutreach

  const { icp, workspace, missionCtx, draftPolicy, autoFollowupsEnabled, smtpCfg } =
    await loadCampaignSendConfig(campaignId, workspaceId)

  let sent = 0
  let skipped = 0
  let failed = 0
  // Per-reason skip accounting so the result explains WHY leads didn't send.
  const skippedByReason: Record<SendSkipReason, number> = {
    ALREADY_SENT: 0, SUPPRESSED: 0, WORKSPACE_SUPPRESSED: 0, INVALID_EMAIL: 0, NO_APPROVED_DRAFT: 0,
    POLICY_REVIEW: 0, AI_LIMIT: 0, AI_GENERATION_FAILED: 0, DAILY_CAP: 0, MONTHLY_CAP: 0, MISSION_PAUSED: 0,
    REPUTATION_BLOCKED: 0, DOMAIN_PACED: 0, OUTSIDE_SEND_WINDOW: 0, CONSENT_REQUIRED: 0,
  }
  const skip = (reason: SendSkipReason, n = 1) => { skipped += n; skippedByReason[reason] += n; incSendOutcome('send-campaign', reason, n) }
  const result = (): SendCampaignResult => ({ campaignId, sent, skipped, failed, skippedByReason })

  // Per-contact consent gate — DORMANT unless COMPLIANCE_GATE_ENABLED (same
  // launch-control flag as getSendReadiness, so this never surprises an existing
  // workspace before the compliance surface is turned on for real). Once enabled:
  // a 'consent' lawful basis requires an on-file ConsentRecord for EVERY
  // recipient (GDPR Art. 6(1)(a) is per-data-subject, not a workspace-wide
  // attestation), and a Canada-targeting workspace requires one too (CASL
  // express/implied consent is required per recipient, not just "some" on file —
  // this tightens the workspace-level getSendReadiness check, which only proves
  // at least one record exists). Fail CLOSED: a lead with no matching record is
  // skipped, never sent.
  const consentRequired = isComplianceGateEnabled() &&
    (workspace?.lawfulBasis === 'consent' || workspace?.targetsCanada === true)
  const consentReason = workspace?.lawfulBasis === 'consent' ? 'lawful_basis_consent' : 'targets_canada'

  // Operator drain switch: halt all sends for a suppressed workspace before any
  // lead work, without touching the global FEATURE_SEND kill-switch. Counted as a
  // whole-batch skip so the suppression is visible in metrics.
  if (workspace?.sendSuppressed) {
    console.log(`[send-campaign] Workspace ${workspaceId} is send-suppressed — skipping campaign ${campaignId}`)
    incSendOutcome('send-campaign', 'WORKSPACE_SUPPRESSED')
    return result()
  }

  // Don't even start a batch for a paused/completed mission.
  const initialBlock = await getMissionSendBlockReason(campaignId)
  if (initialBlock) {
    console.log(`[send-campaign] Skipping campaign ${campaignId}: ${initialBlock}`)
    return result()
  }

  await progress?.(5)

  const where = {
    campaignId,
    workspaceId,
    email: { not: null as null },
    stage: { notIn: ['OUTREACH_SENT', 'REPLIED', 'BOOKED', 'CLOSED', 'DEAD'] as LeadStage[] },
    ...(leadIds ? { id: { in: leadIds } } : {})
  }

  // SAFE_LAUNCH_MODE forces human approval regardless of the workspace's own
  // setting, so a controlled launch never auto-sends freshly generated copy.
  const approvalRequired = effectiveApprovalMode(Boolean(icp?.approvalMode))

  const workspaceDailyLimit = icp?.dailySendLimit && icp.dailySendLimit > 0 ? icp.dailySendLimit : null
  // Effective cap = safe-launch clamp, then the opt-in warmup ramp (the more
  // restrictive of the two). Warmup is a no-op unless warmupStartedAt is set.
  const dailySendLimit = applyWarmupCap(effectiveDailySendLimit(workspaceDailyLimit), icp?.warmupStartedAt ?? null)
  // UTC day boundary — matches utcMonthStart() below and campaignStats.ts's own
  // day bucketing. A local-time setHours(0,0,0,0) would drift the daily window
  // relative to the monthly one (and relative to whatever the container's TZ
  // happens to be), letting a workspace's daily and monthly caps disagree on
  // where "today" starts.
  const startOfToday = utcDayStart(new Date())

  // Total eligible via one COUNT (not a full load) — drives progress and the
  // skipped tally without holding every lead in memory.
  const total = await prisma.lead.count({ where })

  // Daily send cap fast path: if the workspace already hit today's cap, skip the
  // whole batch. The authoritative enforcement is still the per-lead atomic
  // reservation (reserveDailySendSlot) inside the claim, which holds across pages.
  // SAFE_LAUNCH_MODE clamps the workspace's own cap to the low safe ceiling.
  if (dailySendLimit != null) {
    const usedToday = await prisma.outreachSent.count({
      where: { workspaceId, status: { in: ['SENT', 'SENDING'] }, sentAt: { gte: startOfToday } }
    })
    if (usedToday >= dailySendLimit) {
      console.log(`[send-campaign] Daily limit of ${dailySendLimit} reached for workspace ${workspaceId}`)
      skip('DAILY_CAP', total)
      return result()
    }
  }

  // Monthly send ceiling fast path (opt-in): a coarse backstop to the daily cap. A
  // batch is halted once the workspace hits its monthly limit; overshoot is bounded
  // by at most one day's cap since each day's batch is independently daily-capped.
  const monthlySendLimit = icp?.monthlySendLimit && icp.monthlySendLimit > 0 ? icp.monthlySendLimit : null
  if (monthlySendLimit != null) {
    const usedThisMonth = await prisma.outreachSent.count({
      where: { workspaceId, status: { in: ['SENT', 'SENDING'] }, sentAt: { gte: utcMonthStart() } }
    })
    if (usedThisMonth >= monthlySendLimit) {
      console.log(`[send-campaign] Monthly limit of ${monthlySendLimit} reached for workspace ${workspaceId}`)
      skip('MONTHLY_CAP', total)
      return result()
    }
  }

  // Sender-reputation circuit breaker: if this workspace's trailing bounce/complaint
  // rate has degraded past the threshold, halt the whole batch before any dispatch.
  // 'observe' (default) only logs; 'enforce' actually stops. Fail-safe: it only ever
  // PREVENTS sends, and a ledger-read error is treated as healthy (never blocks).
  const guardMode = reputationGuardMode()
  if (guardMode !== 'off') {
    const rep = await evaluateSenderReputation(workspaceId).catch(() => null)
    if (rep && !rep.healthy) {
      console.warn(`[send-campaign] reputation ${rep.reason} for workspace ${workspaceId} ` +
        `(bounceRate=${rep.bounceRate.toFixed(3)} complaintRate=${rep.complaintRate.toFixed(3)} sends=${rep.totalSends}) mode=${guardMode}`)
      if (guardMode === 'enforce') {
        incReputationBlock('send-campaign')
        skip('REPUTATION_BLOCKED', total)
        return result()
      }
    }
  }

  // Opt-in send window (quiet hours): outside the workspace's configured window,
  // halt the batch before any dispatch. Leads are NOT failed/advanced — they stay
  // eligible for the next launch (same semantics as a mission pause). A no-op
  // unless a window is configured on the workspace ICP.
  const sendWindow = resolveSendWindow(icp)
  if (sendWindow && !isWithinSendWindow(new Date(), sendWindow)) {
    console.log(`[send-campaign] Outside send window for workspace ${workspaceId}; halting (eligible=${total})`)
    skip('OUTSIDE_SEND_WINDOW', total)
    return result()
  }

  // Per-recipient-domain pacing (opt-in via PER_DOMAIN_DAILY_CAP). Seed today's
  // per-domain counts once, then enforce + increment in the loop so a campaign heavy
  // on one provider can't burst past the cap — across pages and prior runs today.
  const perDomainCap = perDomainDailyCap()
  // Seed via an INDEXED groupBy (one row per distinct domain), not a full-day load
  // of every send into memory. Backed by (workspaceId, toEmailDomain, status, sentAt).
  const domainCounts: Map<string, number> | null = perDomainCap != null
    ? new Map(
        (await prisma.outreachSent.groupBy({
          by: ['toEmailDomain'],
          where: { workspaceId, status: { in: ['SENT', 'SENDING'] }, sentAt: { gte: startOfToday }, toEmailDomain: { not: null } },
          _count: { _all: true },
        })).map((r: { toEmailDomain: string | null; _count: { _all: number } }) => [r.toEmailDomain as string, r._count._all]),
      )
    : null

  const appUrl = (process.env.API_URL || 'http://localhost:4000').replace(/\/$/, '')

  await progress?.(10)

  // Paginate eligible leads by id so a large campaign never loads them all into
  // memory. Each page re-loads its own fast-path sets and the per-lead mission
  // re-check still runs inside, so a pause stops mid-page (and certainly before
  // the next page). The daily cap is enforced across pages by the per-lead
  // advisory-locked reservation. We use an explicit `id > cursor` filter (not
  // Prisma's positional cursor) because a lead drops out of `where` once it's
  // sent, which would invalidate a cursor row.
  const PAGE = deps.pageSize && deps.pageSize > 0 ? deps.pageSize : 250
  let cursor: string | undefined
  pageLoop: for (;;) {
    const page = await prisma.lead.findMany({
      where: cursor ? { AND: [where, { id: { gt: cursor } }] } : where,
      include: {
        // When approval is required, only include APPROVED drafts. A lead that ends
        // up with no included draft is skipped in the send loop (never sent with
        // freshly generated copy — that would bypass approval). In non-approval mode
        // the latest draft is used, EXCEPT REJECTED / POLICY_REVIEW drafts a human or
        // the policy checker set aside, which must never be auto-sent.
        outreachDrafts: {
          where: approvalRequired
            ? { status: 'APPROVED' }
            : { status: { notIn: ['REJECTED', 'POLICY_REVIEW'] } },
          orderBy: { createdAt: 'desc' },
          take: 1
        }
      },
      orderBy: { id: 'asc' },
      take: PAGE,
    }) as CampaignLeadRow[]
    if (page.length === 0) break

    // Per-page fast-path sets — scoped to this page's leads (one query each per
    // page instead of one for the whole campaign). These are pre-filters/caches
    // only; the atomic per-lead claim (unique (campaignId, leadId)) remains the
    // real race guard. Mission status is NOT cached — it's re-checked per lead.
    const { isSuppressed, hasConsent, alreadySentLeadIds, policyReviewLeadIds, linkedIntentByLeadId } =
      await loadPageFastPathSets(page, workspaceId, campaignId, consentRequired)

    for (const lead of page) {

    // Progress: 10% → 90% across the campaign (by leads handled so far / total).
    await progress?.(10 + Math.floor(((sent + skipped + failed) / (total || 1)) * 80))

    // Mission pause/complete is an operator stop button: re-check before each lead
    // so a pause issued mid-run halts the rest of the batch (across pages) before
    // any further AI generation, outbox claim, or SMTP dispatch.
    const blockReason = await getMissionSendBlockReason(campaignId)
    if (blockReason) {
      const remaining = total - sent - skipped - failed
      console.log(`[send-campaign] Stopping campaign ${campaignId}: ${blockReason}; skipped remaining=${remaining}`)
      skip('MISSION_PAUSED', remaining)
      break pageLoop
    }

    // Cheap pre-check before any AI work: skip leads already sent to, in-flight,
    // or terminally failed for this campaign. This is an in-memory membership
    // test against the batch's pre-loaded OutreachSent rows (one bulk query
    // above) instead of a per-lead query. The unique (campaignId, leadId)
    // constraint on the claim below remains the real safety net against
    // duplicate sends. FAILED is fail-closed (not auto-retried) — surfaced for
    // operator review rather than blindly resent.
    if (alreadySentLeadIds.has(lead.id)) { skip('ALREADY_SENT'); continue }

    // Skip suppressed addresses (unsubscribed or bounced)
    if (isSuppressed(lead.email!)) { skip('SUPPRESSED'); continue }

    // Reject structurally-invalid addresses before claiming/generating — a bad
    // address would only burn an SMTP attempt and hurt sender reputation.
    if (!isDeliverableEmail(lead.email)) { skip('INVALID_EMAIL'); continue }

    // Compliance gate (dormant unless COMPLIANCE_GATE_ENABLED): a consent-basis or
    // Canada-targeting workspace must have an on-file ConsentRecord for THIS
    // recipient — fail closed, never send on the strength of "some" workspace has
    // consent recorded. Audited per skip (fire-and-forget) for the SAR/compliance
    // trail; never blocks the send loop even if the audit write fails.
    if (consentRequired && !hasConsent(lead.email!)) {
      skip('CONSENT_REQUIRED')
      void recordAudit({
        workspaceId, type: 'consent.enforcement.skipped', entityType: 'lead', entityId: lead.id,
        metadata: { campaignId, reason: consentReason },
      })
      continue
    }

    // Per-domain pacing: don't burst past the provider's tolerance for one domain.
    if (domainCounts) {
      const d = emailDomain(lead.email)
      if (d && (domainCounts.get(d) ?? 0) >= perDomainCap!) { skip('DOMAIN_PACED'); continue }
    }

    // Resolve the draft source WITHOUT spending AI yet. The outbox claim below
    // happens BEFORE any generation, so a racing send job loses the unique
    // (campaignId, leadId) claim and skips before burning AI quota — no duplicate
    // AI spend and no duplicate draft (the previous order generated first).
    const draftSource = resolveDraftSource(lead, { approvalRequired, policyReviewLeadIds })
    if (draftSource.action === 'skip') { skip(draftSource.reason); continue }
    let subject: string | null = draftSource.action === 'reuse' ? draftSource.subject : null
    let body: string | null = draftSource.action === 'reuse' ? draftSource.body : null
    const needGeneration = draftSource.action === 'generate'

    // Provenance (Stage 5): an APPROVED OutreachIntent linked to this lead, stamped
    // onto the claim so the record is self-auditable and marked SENT on success.
    // Resolved from the batch-wide pre-loaded map (no per-lead DB round-trip).
    const linkedIntent = linkedIntentByLeadId.get(lead.id) ?? null
    const unsubscribeToken = randomBytes(24).toString('hex')

    // CLAIM FIRST: reserve the daily-cap (and per-domain-cap) slot and insert
    // the unique outbox row before generating — see claimOutboxSlot's doc
    // comment for why. The in-memory domainCounts pre-check above is only a
    // fast-path to skip obviously-paced leads before spending AI; this atomic
    // recheck is the actual enforcement against concurrent batches/tasks.
    const claimOutcome = await claimOutboxSlot({
      workspaceId, campaignId, lead, subject, body, dailySendLimit, startOfToday, perDomainCap, linkedIntent, unsubscribeToken,
    })
    if (!claimOutcome.claimed) {
      if (claimOutcome.reason === 'DAILY_CAP') {
        // Daily cap reached mid-batch — skip the remaining leads (across pages) and stop.
        const remaining = total - sent - skipped - failed
        console.log(`[send-campaign] Daily limit of ${dailySendLimit} reached mid-batch for workspace ${workspaceId}; skipped remaining=${remaining}`)
        skip('DAILY_CAP', remaining)
        break pageLoop
      }
      if (claimOutcome.reason === 'DOMAIN_PACED') { skip('DOMAIN_PACED'); continue }
      skip('ALREADY_SENT'); continue
    }
    const claimId = claimOutcome.claimId
    const releaseClaim = claimOutcome.release

    // Generate now that the claim is held (a racing job has already lost it, so this
    // AI call happens at most once per (campaign, lead)).
    if (needGeneration) {
      const outcome = await generateDraftForSend(lead, { workspaceId, claimId, icp, missionCtx, draftPolicy, generateOutreachFn })
      switch (outcome.kind) {
        case 'ai_limit':
          await releaseClaim(); skip('AI_LIMIT'); continue
        case 'invalid_json':
          await releaseClaim(); skip('AI_GENERATION_FAILED'); continue
        case 'policy_review':
          await releaseClaim(); skip('POLICY_REVIEW'); continue
        case 'error':
          await releaseClaim(); failed++; incSendOutcome('send-campaign', 'failed'); continue
        case 'generated':
          subject = outcome.subject
          body = outcome.body
          break
      }
    }

    // Past this point subject/body are non-null (reused draft or freshly generated).
    // Guard defensively so a logic slip fails this one lead, not the whole batch.
    if (subject == null || body == null) { await releaseClaim(); failed++; incSendOutcome('send-campaign', 'failed'); continue }

    const dispatchOutcome = await dispatchOutreachEmail({
      sendMailFn, smtpCfg, lead, subject, body, claimId,
      workspaceId, campaignId, appUrl, unsubscribeToken,
      senderBusinessName: workspace?.senderBusinessName,
      senderPostalAddress: workspace?.senderPostalAddress,
      linkedIntent, autoFollowupsEnabled,
    })
    if (dispatchOutcome.ok) {
      sent++
      incSendOutcome('send-campaign', 'sent')
      if (domainCounts) { const d = emailDomain(lead.email); if (d) domainCounts.set(d, (domainCounts.get(d) ?? 0) + 1) }
    } else {
      failed++
      incSendOutcome('send-campaign', 'failed')
    }
    } // end per-lead loop for this page

    // Advance the cursor; a short page means we've reached the end.
    cursor = page[page.length - 1].id
    if (page.length < PAGE) break
  }

  await progress?.(100)
  return result()
}

// ── send-followup: dispatch one due sequence step ─────────────────────────────
// Reuses the claim-first send mechanics for a single FollowupTask. Gated by the
// campaign's autoFollowupsEnabled AND the global FOLLOWUPS_ENABLED (checked by the
// worker before calling this). Every dispatch re-runs canContactRecipient, so a
// reply/bounce/unsubscribe/terminal-stage/cap that happened since scheduling stops
// the send. The task is claimed SCHEDULED→PROCESSING atomically so two workers
// can't double-send.
export type SendFollowupStatus = 'SENT' | 'FAILED' | 'BLOCKED' | 'CANCELLED' | 'SKIPPED'
export interface SendFollowupResult { taskId: string; status: SendFollowupStatus; reason?: string }

export async function sendFollowupTask(
  taskId: string,
  deps: { sendMail?: typeof sendMail } = {}
): Promise<SendFollowupResult> {
  const sendMailFn = deps.sendMail ?? sendMail

  // Atomic claim: only one worker can move a task out of SCHEDULED.
  const claimed = await prisma.followupTask.updateMany({
    where: { id: taskId, status: 'SCHEDULED' },
    data: { status: 'PROCESSING' },
  })
  if (claimed.count === 0) return { taskId, status: 'SKIPPED', reason: 'not SCHEDULED' }

  const task = await prisma.followupTask.findUnique({ where: { id: taskId } })
  if (!task) return { taskId, status: 'SKIPPED', reason: 'gone' }
  const { workspaceId, campaignId, leadId, stepNumber } = task

  // Move the task to a terminal/explainable DB state and surface a result. The
  // result status ('SKIPPED') and the persisted FollowupTaskStatus can differ:
  // a cap-deferred task reports SKIPPED but is parked back at SCHEDULED.
  const finish = async (
    result: SendFollowupStatus,
    dbStatus: FollowupTaskStatus,
    data: Prisma.FollowupTaskUpdateInput = {},
  ): Promise<SendFollowupResult> => {
    await prisma.followupTask.update({ where: { id: taskId }, data: { status: dbStatus, ...data } }).catch(() => {})
    const reason = typeof data.cancelledReason === 'string' ? data.cancelledReason
      : typeof data.lastError === 'string' ? data.lastError : undefined
    return { taskId, status: result, reason }
  }

  const [campaign, lead, step, wsCfg, icp, workspace] = await Promise.all([
    prisma.campaign.findUnique({ where: { id: campaignId }, select: { autoFollowupsEnabled: true } }),
    prisma.lead.findUnique({ where: { id: leadId }, select: { email: true, stage: true } }),
    prisma.outreachSequenceStep.findUnique({ where: { campaignId_stepNumber: { campaignId, stepNumber } }, select: { subject: true, body: true, isActive: true } }),
    prisma.workspaceEmailConfig.findUnique({ where: { workspaceId } }),
    prisma.workspaceICP.findUnique({ where: { workspaceId }, select: { dailySendLimit: true, monthlySendLimit: true, warmupStartedAt: true, sendWindowStartHour: true, sendWindowEndHour: true, sendTimezone: true, sendWeekdaysOnly: true } }),
    // Sender identity for the CAN-SPAM/CASL physical-address line — every commercial
    // message needs it, follow-ups included (previously omitted here).
    prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { senderBusinessName: true, senderPostalAddress: true, sendSuppressed: true, lawfulBasis: true, targetsCanada: true },
    }),
  ])

  // Guards (each leaves the task in a terminal, explainable state).
  if (!campaign?.autoFollowupsEnabled) return finish('CANCELLED', 'CANCELLED', { cancelledReason: 'CAMPAIGN_PAUSED' })
  const missionBlock = await getMissionSendBlockReason(campaignId)
  if (missionBlock) return finish('BLOCKED', 'BLOCKED', { cancelledReason: 'MISSION_PAUSED' })
  if (!lead?.email) return finish('CANCELLED', 'CANCELLED', { cancelledReason: 'LEAD_GONE' })
  if (!step || !step.isActive) return finish('CANCELLED', 'CANCELLED', { cancelledReason: 'STEP_INACTIVE' })
  const smtpCfg: SmtpConfig | null = wsCfg ?? null
  if (!isMailConfigured(smtpCfg)) return finish('BLOCKED', 'BLOCKED', { cancelledReason: 'SMTP_NOT_CONFIGURED' })

  // Sender-reputation circuit breaker (same modes as the campaign sender). A
  // degraded workspace blocks the follow-up in 'enforce'; 'observe' only logs.
  const guardMode = reputationGuardMode()
  if (guardMode !== 'off') {
    const rep = await evaluateSenderReputation(workspaceId).catch(() => null)
    if (rep && !rep.healthy) {
      if (guardMode === 'enforce') { incReputationBlock('send-followup'); return finish('BLOCKED', 'BLOCKED', { cancelledReason: 'REPUTATION_BLOCKED' }) }
      console.warn(`[send-followup] reputation ${rep.reason} for workspace ${workspaceId} (observe) — proceeding`)
    }
  }

  // Contact policy: re-checked at send time, not just at scheduling.
  const decision = await canContactRecipient({ workspaceId, email: lead.email, leadId })
  if (!decision.allowed) return finish('BLOCKED', 'BLOCKED', { cancelledReason: decision.reason })

  // Compliance gate (dormant unless COMPLIANCE_GATE_ENABLED) — same rule as the
  // initial campaign send: a consent-basis or Canada-targeting workspace needs an
  // on-file ConsentRecord for THIS recipient, re-checked at send time since a
  // follow-up can fire long after the original send (and any consent basis on
  // file then may no longer apply). Fail closed.
  if (isComplianceGateEnabled() && (workspace?.lawfulBasis === 'consent' || workspace?.targetsCanada === true)) {
    const consented = await hasConsent(workspaceId, lead.email)
    if (!consented) {
      // Awaited (unlike the campaign-batch per-lead loop above): this runs once
      // per follow-up task, not in a tight per-lead loop, so durability here
      // costs nothing worth trading away for the SAR/compliance trail.
      await recordCriticalAudit({
        workspaceId, type: 'consent.enforcement.skipped', entityType: 'lead', entityId: leadId,
        metadata: { campaignId, reason: workspace?.lawfulBasis === 'consent' ? 'lawful_basis_consent' : 'targets_canada', followup: true },
      })
      return finish('BLOCKED', 'BLOCKED', { cancelledReason: 'CONSENT_REQUIRED' })
    }
  }

  // Build the follow-up email from the sequence step, via the SAME renderer the
  // initial campaign send uses — so the sender identity + physical address (and
  // unsubscribe) are present and the two paths can't drift again.
  const subject = (step.subject && step.subject.trim()) || 'Following up'
  const body = step.body
  const unsubscribeToken = randomBytes(24).toString('hex')
  const appUrl = (process.env.API_URL || 'http://localhost:4000').replace(/\/$/, '')
  const { htmlBody, textBody, unsubscribeUrl } = buildOutreachEmail({
    body, appUrl, unsubscribeToken,
    senderBusinessName: workspace?.senderBusinessName,
    senderPostalAddress: workspace?.senderPostalAddress,
  })

  // UTC day boundary — see the matching comment in sendCampaignBatch; must stay
  // in lockstep with the monthly cap's UTC window and the daily cap on the main
  // send path, or a followup and a fresh send could disagree on "today".
  const startOfToday = utcDayStart(new Date())
  const wsDailyLimit = icp?.dailySendLimit && icp.dailySendLimit > 0 ? icp.dailySendLimit : null
  const dailySendLimit = applyWarmupCap(effectiveDailySendLimit(wsDailyLimit), icp?.warmupStartedAt ?? null)

  // Opt-in send window: outside quiet hours, defer — park the task back at SCHEDULED
  // so the next scan retries it once the window reopens. A no-op unless configured.
  const sendWindow = resolveSendWindow(icp)
  if (sendWindow && !isWithinSendWindow(new Date(), sendWindow)) {
    await prisma.followupTask.update({ where: { id: taskId }, data: { status: 'SCHEDULED' } }).catch(() => {})
    return { taskId, status: 'SKIPPED', reason: 'OUTSIDE_SEND_WINDOW' }
  }

  // Monthly send ceiling (opt-in): defer if the workspace hit its monthly limit —
  // park back at SCHEDULED so the scanner retries (and naturally proceeds next month).
  const monthlySendLimit = icp?.monthlySendLimit && icp.monthlySendLimit > 0 ? icp.monthlySendLimit : null
  if (monthlySendLimit != null) {
    const usedThisMonth = await prisma.outreachSent.count({
      where: { workspaceId, status: { in: ['SENT', 'SENDING'] }, sentAt: { gte: utcMonthStart() } },
    })
    if (usedThisMonth >= monthlySendLimit) {
      await prisma.followupTask.update({ where: { id: taskId }, data: { status: 'SCHEDULED' } }).catch(() => {})
      return { taskId, status: 'SKIPPED', reason: 'MONTHLY_CAP' }
    }
  }

  // Per-domain pacing (opt-in). This in-memory pre-check is only a fast-path to
  // defer obviously-paced tasks before opening a transaction; it does not by
  // itself prevent a burst, since a concurrent send-campaign/send-followup job
  // for the same domain could pass the same pre-check. The atomic recheck
  // inside the claim transaction below (reserveDomainSendSlot) is the actual
  // enforcement.
  const perDomainCap = perDomainDailyCap()
  const domain = emailDomain(lead.email)
  if (perDomainCap != null && domain) {
    const domainToday = await prisma.outreachSent.count({
      where: { workspaceId, status: { in: ['SENT', 'SENDING'] }, sentAt: { gte: startOfToday }, toEmailDomain: domain },
    })
    if (domainToday >= perDomainCap) {
      await prisma.followupTask.update({ where: { id: taskId }, data: { status: 'SCHEDULED' } }).catch(() => {})
      return { taskId, status: 'SKIPPED', reason: 'DOMAIN_PACED' }
    }
  }

  // Claim the outbox row for THIS step (unique on campaignId, leadId, sequenceStep).
  let claimId: string
  try {
    const claim = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      if (dailySendLimit != null) {
        const ok = await reserveDailySendSlot(tx, workspaceId, dailySendLimit, startOfToday)
        if (!ok) return 'DAILY_CAP' as const
      }
      if (perDomainCap != null && domain) {
        const ok = await reserveDomainSendSlot(tx, workspaceId, domain, perDomainCap, startOfToday)
        if (!ok) return 'DOMAIN_PACED' as const
      }
      return tx.outreachSent.create({
        data: { workspaceId, campaignId, leadId, sequenceStep: stepNumber, toEmail: lead.email!, toEmailDomain: domain, subject, body, unsubscribeToken, status: 'SENDING' },
        select: { id: true },
      })
    })
    if (claim === 'DAILY_CAP') {
      // Daily cap reached — park the task back at SCHEDULED (not a terminal state,
      // so no cancelledReason) to retry on a later run.
      await prisma.followupTask.update({ where: { id: taskId }, data: { status: 'SCHEDULED' } }).catch(() => {})
      return { taskId, status: 'SKIPPED', reason: 'DAILY_CAP_EXCEEDED' }
    }
    if (claim === 'DOMAIN_PACED') {
      await prisma.followupTask.update({ where: { id: taskId }, data: { status: 'SCHEDULED' } }).catch(() => {})
      return { taskId, status: 'SKIPPED', reason: 'DOMAIN_PACED' }
    }
    claimId = claim.id
  } catch (err) {
    // This step was already sent (race) — mark the task done, don't double-send.
    if ((err as { code?: string }).code === 'P2002') return finish('SENT', 'SENT')
    throw err
  }

  try {
    const info = await sendMailFn(lead.email!, subject, htmlBody, smtpCfg, {
      text: textBody,
      headers: { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
    })
    const msgId = (info as { messageId?: string }).messageId ?? null
    await prisma.$transaction([
      prisma.outreachSent.update({ where: { id: claimId }, data: { messageId: msgId, status: 'SENT', sentAt: new Date() } }),
      prisma.lead.update({ where: { id: leadId }, data: { lastContactedAt: new Date() } }),
      prisma.contactEvent.create({ data: contactEventData({ workspaceId, email: lead.email!, type: 'SENT', leadId, campaignId, outreachSentId: claimId }) }),
      prisma.campaignDailyStats.upsert(campaignDailyStatsUpsertArgs({ workspaceId, campaignId, date: new Date(), field: 'sent' })),
      prisma.followupTask.update({ where: { id: taskId }, data: { status: 'SENT', outreachSentId: claimId } }),
    ])
    // Schedule the next step in the sequence. Awaited (so it's attempted before
    // the job completes) but best-effort: the send already committed, so a
    // scheduling hiccup must never fail it — the periodic scan re-drives anything
    // missed and scheduleNextFollowup is idempotent.
    await scheduleNextFollowup({ workspaceId, campaignId, leadId, outreachSentId: claimId, currentStep: stepNumber, sentAt: new Date(), autoFollowupsEnabled: true })
      .catch((e) => console.error(`[send-followup] schedule-next failed for task ${taskId}: ${e instanceof Error ? e.message : e}`))
    return { taskId, status: 'SENT' }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'SMTP send failed'
    // Atomic FAILED record: outbox → FAILED, a FAILED ledger event, the daily failed
    // counter, and the task → FAILED, in one transaction. Previously the follow-up
    // failure path wrote NO ContactEvent/stat at all, so follow-up SMTP failures were
    // invisible to the ledger and CampaignDailyStats — fixed here.
    await prisma.$transaction([
      prisma.outreachSent.update({ where: { id: claimId }, data: { status: 'FAILED', failedAt: new Date(), lastError: message.slice(0, 500) } }),
      prisma.contactEvent.create({ data: contactEventData({ workspaceId, email: lead.email!, type: 'FAILED', leadId, campaignId, outreachSentId: claimId, metadata: { error: message.slice(0, 200) } }) }),
      prisma.campaignDailyStats.upsert(campaignDailyStatsUpsertArgs({ workspaceId, campaignId, date: new Date(), field: 'failed' })),
      prisma.followupTask.update({ where: { id: taskId }, data: { status: 'FAILED', lastError: message.slice(0, 500) } }),
    ]).catch((e) => console.error(`[send-followup] FAILED-record tx error for task ${taskId}: ${e instanceof Error ? e.message : e}`))
    return { taskId, status: 'FAILED', reason: message }
  }
}

// ── discover-prospects: provider search + import, off-request ─────────────────
// The /discover route creates a DiscoveryRun(RUNNING) with the resolved query
// stored on it and enqueues this job, returning 202 immediately. Here we call
// the (slow/flaky) provider and import the results, then finalize the run:
//   - provider error            → FAILED (no rows touched)
//   - import threw mid-batch     → PARTIAL with the counts imported so far
//   - completed                  → SUCCEEDED with counts
// Idempotent enough for safety: re-running dedupes against existing prospects.
export interface DiscoverProspectsResult {
  runId: string
  status: 'SUCCEEDED' | 'PARTIAL' | 'FAILED'
  imported: number
  skipped: number
  total: number
}

export async function discoverProspectsBatch(
  runId: string,
  workspaceId: string,
  progress?: Progress,
  // Injection seam: tests pass a `search` stub so the FAILED/PARTIAL/SUCCEEDED
  // paths can be exercised without a live provider. Defaults to the real source
  // registry resolved from the run's `source`.
  deps: { search?: (input: ProspectSearchInput) => Promise<ProspectCandidate[]> } = {}
): Promise<DiscoverProspectsResult> {
  const run = await prisma.discoveryRun.findUnique({
    where: { id: runId },
    select: { id: true, workspaceId: true, missionId: true, source: true, status: true, query: true },
  })
  // Tenant + state guards: a forged/replayed job can't touch another workspace's
  // run, and a run already finalized (or re-enqueued) is not reprocessed.
  if (!run || run.workspaceId !== workspaceId) {
    return { runId, status: 'FAILED', imported: 0, skipped: 0, total: 0 }
  }
  if (run.status !== 'RUNNING') {
    return { runId, status: run.status as DiscoverProspectsResult['status'], imported: 0, skipped: 0, total: 0 }
  }

  await progress?.(5)

  const query = (run.query ?? {}) as ProspectSearchInput
  const searchFn = deps.search ?? (async (input: ProspectSearchInput) => {
    const source = getSource(run.source)
    if (!source) throw new Error(`Unknown discovery source: ${run.source}`)
    return source.search(input)
  })

  // 1. Provider search — a failure here means nothing was imported: mark FAILED.
  let candidates: ProspectCandidate[]
  try {
    candidates = await searchFn(query)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Discovery provider error'
    const code = (err as { code?: string }).code ?? 'PROVIDER_ERROR'
    await prisma.discoveryRun.update({
      where: { id: run.id },
      data: { status: 'FAILED', errorCode: code, errorMessage: message.slice(0, 500), finishedAt: new Date() },
    }).catch(() => {})
    return { runId, status: 'FAILED', imported: 0, skipped: 0, total: 0 }
  }

  await progress?.(20)

  if (candidates.length === 0) {
    await prisma.discoveryRun.update({
      where: { id: run.id },
      data: { status: 'SUCCEEDED', resultCount: 0, finishedAt: new Date() },
    })
    return { runId, status: 'SUCCEEDED', imported: 0, skipped: 0, total: 0 }
  }

  const icpRecord = await prisma.workspaceICP.findUnique({ where: { workspaceId } })
  const icp: ICPConfig | undefined = icpRecord ? {
    targetIndustries: icpRecord.targetIndustries,
    minEmployees: icpRecord.minEmployees ?? undefined,
    maxEmployees: icpRecord.maxEmployees ?? undefined,
    targetGeos: icpRecord.targetGeos,
    mustHaveEmail: icpRecord.mustHaveEmail,
  } : undefined

  // 2. Import. Track running counts so a fatal mid-batch error (e.g. the DB going
  // away) can be recorded as PARTIAL with what actually landed.
  let imported = 0
  let skipped = 0
  try {
    const result = await importDiscoveredProspects({
      workspaceId,
      missionId: run.missionId,
      sourceName: run.source,
      candidates,
      icp,
      onProgress: (imp, skp) => { imported = imp; skipped = skp },
    })
    imported = result.imported
    skipped = result.skipped
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Discovery import error'
    await prisma.discoveryRun.update({
      where: { id: run.id },
      data: {
        status: 'PARTIAL',
        resultCount: candidates.length,
        importedCount: imported,
        skippedCount: skipped,
        errorCode: 'IMPORT_INTERRUPTED',
        errorMessage: message.slice(0, 500),
        finishedAt: new Date(),
      },
    }).catch(() => {})
    // Best-effort scoring of whatever did land, then surface the failure.
    if (imported > 0) enqueueScoreProspects(workspaceId).catch(() => {})
    return { runId, status: 'PARTIAL', imported, skipped, total: candidates.length }
  }

  await progress?.(90)

  if (imported > 0) enqueueScoreProspects(workspaceId).catch(() => {})

  await prisma.discoveryRun.update({
    where: { id: run.id },
    data: {
      status: 'SUCCEEDED',
      resultCount: candidates.length,
      importedCount: imported,
      skippedCount: skipped,
      finishedAt: new Date(),
    },
  })

  await progress?.(100)
  return { runId, status: 'SUCCEEDED', imported, skipped, total: candidates.length }
}

// ── analyze-reply: apply a parsed reply classification ────────────────────────
// The DB effects of the analyze-reply job, extracted from worker.ts so they can be
// tested against a real database without OpenAI or BullMQ. worker.ts calls the AI,
// parses (fail-closed), then hands the parsed result here. Behavior-preserving.
export async function applyReplyAnalysis(leadId: string, parsed: ReplyAnalysisOutput): Promise<void> {
  // Read the lead first: confirm it exists + capture its workspace, and scope every
  // write by workspaceId so a forged/mis-routed job can't touch another tenant.
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    select: { workspaceId: true, score: true },
  })
  if (!lead) return

  // Stamp AI-derived reply metadata onto the send that just flipped to REPLIED so
  // the Inbox can show classification/summary/suggested action — for every
  // classification, incl. auto-replies. The raw reply body is never persisted.
  const target = await prisma.outreachSent.findFirst({
    where: { leadId, workspaceId: lead.workspaceId, status: 'REPLIED' },
    orderBy: { repliedAt: 'desc' },
    select: { id: true },
  })
  if (target) {
    await prisma.outreachSent.update({
      where: { id: target.id },
      data: {
        replyIntent: parsed.classification,
        replySummary: parsed.summary ?? null,
        replyKeyQuote: parsed.keyQuote ?? null,
        replySuggestedAction: parsed.suggestedAction ?? null,
        replyUrgency: parsed.urgency ?? null,
        replyConfidence: parsed.confidence != null ? Math.round(parsed.confidence) : null,
        replyIsAutoReply: parsed.isAutoReply ?? false,
      },
    })
  }

  // Auto-replies (OOO/bounce-like) carry no buying intent — record them on the send
  // (above) but never advance the lead or feed the scoring model.
  if (parsed.isAutoReply) return

  // Activation-funnel: a genuine (non-auto) reply is "first value". Best-effort.
  void trackEvent({ name: 'reply.received', workspaceId: lead.workspaceId, properties: { leadId, classification: parsed.classification } })
  // Notify any customer webhook endpoints subscribed to reply.received. Best-effort.
  void emitWebhookEvent(lead.workspaceId, 'reply.received', { leadId, classification: parsed.classification })

  // Confidence-gate the one IRREVERSIBLE consequence (NOT_INTERESTED → DEAD): a
  // low-confidence negative is downgraded to NEEDS_MORE_INFO so the lead is kept
  // for human review rather than auto-killed. The raw classification/confidence were
  // already stamped on the send above; only the automated effects use the gated value.
  const effectiveClassification = effectiveReplyClassification(parsed.classification, parsed.confidence)

  const stageMap: Record<string, LeadStage> = {
    INTERESTED: 'REPLIED',
    NOT_INTERESTED: 'DEAD',
    NEEDS_MORE_INFO: 'REPLIED',
    NOT_NOW: 'REPLIED',
    REFERRAL: 'REPLIED',
    OUT_OF_OFFICE: 'OUTREACH_SENT',
  }
  const newStage = stageMap[effectiveClassification]
  if (newStage) {
    await prisma.lead.updateMany({ where: { id: leadId, workspaceId: lead.workspaceId }, data: { stage: newStage } })
  }

  // Common path is a read: the scoring model almost always already exists. The
  // @unique(workspaceId) means a concurrent first-reply race can lose the create
  // with P2002; re-read in that case so we still get the id.
  let model = await prisma.scoringModel.findUnique({
    where: { workspaceId: lead.workspaceId },
    select: { id: true, weights: true },
  })
  if (!model) {
    try {
      model = await prisma.scoringModel.create({
        data: {
          workspaceId: lead.workspaceId,
          weights: DEFAULT_SCORING_WEIGHTS,
          performanceMetrics: {
            totalScored: 0, totalReplied: 0, replyRate: 0,
            avgScoreOfReplied: 0, avgScoreOfNotReplied: 0, correlationScore: 0,
          },
        },
        select: { id: true, weights: true },
      })
    } catch (err) {
      if ((err as { code?: string }).code !== 'P2002') throw err
      model = await prisma.scoringModel.findUnique({
        where: { workspaceId: lead.workspaceId },
        select: { id: true, weights: true },
      })
    }
  }
  if (!model) throw new Error('scoring model unavailable after create race')

  const replyIntentMap: Record<string, string> = {
    INTERESTED: 'INTERESTED',
    NOT_INTERESTED: 'NOT_INTERESTED',
    NEEDS_MORE_INFO: 'NEED_MORE_INFO',
    NOT_NOW: 'NEED_MORE_INFO',
    REFERRAL: 'INTERESTED',
    OUT_OF_OFFICE: 'NOT_INTERESTED',
  }
  // Use the gated classification for the scoring outcome too, so a downgraded
  // low-confidence negative doesn't feed the learning loop a false "not replied".
  const replied = !['NOT_INTERESTED', 'OUT_OF_OFFICE'].includes(effectiveClassification)

  await prisma.scoringOutcome.create({
    data: {
      workspaceId: lead.workspaceId,
      leadId,
      // Lead-sourced outcome — there is no Prospect.
      prospectId: null,
      score: lead.score,
      replied,
      replyIntent: replyIntentMap[effectiveClassification] ?? null,
      messageRelevance: replied ? 0.8 : 0.2,
      channelUsed: 'EMAIL',
      scoringModelId: model.id,
    },
  })

  // Feed the same learning loop the external FieldOps ingest endpoint
  // (POST /api/outcomes) already drives, so a customer's own reply data — not
  // just FieldOps's — retunes their scoring weights over time.
  await maybeRecomputeScoringWeights(model.id, model.weights as ScoringWeights)
}
