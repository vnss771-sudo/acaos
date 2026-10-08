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


async function getMissionSendBlockReason(campaignId: string): Promise<string | null> {
  const mission = await prisma.mission
    .findUnique({ where: { campaignId }, select: { status: true } })
    .catch(() => null)
  if (mission?.status === 'PAUSED') return 'mission paused'
  if (mission?.status === 'COMPLETE') return 'mission complete'
  return null
}


// ── send-followup: dispatch one due sequence step ─────────────────────────────
// Reuses the claim-first send mechanics for a single FollowupTask. Gated by the
// campaign's autoFollowupsEnabled AND the global FOLLOWUPS_ENABLED (checked by the
// worker before calling this). Every dispatch re-runs the canonical send authorization, so a
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
  const appUrl = resolveUnsubscribeBaseUrl()
  if (!appUrl) return finish('BLOCKED', 'BLOCKED', { cancelledReason: 'API_URL_NOT_CONFIGURED' })
  if (sensitiveKinds(`${step.subject ?? ''}\n${step.body}`).length > 0) return finish('BLOCKED', 'BLOCKED', { cancelledReason: 'SENSITIVE_DATA' })

  // Canonical send-time authorization. This closes the previous follow-up hole:
  // workspace sendSuppressed was loaded above but never enforced. The shared gate
  // also re-checks FEATURE_SEND, reputation, recipient contact policy and consent
  // immediately before this task can claim an outbox row.
  const authorization = await authorizeOutboundSend({
    workspaceId,
    context: 'followup',
    email: lead.email,
    leadId,
    audit: { entityType: 'followupTask', entityId: taskId },
  })
  if (!authorization.allowed) {
    // A transient reputation-ledger failure defers (park back at SCHEDULED for the
    // next scan) rather than cancelling the sequence step.
    if (authorization.code === 'REPUTATION_UNAVAILABLE') {
      await prisma.followupTask.update({ where: { id: taskId }, data: { status: 'SCHEDULED' } }).catch(() => {})
      return { taskId, status: 'SKIPPED', reason: 'REPUTATION_UNAVAILABLE' }
    }
    if (authorization.code === 'REPUTATION_BLOCKED') incReputationBlock('send-followup')
    if (authorization.code === 'CONSENT_REQUIRED') {
      await recordCriticalAudit({
        workspaceId, type: 'consent.enforcement.skipped', entityType: 'lead', entityId: leadId,
        metadata: { campaignId, reason: workspace?.lawfulBasis === 'consent' ? 'lawful_basis_consent' : 'targets_canada', followup: true },
      })
    }
    return finish('BLOCKED', 'BLOCKED', { cancelledReason: authorization.code })
  }
  for (const observation of authorization.observations ?? []) {
    console.warn(`[send-followup] authorization observation for workspace ${workspaceId}: ${observation}`)
  }

  // Build the follow-up email from the sequence step, via the SAME renderer the
  // initial campaign send uses — so the sender identity + physical address (and
  // unsubscribe) are present and the two paths can't drift again.
  const subject = (step.subject && step.subject.trim()) || 'Following up'
  const body = step.body
  const unsubscribeToken = randomBytes(24).toString('hex')
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
    await recordPreSendFeatures(claimId).catch(() => {}) // before dispatch (see dispatchOutreachEmail)
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
