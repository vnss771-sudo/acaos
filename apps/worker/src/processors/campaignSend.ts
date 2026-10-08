// Pure-DB queue processors, extracted from worker.ts so they can be unit-tested
// against a real database without instantiating BullMQ Workers (which connect to
// Redis on construction). worker.ts wires these into Workers; tests call them
// directly.

import { prisma } from '@acaos/backend-core/lib/prisma.js'
import { recordPreSendFeatures } from '@acaos/backend-core/lib/messageRelevance.js'
import { SelectionRecorder } from '@acaos/backend-core/lib/selectionTracking.js'
import { holdoutPercent, isHeldOut } from '@acaos/backend-core/lib/holdout.js'
import { generateOutreach, outreachGenerationMeta } from '@acaos/backend-core/services/openai.js'
import { resolvePromptVersionId } from '@acaos/backend-core/lib/aiPromptRegistry.js'
import { sensitiveKinds } from '@acaos/backend-core/lib/sensitiveData.js'
import { parseAiJson, OutreachDraftOutputSchema, type OutreachDraftOutput } from '@acaos/backend-core/lib/aiSchemas.js'
import { sendMail, isMailConfigured, type SmtpConfig } from '@acaos/backend-core/services/mail.js'
import { checkAndIncrementAiUsage, refundAiUsage, reserveDailySendSlot, reserveDomainSendSlot, utcMonthStart } from '@acaos/backend-core/lib/limits.js'
import { effectiveApprovalMode, effectiveDailySendLimit, isComplianceGateEnabled } from '@acaos/backend-core/lib/launchControls.js'
import { bulkCheckConsent } from '@acaos/backend-core/lib/consent.js'
import { recordAudit } from '@acaos/backend-core/lib/audit.js'
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
import { randomBytes } from 'crypto'
import type { LeadStage } from '@acaos/shared'
import { incReputationBlock, incSendOutcome, incAiCost } from '../lib/metrics.js'

type Progress = (n: number) => unknown

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

