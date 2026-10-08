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
    select: { targetIndustries: true, businessType: true, outreachTone: true, businessContext: true },
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

  const researchedAt = new Date()
  const enrichedLead = {
    businessName: lead.businessName,
    category: lead.category,
    contactName: lead.contactName,
    email: lead.email,
    website: lead.website,
    notes: lead.notes,
    aiSummary: parsed.aiSummary ?? null,
    outreachAngle: parsed.outreachAngle ?? null,
    estimatedTeamSize: parsed.estimatedTeamSize ?? null,
    // Evidence found by this research run, observed now → timing fit ("why now").
    timingEvidence: (parsed.evidence ?? []).map((e) => ({ text: e.signal, observedAt: researchedAt })),
    scoredAt: researchedAt,
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
    select: { targetIndustries: true, businessType: true, outreachTone: true, businessContext: true },
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

  // A draft that picked up a card number, secret key, password or TFN (from
  // business context or lead notes) is held for review, never queued as DRAFTED.
  const leaked = sensitiveKinds([parsed.subject, parsed.email, parsed.followup ?? ''].join('\n'))
  await prisma.outreachDraft.create({
    data: {
      leadId: lead.id,
      workspaceId: lead.workspaceId,
      subject: parsed.subject,
      emailBody: parsed.email,
      followup: parsed.followup ?? null,
      // Gated status: POLICY_REVIEW when research asked for manual review or a
      // human overrode a skip (held for a human); otherwise the normal DRAFTED.
      status: leaked.length > 0 ? 'POLICY_REVIEW' : gate.draftStatus,
      ...(leaked.length > 0
        ? { policyViolations: { violations: [sensitiveDataViolation(leaked)].map(v => ({ code: v.code, message: v.message })) } as Prisma.InputJsonValue }
        : {}),
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
 * Learn from WON/LOST prospect outcomes and turn what's learned into
 * LearningRecommendations. Gated by LEARNING_ADAPTATION_MODE:
 *   off     — does nothing
 *   shadow / approved — records PENDING recommendations; changes nothing
 *   live    — also applies signal-weight changes (recorded as
 *             APPLIED_AUTOMATICALLY with before/after for audit + rollback)
 * The workspace ICP is NEVER written here in any mode — ICP changes are
 * always recommendations awaiting a human decision.
 */
