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
import { generateOutreach } from '../../api/src/services/openai.js'
import { sendMail, isMailConfigured, type SmtpConfig } from '../../api/src/services/mail.js'
import { checkAndIncrementAiUsage } from '../../api/src/lib/limits.js'

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

  // Compute all score updates in memory first (pure CPU — no DB)
  const updates = prospects.map(prospect => {
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
  const wsCfgRecord = await prisma.workspaceEmailConfig.findUnique({ where: { workspaceId } })
  const smtpCfg: SmtpConfig | null = wsCfgRecord ?? null
  if (!isMailConfigured(smtpCfg)) throw new Error('SMTP not configured — set SMTP_HOST and SMTP_FROM')

  await progress?.(5)

  const where = {
    campaignId,
    email: { not: null as null },
    stage: { notIn: ['OUTREACH_SENT', 'REPLIED', 'BOOKED', 'CLOSED', 'DEAD'] },
    ...(leadIds ? { id: { in: leadIds } } : {})
  }

  const leads = await prisma.lead.findMany({
    where,
    include: {
      outreachDrafts: { orderBy: { createdAt: 'desc' }, take: 1 }
    }
  })

  await progress?.(10)

  let sent = 0
  let skipped = 0
  let failed = 0
  const total = leads.length

  for (let i = 0; i < leads.length; i++) {
    const lead = leads[i]

    // Progress: 10% → 90% across the lead batch
    await progress?.(10 + Math.floor((i / total) * 80))

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

    // Send — HTML-escape the AI-generated body before interpolation so that
    // prompt-injection artifacts or special chars in CRM data can't inject
    // arbitrary HTML into the email.
    const escHtml = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    try {
      const info = await sendMail(lead.email!, subject, `<p>${escHtml(body).replace(/\n/g, '<br>')}</p>`, smtpCfg)
      const msgId = (info as any).messageId ?? null

      await prisma.$transaction([
        prisma.outreachSent.create({
          data: {
            workspaceId,
            campaignId,
            leadId: lead.id,
            toEmail: lead.email!,
            subject,
            body,
            messageId: msgId,
            status: 'SENT',
          }
        }),
        prisma.lead.update({
          where: { id: lead.id },
          data: { stage: 'OUTREACH_SENT', lastContactedAt: new Date() }
        })
      ])

      sent++
    } catch (err) {
      console.error(`[send-campaign] SMTP failed for lead ${lead.id}: ${(err as Error).message}`)
      failed++
    }
  }

  await progress?.(100)
  return { campaignId, sent, skipped, failed }
}