export type SendSkipReason =
  | 'ALREADY_SENT'
  | 'SUPPRESSED'
  | 'WORKSPACE_SUPPRESSED'
  | 'INVALID_EMAIL'
  | 'NO_APPROVED_DRAFT'
  | 'POLICY_REVIEW'
  | 'SENSITIVE_DATA'
  | 'AI_LIMIT'
  | 'AI_GENERATION_FAILED'
  | 'DAILY_CAP'
  | 'MONTHLY_CAP'
  | 'MISSION_PAUSED'
  | 'REPUTATION_BLOCKED'
  | 'DOMAIN_PACED'
  | 'OUTSIDE_SEND_WINDOW'
  | 'CONSENT_REQUIRED'
  | 'HOLDOUT'

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
  // Every email carries an unsubscribe link built from API_URL. Refuse the whole
  // batch before any send rather than mail out links that can't work.
  const unsubscribeBaseUrl = resolveUnsubscribeBaseUrl()
  if (!unsubscribeBaseUrl) throw new Error('API_URL not configured — set it so unsubscribe links work')
  return { icp, workspace, missionCtx, draftPolicy, autoFollowupsEnabled, smtpCfg, unsubscribeBaseUrl }
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
  | { action: 'skip'; reason: Extract<SendSkipReason, 'POLICY_REVIEW' | 'NO_APPROVED_DRAFT' | 'SENSITIVE_DATA'> }

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
    const { subject, emailBody } = lead.outreachDrafts[0]
    // Last check before anything leaves: a draft (even an approved or hand-edited
    // one) carrying a card number, secret key, password or TFN is never sent.
    if (sensitiveKinds(`${subject}\n${emailBody}`).length > 0) return { action: 'skip', reason: 'SENSITIVE_DATA' }
    return { action: 'reuse', subject, body: emailBody }
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
  const {
    workspaceId, campaignId, lead, subject, body, dailySendLimit, startOfToday,
    perDomainCap, linkedIntent, unsubscribeToken,
  } = params
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
        businessContext: icp?.businessContext ?? undefined,
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
    // Score relevance BEFORE dispatch: final copy, no outcome can exist yet.
    // Best-effort — a scoring failure never blocks the send.
    await recordPreSendFeatures(p.claimId).catch(() => {})
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

  const { icp, workspace, missionCtx, draftPolicy, autoFollowupsEnabled, smtpCfg, unsubscribeBaseUrl } =
    await loadCampaignSendConfig(campaignId, workspaceId)
  // Selection tracking (best-effort): who this run considered, selected or
  // excluded and why. Leads are processed in id order (≈ creation order), so a
  // cap cut-off is not score-driven — recorded so bias analysis can rely on it.
  const selection = await SelectionRecorder.start(workspaceId, campaignId, 'id_asc')
  // Held-back comparison group: a random, stable share of otherwise-sendable
  // leads is never contacted, so outcomes can be compared to a fair baseline.
  const holdoutPct = holdoutPercent()

  let sent = 0
  let skipped = 0
  let failed = 0
  // Per-reason skip accounting so the result explains WHY leads didn't send.
  const skippedByReason: Record<SendSkipReason, number> = {
    ALREADY_SENT: 0, SUPPRESSED: 0, WORKSPACE_SUPPRESSED: 0, INVALID_EMAIL: 0, NO_APPROVED_DRAFT: 0,
    POLICY_REVIEW: 0, SENSITIVE_DATA: 0, AI_LIMIT: 0, AI_GENERATION_FAILED: 0, DAILY_CAP: 0, MONTHLY_CAP: 0, MISSION_PAUSED: 0,
    REPUTATION_BLOCKED: 0, DOMAIN_PACED: 0, OUTSIDE_SEND_WINDOW: 0, CONSENT_REQUIRED: 0, HOLDOUT: 0,
  }
  const skip = (reason: SendSkipReason, n = 1) => { skipped += n; skippedByReason[reason] += n; incSendOutcome('send-campaign', reason, n) }
  const result = (): SendCampaignResult => ({ campaignId, sent, skipped, failed, skippedByReason })
  const finish = async (): Promise<SendCampaignResult> => {
    const r = result()
    await selection.finish({ sent: r.sent, skipped: r.skipped, failed: r.failed, skippedByReason: r.skippedByReason, holdoutPercent: holdoutPct })
    return r
  }

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

  // Don't even start a batch for a paused/completed mission.
  const initialBlock = await getMissionSendBlockReason(campaignId)
  if (initialBlock) {
    console.log(`[send-campaign] Skipping campaign ${campaignId}: ${initialBlock}`)
    return finish()
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

  // Canonical platform/workspace/reputation authorization. Recipient-level
  // checks stay bulk-loaded below for campaign throughput, but the same shared
  // policy service now protects campaign, follow-up and human-reply dispatch.
  const batchAuthorization = await authorizeOutboundSend({
    workspaceId,
    context: 'campaign',
    recipientChecks: false,
    audit: { entityType: 'campaign', entityId: campaignId },
  })
  if (!batchAuthorization.allowed) {
    console.log(`[send-campaign] Authorization blocked campaign ${campaignId}: ${batchAuthorization.code}`)
    if (batchAuthorization.code === 'REPUTATION_BLOCKED') {
      incReputationBlock('send-campaign')
      skip('REPUTATION_BLOCKED', total)
    } else if (batchAuthorization.code === 'WORKSPACE_SUPPRESSED') {
      // Preserve the operator-drain semantics: the batch halts without creating
      // per-lead state, while still emitting the existing suppression metric.
      incSendOutcome('send-campaign', 'WORKSPACE_SUPPRESSED')
    }
    return finish()
  }
  for (const observation of batchAuthorization.observations ?? []) {
    console.warn(`[send-campaign] authorization observation for workspace ${workspaceId}: ${observation}`)
  }

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
      return finish()
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
      return finish()
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
    return finish()
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

  const appUrl = unsubscribeBaseUrl

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
    // Single-lead exclusions are recorded per lead (bulk cut-offs below that
    // skip the REST of the run are captured in the run's totals instead).
    const exclude = (reason: SendSkipReason) => { skip(reason); selection.record(lead, 'EXCLUDED', reason) }

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
    if (alreadySentLeadIds.has(lead.id)) { exclude('ALREADY_SENT'); continue }

    // Skip suppressed addresses (unsubscribed or bounced)
    if (isSuppressed(lead.email!)) { exclude('SUPPRESSED'); continue }

    // Reject structurally-invalid addresses before claiming/generating — a bad
    // address would only burn an SMTP attempt and hurt sender reputation.
    if (!isDeliverableEmail(lead.email)) { exclude('INVALID_EMAIL'); continue }

    // Compliance gate (dormant unless COMPLIANCE_GATE_ENABLED): a consent-basis or
    // Canada-targeting workspace must have an on-file ConsentRecord for THIS
    // recipient — fail closed, never send on the strength of "some" workspace has
    // consent recorded. Audited per skip (fire-and-forget) for the SAR/compliance
    // trail; never blocks the send loop even if the audit write fails.
    if (consentRequired && !hasConsent(lead.email!)) {
      exclude('CONSENT_REQUIRED')
      void recordAudit({
        workspaceId, type: 'consent.enforcement.skipped', entityType: 'lead', entityId: lead.id,
        metadata: { campaignId, reason: consentReason },
      })
      continue
    }

    // Holdout: placed after every eligibility check, so the held-out group is
    // drawn only from leads that would otherwise have been contacted.
    if (isHeldOut(workspaceId, lead.id, holdoutPct)) { skip('HOLDOUT'); selection.record(lead, 'HELD_OUT', 'HOLDOUT'); continue }

    // Per-domain pacing: don't burst past the provider's tolerance for one domain.
    if (domainCounts) {
      const d = emailDomain(lead.email)
      if (d && (domainCounts.get(d) ?? 0) >= perDomainCap!) { exclude('DOMAIN_PACED'); continue }
    }

    // Resolve the draft source WITHOUT spending AI yet. The outbox claim below
    // happens BEFORE any generation, so a racing send job loses the unique
    // (campaignId, leadId) claim and skips before burning AI quota — no duplicate
    // AI spend and no duplicate draft (the previous order generated first).
    const draftSource = resolveDraftSource(lead, { approvalRequired, policyReviewLeadIds })
    if (draftSource.action === 'skip') {
      // Hold the offending draft for review so a person sees why it didn't send.
      const draftId = lead.outreachDrafts[0]?.id
      if (draftSource.reason === 'SENSITIVE_DATA' && draftId) {
        const d = lead.outreachDrafts[0]
        await prisma.outreachDraft.updateMany({
          where: { id: draftId, workspaceId },
          data: {
            status: 'POLICY_REVIEW',
            policyViolations: { violations: [sensitiveDataViolation(sensitiveKinds(`${d.subject}\n${d.emailBody}`))].map(v => ({ code: v.code, message: v.message })) } as Prisma.InputJsonValue,
          },
        }).catch(() => {})
      }
      exclude(draftSource.reason); continue
    }
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
      if (claimOutcome.reason === 'DOMAIN_PACED') { exclude('DOMAIN_PACED'); continue }
      exclude('ALREADY_SENT'); continue
    }
    const claimId = claimOutcome.claimId
    const releaseClaim = claimOutcome.release

    // Generate now that the claim is held (a racing job has already lost it, so this
    // AI call happens at most once per (campaign, lead)).
    if (needGeneration) {
      const outcome = await generateDraftForSend(lead, { workspaceId, claimId, icp, missionCtx, draftPolicy, generateOutreachFn })
      switch (outcome.kind) {
        case 'ai_limit':
          await releaseClaim(); exclude('AI_LIMIT'); continue
        case 'invalid_json':
          await releaseClaim(); exclude('AI_GENERATION_FAILED'); continue
        case 'policy_review':
          await releaseClaim(); exclude('POLICY_REVIEW'); continue
        case 'error':
          await releaseClaim(); failed++; incSendOutcome('send-campaign', 'failed'); selection.record(lead, 'FAILED'); continue
        case 'generated':
          subject = outcome.subject
          body = outcome.body
          break
      }
    }

    // Past this point subject/body are non-null (reused draft or freshly generated).
    // Guard defensively so a logic slip fails this one lead, not the whole batch.
    if (subject == null || body == null) { await releaseClaim(); failed++; incSendOutcome('send-campaign', 'failed'); selection.record(lead, 'FAILED'); continue }

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
      selection.record(lead, 'SELECTED', null, claimId)
      if (domainCounts) { const d = emailDomain(lead.email); if (d) domainCounts.set(d, (domainCounts.get(d) ?? 0) + 1) }
    } else {
      failed++
      incSendOutcome('send-campaign', 'failed')
      selection.record(lead, 'FAILED')
    }
    } // end per-lead loop for this page
    await selection.flush()

    // Advance the cursor; a short page means we've reached the end.
    cursor = page[page.length - 1].id
    if (page.length < PAGE) break
  }

  await progress?.(100)
  return finish()
}

