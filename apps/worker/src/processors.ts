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
import { parseAiJson, OutreachDraftOutputSchema, type OutreachDraftOutput } from '@acaos/backend-core/lib/aiSchemas.js'
import { sendMail, isMailConfigured, type SmtpConfig } from '@acaos/backend-core/services/mail.js'
import { checkAndIncrementAiUsage, refundAiUsage } from '@acaos/backend-core/lib/limits.js'
import { bulkCheckSuppression } from '@acaos/backend-core/lib/suppressions.js'
import { randomBytes } from 'crypto'
import type { LeadStage } from '@acaos/shared'

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

type SendCampaignResult = {
  campaignId: string
  sent: number
  skipped: number
  failed: number
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
  // real mailer, so production callers (worker.ts) are unchanged.
  deps: { sendMail?: typeof sendMail } = {}
): Promise<SendCampaignResult> {
  const sendMailFn = deps.sendMail ?? sendMail
  // Load workspace-specific SMTP config (falls back to env vars in sendMail)
  // Load workspace config and ICP settings together — both are needed before
  // querying leads (approvalMode determines which drafts are eligible to send).
  const [wsCfgRecord, icp, workspace, missionCtx] = await Promise.all([
    prisma.workspaceEmailConfig.findUnique({ where: { workspaceId } }),
    prisma.workspaceICP.findUnique({ where: { workspaceId } }),
    prisma.workspace.findUnique({ where: { id: workspaceId }, select: { senderBusinessName: true, senderPostalAddress: true } }),
    // Per-mission outreach overrides (offer + target customer), if this campaign
    // is the execution arm of a mission. campaignId is unique on Mission.
    prisma.mission.findUnique({ where: { campaignId }, select: { targetCustomer: true, offer: true } }),
  ])
  const smtpCfg: SmtpConfig | null = wsCfgRecord ?? null
  if (!isMailConfigured(smtpCfg)) throw new Error('SMTP not configured — set SMTP_HOST and SMTP_FROM')

  // Don't even start a batch for a paused/completed mission.
  const initialBlock = await getMissionSendBlockReason(campaignId)
  if (initialBlock) {
    console.log(`[send-campaign] Skipping campaign ${campaignId}: ${initialBlock}`)
    return { campaignId, sent: 0, skipped: 0, failed: 0 }
  }

  await progress?.(5)

  const where = {
    campaignId,
    workspaceId,
    email: { not: null as null },
    stage: { notIn: ['OUTREACH_SENT', 'REPLIED', 'BOOKED', 'CLOSED', 'DEAD'] as LeadStage[] },
    ...(leadIds ? { id: { in: leadIds } } : {})
  }

  const leads = await prisma.lead.findMany({
    where,
    include: {
      // When approvalMode is on, only include APPROVED drafts. A lead that ends
      // up with no included draft is then skipped in the send loop below (it is
      // NOT sent with freshly generated copy — that would bypass approval).
      outreachDrafts: {
        where: icp?.approvalMode ? { status: 'APPROVED' } : undefined,
        orderBy: { createdAt: 'desc' },
        take: 1
      }
    }
  }) as CampaignLeadRow[]
  let dailyRemaining = Infinity
  if (icp?.dailySendLimit && icp.dailySendLimit > 0) {
    const startOfToday = new Date()
    startOfToday.setHours(0, 0, 0, 0)
    const sentToday = await prisma.outreachSent.count({
      where: { workspaceId, status: 'SENT', sentAt: { gte: startOfToday } }
    })
    dailyRemaining = Math.max(0, icp.dailySendLimit - sentToday)
    if (dailyRemaining === 0) {
      console.log(`[send-campaign] Daily limit of ${icp.dailySendLimit} reached for workspace ${workspaceId}`)
      return { campaignId, sent: 0, skipped: leads.length, failed: 0 }
    }
  }

  // Filter suppressed addresses before doing any AI work
  const emailList = leads.map((l: CampaignLeadRow) => l.email!).filter(Boolean)
  const isSuppressed = emailList.length > 0
    ? await bulkCheckSuppression(workspaceId, emailList)
    : () => false

  // Perf: bulk-load the per-lead lookups that used to run as serial DB
  // round-trips inside the loop (one query each for the whole batch instead of
  // N). These are fast-path pre-filters / caches only — they never replace the
  // atomic per-lead claim below (the unique (campaignId, leadId) constraint),
  // which remains the real race guard. Mission status is deliberately NOT cached
  // here: it is re-checked per lead inside the loop so an operator pause issued
  // mid-run still aborts the remaining batch.
  const batchLeadIds = leads.map((l: CampaignLeadRow) => l.id)

  // (1) Already-sent fast-path: load existing OutreachSent rows for the batch in
  // one query. Mirrors the old per-lead findFirst filter exactly: SENT/SENDING/
  // FAILED are treated as "do not (re)send". The atomic claim inside the loop is
  // still authoritative against races; this Set just avoids the per-lead query.
  const alreadySentLeadIds: Set<string> = batchLeadIds.length > 0
    ? new Set(
        (await prisma.outreachSent.findMany({
          where: { campaignId, leadId: { in: batchLeadIds }, status: { in: ['SENT', 'SENDING', 'FAILED'] } },
          select: { leadId: true },
        }))
          .map((r: { leadId: string | null }) => r.leadId)
          .filter((id): id is string => id !== null)
      )
    : new Set<string>()

  // (3) Linked-intent fast-path: load APPROVED OutreachIntents for the batch in
  // one query, keyed by leadId. Best-effort, exactly as the old per-lead lookup
  // (.catch(() => null)); a failure leaves the map empty so sends still proceed
  // without provenance stamping. If a lead somehow has multiple APPROVED intents
  // the first wins, matching findFirst's single-row semantics. The selected
  // shape (id/recommendationId/evidenceSnapshot) matches the former findFirst,
  // so the create's provenance fields type-check identically.
  const linkedIntentRows = batchLeadIds.length > 0
    ? await prisma.outreachIntent
        .findMany({
          where: { leadId: { in: batchLeadIds }, status: 'APPROVED' },
          select: { leadId: true, id: true, recommendationId: true, evidenceSnapshot: true },
        })
        .catch(() => [])
    : []
  const linkedIntentByLeadId = new Map<string, (typeof linkedIntentRows)[number]>()
  for (const intent of linkedIntentRows) {
    if (intent.leadId !== null && !linkedIntentByLeadId.has(intent.leadId)) {
      linkedIntentByLeadId.set(intent.leadId, intent)
    }
  }

  const appUrl = (process.env.API_URL || 'http://localhost:4000').replace(/\/$/, '')

  await progress?.(10)

  let sent = 0
  let skipped = 0
  let failed = 0
  const total = leads.length

  for (let i = 0; i < leads.length; i++) {
    const lead = leads[i]

    // Progress: 10% → 90% across the lead batch
    await progress?.(10 + Math.floor((i / total) * 80))

    // Mission pause/complete is an operator stop button: re-check before each lead
    // so a pause issued mid-run halts the rest of the batch before any further AI
    // generation, outbox claim, or SMTP dispatch.
    const blockReason = await getMissionSendBlockReason(campaignId)
    if (blockReason) {
      const remaining = leads.length - i
      console.log(`[send-campaign] Stopping campaign ${campaignId}: ${blockReason}; skipped remaining=${remaining}`)
      skipped += remaining
      break
    }

    // Cheap pre-check before any AI work: skip leads already sent to, in-flight,
    // or terminally failed for this campaign. This is an in-memory membership
    // test against the batch's pre-loaded OutreachSent rows (one bulk query
    // above) instead of a per-lead query. The unique (campaignId, leadId)
    // constraint on the claim below remains the real safety net against
    // duplicate sends. FAILED is fail-closed (not auto-retried) — surfaced for
    // operator review rather than blindly resent.
    if (alreadySentLeadIds.has(lead.id)) { skipped++; continue }

    // Skip suppressed addresses (unsubscribed or bounced)
    if (isSuppressed(lead.email!)) { skipped++; continue }

    // Stop once daily cap is reached
    if (sent >= dailyRemaining) { skipped++; continue }

    // Get or generate outreach copy
    let subject: string
    let body: string

    if (lead.outreachDrafts[0]) {
      subject = lead.outreachDrafts[0].subject
      body = lead.outreachDrafts[0].emailBody
    } else {
      // Approval mode: only human-approved drafts may be sent. The query above
      // includes APPROVED drafts only, so an empty drafts array here means this
      // lead has nothing approved — it must be skipped, never sent with freshly
      // generated copy. (Without this guard, generating below would bypass the
      // entire approval gate.)
      if (icp?.approvalMode) { skipped++; continue }

      // Check AI limit before generating
      try {
        await checkAndIncrementAiUsage(workspaceId, 'AI_OUTREACH')
      } catch {
        skipped++
        continue  // AI limit reached — skip this lead
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
        // subject/body is unusable — refund the reserved call and skip this lead
        // rather than failing the whole batch (an isolated bad draft is expected).
        let parsed: OutreachDraftOutput
        try {
          parsed = parseAiJson(OutreachDraftOutputSchema, raw, 'send-campaign')
        } catch {
          await refundAiUsage(workspaceId, 'AI_OUTREACH').catch(() => {})
          skipped++; continue
        }
        subject = parsed.subject
        body    = parsed.email

        // Persist the draft so future sends reuse it
        await prisma.outreachDraft.create({
          data: {
            leadId:      lead.id,
            workspaceId,
            subject,
            emailBody: body,
            followup: parsed.followup ?? null,
          }
        })
      } catch (err) {
        console.error(`[send-campaign] Draft generation failed for lead ${lead.id}: ${(err as Error).message}`)
        // Generation failed after reserving the AI call — refund it.
        await refundAiUsage(workspaceId, 'AI_OUTREACH').catch(() => {})
        failed++
        continue
      }
    }

    const escHtml = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    const unsubscribeToken = randomBytes(24).toString('hex')
    const safeAppUrl = escHtml(appUrl)
    const unsubscribeUrl = `${safeAppUrl}/api/unsubscribe/${unsubscribeToken}`
    // CAN-SPAM / GDPR: include sender identity and physical address when configured
    const senderLine = workspace?.senderBusinessName
      ? `<br>${escHtml(workspace.senderBusinessName)}${workspace.senderPostalAddress ? `, ${escHtml(workspace.senderPostalAddress)}` : ''}`
      : ''
    const footer = `<br><br><hr style="border:none;border-top:1px solid #eee;margin:24px 0"><p style="font-size:12px;color:#999">You received this email because you matched our outreach criteria. To stop receiving emails, <a href="${unsubscribeUrl}" style="color:#999">unsubscribe here</a>.${senderLine}</p>`
    const htmlBody = `<p>${escHtml(body).replace(/\n/g, '<br>')}</p>${footer}`

    // Outbox claim: insert a SENDING row BEFORE the SMTP call. The unique
    // (campaignId, leadId) constraint guarantees at-most-once delivery — a racing
    // attempt or a retry after a crash that happened post-send cannot create a
    // second claim, so the email is never sent twice.
    // Bridge (Stage 5): if an APPROVED OutreachIntent is linked to this lead,
    // stamp its provenance onto the send so the record is self-auditable, and
    // mark the intent SENT on success. Best-effort lookup — never blocks a send.
    // Resolved from the batch-wide map pre-loaded above (one query for the whole
    // batch); the map was built by selecting OutreachIntents with
    // `leadId in batch, status: 'APPROVED'`, so this is the same approved-intent
    // link as the former per-lead findFirst, without the per-lead round-trip.
    const linkedIntent = linkedIntentByLeadId.get(lead.id) ?? null

    let claimId: string
    try {
      const claim = await prisma.outreachSent.create({
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
      claimId = claim.id
    } catch (err) {
      // Unique violation — another attempt already owns this send. Skip.
      if ((err as { code?: string }).code === 'P2002') { skipped++; continue }
      throw err
    }

    try {
      const info = await sendMailFn(lead.email!, subject, htmlBody, smtpCfg)
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
        // Advance the linked intent to SENT in the same transaction as the send.
        ...(linkedIntent ? [prisma.outreachIntent.update({ where: { id: linkedIntent.id }, data: { status: 'SENT' } })] : []),
      ])

      sent++
    } catch (err) {
      // Known SMTP rejection (nodemailer throws only when the provider did NOT
      // accept the message). Mark the claim FAILED with the error for operator
      // review instead of deleting it — fail-closed: it won't be auto-resent.
      // (A crash AFTER provider acceptance leaves the row SENDING, also never
      // resent.) Operators can clear FAILED rows to deliberately retry.
      const message = err instanceof Error ? err.message : 'SMTP send failed'
      console.error(`[send-campaign] SMTP failed for lead ${lead.id}: ${message}`)
      await prisma.outreachSent.update({
        where: { id: claimId },
        data: { status: 'FAILED', lastError: message.slice(0, 500) },
      }).catch(() => {})
      failed++
    }
  }

  await progress?.(100)
  return { campaignId, sent, skipped, failed }
}
