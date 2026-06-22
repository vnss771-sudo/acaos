// Pure-DB queue processors, extracted from worker.ts so they can be unit-tested
// against a real database without instantiating BullMQ Workers (which connect to
// Redis on construction). worker.ts wires these into Workers; tests call them
// directly.

import { prisma } from '@acaos/backend-core/lib/prisma.js'
import { DEFAULT_SCORING_WEIGHTS } from '@acaos/backend-core/lib/scoring.js'
import {
  calculateOpportunityScores,
  detectBuyingStage,
  calcWinProbability,
  toRawSignal,
} from '@acaos/backend-core/lib/signalEngine.js'
import type { SignalType, SignalWeights } from '@acaos/backend-core/lib/signalEngine.js'
import { calibrate } from '@acaos/backend-core/lib/learningLoop.js'
import { AUTO_RECOMMEND_THRESHOLD } from '@acaos/backend-core/lib/recommendationPolicy.js'
import { generateOutreach } from '@acaos/backend-core/services/openai.js'
import { parseAiJson, OutreachDraftOutputSchema, type OutreachDraftOutput, type ReplyAnalysisOutput } from '@acaos/backend-core/lib/aiSchemas.js'
import { sendMail, isMailConfigured, type SmtpConfig } from '@acaos/backend-core/services/mail.js'
import { checkAndIncrementAiUsage, refundAiUsage, reserveDailySendSlot } from '@acaos/backend-core/lib/limits.js'
import { effectiveApprovalMode, effectiveDailySendLimit, reputationGuardMode } from '@acaos/backend-core/lib/launchControls.js'
import { evaluateSenderReputation } from '@acaos/backend-core/lib/senderReputation.js'
import { applyWarmupCap } from '@acaos/backend-core/lib/warmup.js'
import { perDomainDailyCap, emailDomain, tallyDomains } from '@acaos/backend-core/lib/sendPacing.js'
import { resolveSendWindow, isWithinSendWindow } from '@acaos/backend-core/lib/sendWindow.js'
import type { Prisma } from '@prisma/client'
import { bulkCheckSuppression } from '@acaos/backend-core/lib/suppressions.js'
import { checkDraftPolicy, type DraftPolicyConfig } from '@acaos/backend-core/lib/policyCheck.js'
import { isDeliverableEmail } from '@acaos/backend-core/lib/normalize.js'
import { contactEventData, recordContactEvent } from '@acaos/backend-core/lib/contactEvents.js'
import { campaignDailyStatsUpsertArgs } from '@acaos/backend-core/lib/campaignStats.js'
import { scheduleNextFollowup } from '@acaos/backend-core/services/followups.js'
import { canContactRecipient } from '@acaos/backend-core/services/contactPolicy.js'
import { getSource, type ProspectCandidate, type ProspectSearchInput } from '@acaos/backend-core/lib/prospectSources.js'
import { importDiscoveredProspects } from '@acaos/backend-core/lib/discoveryImport.js'
import { enqueueScoreProspects } from '@acaos/backend-core/lib/queues.js'
import type { ICPConfig } from '@acaos/backend-core/lib/signalEngine.js'
import { randomBytes } from 'crypto'
import type { LeadStage, FollowupTaskStatus } from '@acaos/shared'

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
      include: { signals: true },
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
    include: { prospect: { include: { signals: true } } },
    orderBy: { recordedAt: 'desc' },
    take: 100,
  }) as CalibrationOutcomeRow[]
  await progress?.(30)

  const outcomes = rawOutcomes.map((o: CalibrationOutcomeRow) => ({
    stage: o.stage as 'WON' | 'LOST',
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
  | 'INVALID_EMAIL'
  | 'NO_APPROVED_DRAFT'
  | 'POLICY_REVIEW'
  | 'AI_LIMIT'
  | 'AI_GENERATION_FAILED'
  | 'DAILY_CAP'
  | 'MISSION_PAUSED'
  | 'REPUTATION_BLOCKED'
  | 'DOMAIN_PACED'
  | 'OUTSIDE_SEND_WINDOW'

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
  deps: { sendMail?: typeof sendMail; pageSize?: number } = {}
): Promise<SendCampaignResult> {
  const sendMailFn = deps.sendMail ?? sendMail
  // Load workspace-specific SMTP config (falls back to env vars in sendMail)
  // Load workspace config and ICP settings together — both are needed before
  // querying leads (approvalMode determines which drafts are eligible to send).
  const [wsCfgRecord, icp, workspace, missionCtx, draftPolicyRecord, campaignRow] = await Promise.all([
    prisma.workspaceEmailConfig.findUnique({ where: { workspaceId } }),
    prisma.workspaceICP.findUnique({ where: { workspaceId } }),
    prisma.workspace.findUnique({ where: { id: workspaceId }, select: { senderBusinessName: true, senderPostalAddress: true } }),
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

  let sent = 0
  let skipped = 0
  let failed = 0
  // Per-reason skip accounting so the result explains WHY leads didn't send.
  const skippedByReason: Record<SendSkipReason, number> = {
    ALREADY_SENT: 0, SUPPRESSED: 0, INVALID_EMAIL: 0, NO_APPROVED_DRAFT: 0,
    POLICY_REVIEW: 0, AI_LIMIT: 0, AI_GENERATION_FAILED: 0, DAILY_CAP: 0, MISSION_PAUSED: 0,
    REPUTATION_BLOCKED: 0, DOMAIN_PACED: 0, OUTSIDE_SEND_WINDOW: 0,
  }
  const skip = (reason: SendSkipReason, n = 1) => { skipped += n; skippedByReason[reason] += n }
  const result = (): SendCampaignResult => ({ campaignId, sent, skipped, failed, skippedByReason })

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
  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)

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
  const domainCounts: Map<string, number> | null = perDomainCap != null
    ? tallyDomains(
        (await prisma.outreachSent.findMany({
          where: { workspaceId, status: { in: ['SENT', 'SENDING'] }, sentAt: { gte: startOfToday } },
          select: { toEmail: true },
        })).map((r: { toEmail: string }) => r.toEmail),
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
    const pageLeadIds = page.map((l: CampaignLeadRow) => l.id)
    const pageEmails = page.map((l: CampaignLeadRow) => l.email!).filter(Boolean)
    const isSuppressed = pageEmails.length > 0
      ? await bulkCheckSuppression(workspaceId, pageEmails)
      : () => false

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

    // Per-domain pacing: don't burst past the provider's tolerance for one domain.
    if (domainCounts) {
      const d = emailDomain(lead.email)
      if (d && (domainCounts.get(d) ?? 0) >= perDomainCap!) { skip('DOMAIN_PACED'); continue }
    }

    // Resolve the draft source WITHOUT spending AI yet. The outbox claim below
    // happens BEFORE any generation, so a racing send job loses the unique
    // (campaignId, leadId) claim and skips before burning AI quota — no duplicate
    // AI spend and no duplicate draft (the previous order generated first).
    let subject: string | null = null
    let body: string | null = null
    let needGeneration = false

    if (lead.outreachDrafts[0]) {
      subject = lead.outreachDrafts[0].subject
      body = lead.outreachDrafts[0].emailBody
    } else {
      // A draft already flagged POLICY_REVIEW is awaiting human review — skip
      // without regenerating (the selection query excludes it, so it never lands
      // in outreachDrafts[0], but its lead still appears here in non-approval mode).
      if (policyReviewLeadIds.has(lead.id)) { skip('POLICY_REVIEW'); continue }

      // Approval mode: only human-approved drafts may be sent. The query above
      // includes APPROVED drafts only, so an empty drafts array here means this
      // lead has nothing approved — it must be skipped, never sent with freshly
      // generated copy. (Without this guard, generating below would bypass the
      // entire approval gate.)
      if (approvalRequired) { skip('NO_APPROVED_DRAFT'); continue }

      needGeneration = true
    }

    // Provenance (Stage 5): an APPROVED OutreachIntent linked to this lead, stamped
    // onto the claim so the record is self-auditable and marked SENT on success.
    // Resolved from the batch-wide pre-loaded map (no per-lead DB round-trip).
    const linkedIntent = linkedIntentByLeadId.get(lead.id) ?? null
    const unsubscribeToken = randomBytes(24).toString('hex')

    // CLAIM FIRST: reserve the daily-cap slot and insert the unique outbox row in
    // ONE advisory-locked transaction, BEFORE generating. subject/body may be null
    // here and are filled once the draft is prepared. The unique (campaignId,
    // leadId) constraint guarantees at-most-once delivery: a racing attempt — or a
    // retry after a post-send crash — gets a P2002 and skips, having spent no AI.
    // A null result means the live daily cap is now reached.
    let claimId: string
    try {
      const claim = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        if (dailySendLimit != null) {
          const ok = await reserveDailySendSlot(tx, workspaceId, dailySendLimit, startOfToday)
          if (!ok) return null
        }
        return tx.outreachSent.create({
          data: {
            workspaceId, campaignId, leadId: lead.id,
            toEmail: lead.email!, subject, body,
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
      if (claim === null) {
        // Daily cap reached mid-batch — skip the remaining leads (across pages) and stop.
        const remaining = total - sent - skipped - failed
        console.log(`[send-campaign] Daily limit of ${dailySendLimit} reached mid-batch for workspace ${workspaceId}; skipped remaining=${remaining}`)
        skip('DAILY_CAP', remaining)
        break pageLoop
      }
      claimId = claim.id
    } catch (err) {
      // Unique violation — another attempt already owns this send. Skip (no AI spent).
      if ((err as { code?: string }).code === 'P2002') { skip('ALREADY_SENT'); continue }
      throw err
    }

    // Release the claim on a pre-dispatch abort: nothing was sent, so delete the row
    // (freeing its reserved cap slot) and leave the lead eligible for a later run.
    const releaseClaim = async () => { await prisma.outreachSent.delete({ where: { id: claimId } }).catch(() => {}) }

    // Generate now that the claim is held (a racing job has already lost it, so this
    // AI call happens at most once per (campaign, lead)).
    if (needGeneration) {
      try {
        await checkAndIncrementAiUsage(workspaceId, 'AI_OUTREACH')
      } catch {
        await releaseClaim(); skip('AI_LIMIT'); continue  // AI limit reached
      }

      try {
        const raw = await generateOutreach({
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
        // Strict, schema-validated parse. A draft with bad JSON or a missing
        // subject/body is unusable — refund the reserved call, release the claim,
        // and skip this lead rather than failing the whole batch.
        let parsed: OutreachDraftOutput
        try {
          parsed = parseAiJson(OutreachDraftOutputSchema, raw, 'send-campaign')
        } catch {
          await refundAiUsage(workspaceId, 'AI_OUTREACH').catch(() => {})
          await releaseClaim(); skip('AI_GENERATION_FAILED'); continue
        }
        subject = parsed.subject
        body    = parsed.email
        const followup = parsed.followup ?? null

        // Deterministic policy check on freshly generated copy. On a violation,
        // persist the draft as POLICY_REVIEW, release the claim, and skip — never
        // auto-send unreviewed copy that tripped a policy. (Unsubscribe compliance
        // is NOT checked here: the send footer guarantees a List-Unsubscribe link.)
        const violations = checkDraftPolicy({ subject, emailBody: body }, draftPolicy)
        if (violations.length > 0) {
          await prisma.outreachDraft.create({
            data: {
              leadId: lead.id, workspaceId, subject, emailBody: body, followup,
              status: 'POLICY_REVIEW',
              policyViolations: { violations: violations.map(v => ({ code: v.code, message: v.message })) } as Prisma.InputJsonValue,
            }
          })
          console.log(`[send-campaign] Draft for lead ${lead.id} flagged POLICY_REVIEW: ${violations.map(v => v.code).join(', ')}`)
          await releaseClaim(); skip('POLICY_REVIEW'); continue
        }

        // Persist the draft for reuse and fill the claim with the generated copy.
        await prisma.outreachDraft.create({
          data: { leadId: lead.id, workspaceId, subject, emailBody: body, followup }
        })
        await prisma.outreachSent.update({ where: { id: claimId }, data: { subject, body } })
      } catch (err) {
        console.error(`[send-campaign] Draft generation failed for lead ${lead.id}: ${(err as Error).message}`)
        // Generation failed after reserving the AI call — refund it and release.
        await refundAiUsage(workspaceId, 'AI_OUTREACH').catch(() => {})
        await releaseClaim(); failed++; continue
      }
    }

    // Past this point subject/body are non-null (reused draft or freshly generated).
    // Guard defensively so a logic slip fails this one lead, not the whole batch.
    if (subject == null || body == null) { await releaseClaim(); failed++; continue }

    const escHtml = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    const safeAppUrl = escHtml(appUrl)
    const unsubscribeUrl = `${safeAppUrl}/api/unsubscribe/${unsubscribeToken}`
    // CAN-SPAM / GDPR: include sender identity and physical address when configured
    const senderLine = workspace?.senderBusinessName
      ? `<br>${escHtml(workspace.senderBusinessName)}${workspace.senderPostalAddress ? `, ${escHtml(workspace.senderPostalAddress)}` : ''}`
      : ''
    const footer = `<br><br><hr style="border:none;border-top:1px solid #eee;margin:24px 0"><p style="font-size:12px;color:#999">You received this email because you matched our outreach criteria. To stop receiving emails, <a href="${unsubscribeUrl}" style="color:#999">unsubscribe here</a>.${senderLine}</p>`
    const htmlBody = `<p>${escHtml(body).replace(/\n/g, '<br>')}</p>${footer}`
    // Plaintext alternative built from the SOURCE draft (not regex-stripped HTML),
    // so the multipart email carries a clean text/plain part for deliverability.
    const textBody = `${body}\n\nYou received this email because you matched our outreach criteria. To stop receiving emails, unsubscribe: ${unsubscribeUrl}`

    try {
      // RFC 2369 / 8058 one-click unsubscribe headers — the /api/unsubscribe
      // endpoint already serves a safe GET confirmation and a POST one-click
      // handler. Major mailbox providers require these for bulk senders.
      const info = await sendMailFn(lead.email!, subject, htmlBody, smtpCfg, {
        text: textBody,
        headers: {
          'List-Unsubscribe': `<${unsubscribeUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      })
      const msgId = (info as any).messageId ?? null

      await prisma.$transaction([
        prisma.outreachSent.update({
          where: { id: claimId },
          data: { messageId: msgId, status: 'SENT', sentAt: new Date() }
        }),
        prisma.lead.update({
          where: { id: lead.id },
          data: { stage: 'OUTREACH_SENT', lastContactedAt: new Date() }
        }),
        // Append the SENT lifecycle event to the contact ledger in the SAME
        // transaction as the send, so the ledger can never disagree with the outbox.
        prisma.contactEvent.create({
          data: contactEventData({ workspaceId, email: lead.email!, type: 'SENT', leadId: lead.id, campaignId, outreachSentId: claimId }),
        }),
        // Increment the campaign's daily SENT counter atomically with the send.
        prisma.campaignDailyStats.upsert(campaignDailyStatsUpsertArgs({ workspaceId, campaignId, date: new Date(), field: 'sent' })),
        // Advance the linked intent to SENT in the same transaction as the send.
        ...(linkedIntent ? [prisma.outreachIntent.update({ where: { id: linkedIntent.id }, data: { status: 'SENT' } })] : []),
      ])

      // Schedule the next sequence step (best-effort; no-op unless the campaign
      // opted into auto-followups and an active next step exists).
      void scheduleNextFollowup({
        workspaceId, campaignId, leadId: lead.id, outreachSentId: claimId,
        currentStep: 1, sentAt: new Date(), autoFollowupsEnabled,
      }).catch(() => {})

      sent++
      if (domainCounts) { const d = emailDomain(lead.email); if (d) domainCounts.set(d, (domainCounts.get(d) ?? 0) + 1) }
    } catch (err) {
      // Known SMTP rejection (nodemailer throws only when the provider did NOT
      // accept the message). Mark the claim FAILED with the error + failedAt for
      // operator review instead of deleting it — fail-closed: it won't be
      // auto-resent. (A crash AFTER provider acceptance leaves the row SENDING,
      // also never resent.) Operators can clear FAILED rows to deliberately retry.
      const message = err instanceof Error ? err.message : 'SMTP send failed'
      console.error(`[send-campaign] SMTP failed for lead ${lead.id}: ${message}`)
      await prisma.outreachSent.update({
        where: { id: claimId },
        data: { status: 'FAILED', failedAt: new Date(), lastError: message.slice(0, 500) },
      }).catch(() => {})
      // Best-effort FAILED ledger entry (not in a tx with the update — a ledger
      // hiccup must never mask the SMTP failure itself).
      void recordContactEvent({ workspaceId, email: lead.email!, type: 'FAILED', leadId: lead.id, campaignId, outreachSentId: claimId, metadata: { error: message.slice(0, 200) } }).catch(() => {})
      failed++
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

  const [campaign, lead, step, wsCfg, icp] = await Promise.all([
    prisma.campaign.findUnique({ where: { id: campaignId }, select: { autoFollowupsEnabled: true } }),
    prisma.lead.findUnique({ where: { id: leadId }, select: { email: true, stage: true } }),
    prisma.outreachSequenceStep.findUnique({ where: { campaignId_stepNumber: { campaignId, stepNumber } }, select: { subject: true, body: true, isActive: true } }),
    prisma.workspaceEmailConfig.findUnique({ where: { workspaceId } }),
    prisma.workspaceICP.findUnique({ where: { workspaceId }, select: { dailySendLimit: true, warmupStartedAt: true, sendWindowStartHour: true, sendWindowEndHour: true, sendTimezone: true, sendWeekdaysOnly: true } }),
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
      if (guardMode === 'enforce') return finish('BLOCKED', 'BLOCKED', { cancelledReason: 'REPUTATION_BLOCKED' })
      console.warn(`[send-followup] reputation ${rep.reason} for workspace ${workspaceId} (observe) — proceeding`)
    }
  }

  // Contact policy: re-checked at send time, not just at scheduling.
  const decision = await canContactRecipient({ workspaceId, email: lead.email, leadId })
  if (!decision.allowed) return finish('BLOCKED', 'BLOCKED', { cancelledReason: decision.reason })

  // Build the follow-up email from the sequence step.
  const subject = (step.subject && step.subject.trim()) || 'Following up'
  const body = step.body
  const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const unsubscribeToken = randomBytes(24).toString('hex')
  const appUrl = (process.env.API_URL || 'http://localhost:4000').replace(/\/$/, '')
  const unsubscribeUrl = `${escHtml(appUrl)}/api/unsubscribe/${unsubscribeToken}`
  const footer = `<br><br><hr style="border:none;border-top:1px solid #eee;margin:24px 0"><p style="font-size:12px;color:#999">You received this email because you matched our outreach criteria. To stop receiving emails, <a href="${unsubscribeUrl}" style="color:#999">unsubscribe here</a>.</p>`
  const htmlBody = `<p>${escHtml(body).replace(/\n/g, '<br>')}</p>${footer}`
  const textBody = `${body}\n\nYou received this email because you matched our outreach criteria. To stop receiving emails, unsubscribe: ${unsubscribeUrl}`

  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0)
  const wsDailyLimit = icp?.dailySendLimit && icp.dailySendLimit > 0 ? icp.dailySendLimit : null
  const dailySendLimit = applyWarmupCap(effectiveDailySendLimit(wsDailyLimit), icp?.warmupStartedAt ?? null)

  // Opt-in send window: outside quiet hours, defer — park the task back at SCHEDULED
  // so the next scan retries it once the window reopens. A no-op unless configured.
  const sendWindow = resolveSendWindow(icp)
  if (sendWindow && !isWithinSendWindow(new Date(), sendWindow)) {
    await prisma.followupTask.update({ where: { id: taskId }, data: { status: 'SCHEDULED' } }).catch(() => {})
    return { taskId, status: 'SKIPPED', reason: 'OUTSIDE_SEND_WINDOW' }
  }

  // Per-domain pacing (opt-in). If this recipient's domain already hit its daily
  // ceiling, defer: park the task back at SCHEDULED to retry on a later scan rather
  // than burst past the provider's tolerance.
  const perDomainCap = perDomainDailyCap()
  if (perDomainCap != null) {
    const domain = emailDomain(lead.email)
    if (domain) {
      const domainToday = await prisma.outreachSent.count({
        where: { workspaceId, status: { in: ['SENT', 'SENDING'] }, sentAt: { gte: startOfToday }, toEmail: { endsWith: `@${domain}` } },
      })
      if (domainToday >= perDomainCap) {
        await prisma.followupTask.update({ where: { id: taskId }, data: { status: 'SCHEDULED' } }).catch(() => {})
        return { taskId, status: 'SKIPPED', reason: 'DOMAIN_PACED' }
      }
    }
  }

  // Claim the outbox row for THIS step (unique on campaignId, leadId, sequenceStep).
  let claimId: string
  try {
    const claim = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      if (dailySendLimit != null) {
        const ok = await reserveDailySendSlot(tx, workspaceId, dailySendLimit, startOfToday)
        if (!ok) return null
      }
      return tx.outreachSent.create({
        data: { workspaceId, campaignId, leadId, sequenceStep: stepNumber, toEmail: lead.email!, subject, body, unsubscribeToken, status: 'SENDING' },
        select: { id: true },
      })
    })
    if (claim === null) {
      // Daily cap reached — park the task back at SCHEDULED (not a terminal state,
      // so no cancelledReason) to retry on a later run.
      await prisma.followupTask.update({ where: { id: taskId }, data: { status: 'SCHEDULED' } }).catch(() => {})
      return { taskId, status: 'SKIPPED', reason: 'DAILY_CAP_EXCEEDED' }
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
    await prisma.outreachSent.update({ where: { id: claimId }, data: { status: 'FAILED', failedAt: new Date(), lastError: message.slice(0, 500) } }).catch(() => {})
    await prisma.followupTask.update({ where: { id: taskId }, data: { status: 'FAILED', lastError: message.slice(0, 500) } }).catch(() => {})
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

  const stageMap: Record<string, LeadStage> = {
    INTERESTED: 'REPLIED',
    NOT_INTERESTED: 'DEAD',
    NEEDS_MORE_INFO: 'REPLIED',
    NOT_NOW: 'REPLIED',
    REFERRAL: 'REPLIED',
    OUT_OF_OFFICE: 'OUTREACH_SENT',
  }
  const newStage = stageMap[parsed.classification]
  if (newStage) {
    await prisma.lead.updateMany({ where: { id: leadId, workspaceId: lead.workspaceId }, data: { stage: newStage } })
  }

  // Common path is a read: the scoring model almost always already exists. The
  // @unique(workspaceId) means a concurrent first-reply race can lose the create
  // with P2002; re-read in that case so we still get the id.
  let model = await prisma.scoringModel.findUnique({
    where: { workspaceId: lead.workspaceId },
    select: { id: true },
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
        select: { id: true },
      })
    } catch (err) {
      if ((err as { code?: string }).code !== 'P2002') throw err
      model = await prisma.scoringModel.findUnique({
        where: { workspaceId: lead.workspaceId },
        select: { id: true },
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
  const replied = !['NOT_INTERESTED', 'OUT_OF_OFFICE'].includes(parsed.classification)

  await prisma.scoringOutcome.create({
    data: {
      workspaceId: lead.workspaceId,
      leadId,
      // Lead-sourced outcome — there is no Prospect.
      prospectId: null,
      score: lead.score,
      replied,
      replyIntent: replyIntentMap[parsed.classification] ?? null,
      messageRelevance: replied ? 0.8 : 0.2,
      channelUsed: 'EMAIL',
      scoringModelId: model.id,
    },
  })
}
