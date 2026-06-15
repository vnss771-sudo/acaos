// Pure-DB queue processors, extracted from worker.ts so they can be unit-tested
// against a real database without instantiating BullMQ Workers (which connect to
// Redis on construction). worker.ts wires these into Workers; tests call them
// directly.

import { prisma } from '../../api/src/lib/prisma.js'
import type { LeadStage } from '@prisma/client'
import { DEFAULT_SCORING_WEIGHTS } from '../../api/src/lib/scoring.js'
import {
  calculateOpportunityScores,
  detectBuyingStage,
  calcWinProbability,
  toRawSignal,
} from '../../api/src/lib/signalEngine.js'
import type { SignalType, SignalWeights } from '../../api/src/lib/signalEngine.js'
import { calibrate } from '../../api/src/lib/learningLoop.js'
import { generateOutreach } from '../../api/src/services/openai.js'
import { sendMail, isMailConfigured, type SmtpConfig } from '../../api/src/services/mail.js'
import { checkAndIncrementAiUsage } from '../../api/src/lib/limits.js'
import { bulkCheckSuppression } from '../../api/src/lib/suppressions.js'
import { randomBytes } from 'crypto'

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
): Promise<{ workspaceId: string; updated: number }> {
  const prospects = await prisma.prospect.findMany({
    where: { workspaceId },
    include: { signals: true },
  }) as ScoreProspectRow[]
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

  // Compute all score updates in memory first (pure CPU — no DB)
  const updates = prospects.map((prospect: ScoreProspectRow) => {
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
    return prisma.prospect.update({
      where: { id: prospect.id },
      data: { ...scores, buyingStage, winProbability },
    })
  })

  // Execute in parallel batches of 100 to avoid overwhelming the connection pool
  const BATCH = 100
  for (let i = 0; i < updates.length; i += BATCH) {
    await Promise.all(updates.slice(i, i + BATCH))
  }

  await progress?.(100)
  return { workspaceId, updated: prospects.length }
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

/**
 * Execute a campaign: generate personalised outreach for each eligible lead
 * (or reuse an existing draft), send via SMTP, and record in OutreachSent for
 * closed-loop reply tracking. Processes leads serially to stay within plan limits.
 */
export async function sendCampaignBatch(
  campaignId: string,
  workspaceId: string,
  leadIds: string[] | undefined,
  progress?: Progress
): Promise<SendCampaignResult> {
  // Load workspace-specific SMTP config (falls back to env vars in sendMail)
  // Load workspace config and ICP settings together — both are needed before
  // querying leads (approvalMode determines which drafts are eligible to send).
  const [wsCfgRecord, icp, workspace] = await Promise.all([
    prisma.workspaceEmailConfig.findUnique({ where: { workspaceId } }),
    prisma.workspaceICP.findUnique({ where: { workspaceId } }),
    prisma.workspace.findUnique({ where: { id: workspaceId }, select: { senderBusinessName: true, senderPostalAddress: true } }),
  ])
  const smtpCfg: SmtpConfig | null = wsCfgRecord ?? null
  if (!isMailConfigured(smtpCfg)) throw new Error('SMTP not configured — set SMTP_HOST and SMTP_FROM')

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
      // When approvalMode is on, only include APPROVED drafts so leads without
      // an approved draft are skipped rather than triggering AI generation.
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
  const suppressedSet = emailList.length > 0
    ? await bulkCheckSuppression(workspaceId, emailList)
    : new Set<string>()

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

    // Cheap pre-check before any AI work: skip leads already sent to, in-flight,
    // or terminally failed for this campaign. The unique (campaignId, leadId)
    // constraint on the claim below is the real safety net against duplicate
    // sends. FAILED is fail-closed (not auto-retried) — surfaced for operator
    // review rather than blindly resent.
    const alreadySent = await prisma.outreachSent.findFirst({
      where: { campaignId, leadId: lead.id, status: { in: ['SENT', 'SENDING', 'FAILED'] } },
      select: { id: true },
    })
    if (alreadySent) { skipped++; continue }

    // Skip suppressed addresses (unsubscribed or bounced)
    if (suppressedSet.has(lead.email!.toLowerCase().trim())) { skipped++; continue }

    // Stop once daily cap is reached
    if (sent >= dailyRemaining) { skipped++; continue }

    // Get or generate outreach copy
    let subject: string
    let body: string

    if (lead.outreachDrafts[0]) {
      subject = lead.outreachDrafts[0].subject
      body = lead.outreachDrafts[0].emailBody
    } else {
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
        })
        const parsed = JSON.parse(raw) as { subject?: string; email?: string; followup?: string }
        if (!parsed.subject || !parsed.email) { skipped++; continue }
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
    let claimId: string
    try {
      const claim = await prisma.outreachSent.create({
        data: {
          workspaceId, campaignId, leadId: lead.id,
          toEmail: lead.email!, subject, body,
          unsubscribeToken, status: 'SENDING',
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
      const info = await sendMail(lead.email!, subject, htmlBody, smtpCfg)
      const msgId = (info as any).messageId ?? null

      await prisma.$transaction([
        prisma.outreachSent.update({
          where: { id: claimId },
          data: { messageId: msgId, status: 'SENT', sentAt: new Date() }
        }),
        prisma.lead.update({
          where: { id: lead.id },
          data: { stage: 'OUTREACH_SENT', lastContactedAt: new Date() }
        })
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
