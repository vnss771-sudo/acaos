import 'dotenv/config'
import { Worker } from 'bullmq'
import { connection, getQueue, defaultJobOptions } from './lib/queue.js'
import { generateLeadResearch, generateOutreach, analyzeReply, generateSignalAwareOutreach } from '../../api/src/services/openai.js'
import { sendMail, isMailConfigured } from '../../api/src/services/mail.js'
import { fetchJobPostings } from '../../api/src/services/apollo.js'
import { prisma } from '../../api/src/lib/prisma.js'
import { computeLeadScore, DEFAULT_SCORING_WEIGHTS } from '../../api/src/lib/scoring.js'
import type { ScoringWeights } from '../../api/src/lib/scoring.js'
import {
  calculateOpportunityScores,
  calculateExpectedRevenue,
  detectBuyingStage,
  calcWinProbability,
  generateRuleBasedRecommendation,
  toRawSignal,
  toFullSignal,
  detectProblemOwnerActivation,
  normalizeSignal,
  computeSignalExpiry,
  ROLE_KEYWORDS,
} from '../../api/src/lib/signalEngine.js'
import type { SignalWeights, SignalType } from '../../api/src/lib/signalEngine.js'
import { calibrate } from '../../api/src/lib/learningLoop.js'

function log(queue: string, msg: string) {
  console.log(`[${queue}] ${new Date().toISOString()} ${msg}`)
}

function parseJson<T>(raw: string, fallback: T): T {
  try { return JSON.parse(raw) } catch { return fallback }
}

async function getWorkspaceWeights(workspaceId: string): Promise<ScoringWeights> {
  const model = await prisma.scoringModel.findUnique({
    where: { workspaceId },
    select: { weights: true }
  })
  return (model?.weights as ScoringWeights | null) ?? DEFAULT_SCORING_WEIGHTS
}

// ── research-lead ─────────────────────────────────────────────────────────────
const researchWorker = new Worker(
  'research-lead',
  async (job) => {
    const { leadId } = job.data as { leadId: string }
    log('research-lead', `Processing leadId=${leadId}`)

    const lead = await prisma.lead.findUnique({ where: { id: leadId } })
    if (!lead) throw new Error(`Lead ${leadId} not found`)

    await job.updateProgress(10)

    const raw = await generateLeadResearch({
      businessName: lead.businessName,
      website: lead.website ?? undefined,
      category: lead.category ?? undefined,
      city: lead.city ?? undefined,
      notes: lead.notes ?? undefined
    })

    await job.updateProgress(60)

    const parsed = parseJson<{
      aiSummary?: string
      outreachAngle?: string
      qualificationSignals?: string[]
      icpScore?: number
      hiringSignals?: boolean
      digitalMaturity?: string
      estimatedTeamSize?: string
    }>(raw, {})

    const enrichedLead = {
      businessName: lead.businessName,
      category: lead.category,
      contactName: lead.contactName,
      email: lead.email,
      website: lead.website,
      notes: lead.notes,
      aiSummary: parsed.aiSummary ?? null,
      outreachAngle: parsed.outreachAngle ?? null
    }

    const weights = await getWorkspaceWeights(lead.workspaceId)
    const computedScore = computeLeadScore(enrichedLead, weights)
    const finalScore = (typeof parsed.icpScore === 'number' && parsed.icpScore >= 0 && parsed.icpScore <= 100)
      ? Math.round((parsed.icpScore + computedScore) / 2)
      : computedScore

    await job.updateProgress(80)

    await prisma.lead.update({
      where: { id: leadId },
      data: {
        aiSummary: parsed.aiSummary ?? null,
        outreachAngle: parsed.outreachAngle ?? null,
        score: finalScore,
        stage: 'RESEARCHED'
      }
    })

    await job.updateProgress(100)
    log('research-lead', `Done leadId=${leadId} stage=RESEARCHED score=${finalScore}`)
    return { leadId, aiSummary: parsed.aiSummary, outreachAngle: parsed.outreachAngle, score: finalScore }
  },
  { connection, concurrency: 3 }
)

// ── generate-outreach ─────────────────────────────────────────────────────────
const outreachWorker = new Worker(
  'generate-outreach',
  async (job) => {
    const { leadId } = job.data as { leadId: string }
    log('generate-outreach', `Processing leadId=${leadId}`)

    const lead = await prisma.lead.findUnique({ where: { id: leadId } })
    if (!lead) throw new Error(`Lead ${leadId} not found`)

    await job.updateProgress(10)

    const raw = await generateOutreach({
      businessName: lead.businessName,
      category: lead.category ?? undefined,
      city: lead.city ?? undefined,
      contactName: lead.contactName ?? undefined,
      aiSummary: lead.aiSummary ?? undefined,
      outreachAngle: lead.outreachAngle ?? undefined
    })

    await job.updateProgress(80)

    const parsed = parseJson<{ subject?: string; email?: string; followup?: string }>(raw, {})

    if (parsed.subject && parsed.email) {
      await prisma.outreachDraft.create({
        data: {
          leadId: lead.id,
          workspaceId: lead.workspaceId,
          subject: parsed.subject,
          emailBody: parsed.email,
          followup: parsed.followup ?? null
        }
      })

      if (lead.stage === 'RESEARCHED') {
        await prisma.lead.update({ where: { id: lead.id }, data: { stage: 'OUTREACH_SENT' } })
      }
    }

    await job.updateProgress(100)
    log('generate-outreach', `Done leadId=${leadId}`)
    return { leadId, subject: parsed.subject, email: parsed.email, followup: parsed.followup }
  },
  { connection, concurrency: 3 }
)

// ── analyze-reply ─────────────────────────────────────────────────────────────
const replyWorker = new Worker(
  'analyze-reply',
  async (job) => {
    const { replyBody, leadId } = job.data as { replyBody: string; leadId?: string }
    log('analyze-reply', `Processing${leadId ? ` leadId=${leadId}` : ''}`)

    await job.updateProgress(10)
    const raw = await analyzeReply(replyBody)
    await job.updateProgress(70)

    const parsed = parseJson<{
      classification?: string
      confidence?: number
      summary?: string
      suggestedAction?: string
      urgency?: string
      keyQuote?: string
      isAutoReply?: boolean
    }>(raw, {})

    if (leadId && parsed.classification) {
      if (!parsed.isAutoReply) {
        const stageMap: Record<string, string> = {
          INTERESTED: 'REPLIED',
          NOT_INTERESTED: 'DEAD',
          NEEDS_MORE_INFO: 'REPLIED',
          NOT_NOW: 'REPLIED',
          REFERRAL: 'REPLIED',
          OUT_OF_OFFICE: 'OUTREACH_SENT'
        }
        const newStage = stageMap[parsed.classification]
        if (newStage) {
          await prisma.lead.update({ where: { id: leadId }, data: { stage: newStage } })
        }
      }

      const lead = await prisma.lead.findUnique({
        where: { id: leadId },
        select: { workspaceId: true, score: true }
      })

      if (lead && !parsed.isAutoReply) {
        const model = await prisma.scoringModel.upsert({
          where: { workspaceId: lead.workspaceId },
          create: {
            workspaceId: lead.workspaceId,
            weights: DEFAULT_SCORING_WEIGHTS,
            performanceMetrics: {
              totalScored: 0, totalReplied: 0, replyRate: 0,
              avgScoreOfReplied: 0, avgScoreOfNotReplied: 0, correlationScore: 0
            }
          },
          update: {}
        })

        const replyIntentMap: Record<string, string> = {
          INTERESTED: 'INTERESTED',
          NOT_INTERESTED: 'NOT_INTERESTED',
          NEEDS_MORE_INFO: 'NEED_MORE_INFO',
          NOT_NOW: 'NEED_MORE_INFO',
          REFERRAL: 'INTERESTED',
          OUT_OF_OFFICE: 'NOT_INTERESTED'
        }

        const replied = !['NOT_INTERESTED', 'OUT_OF_OFFICE'].includes(parsed.classification ?? '')

        await prisma.scoringOutcome.create({
          data: {
            workspaceId: lead.workspaceId,
            leadId,
            prospectId: leadId,
            score: lead.score,
            replied,
            replyIntent: replyIntentMap[parsed.classification!] ?? null,
            messageRelevance: replied ? 0.8 : 0.2,
            channelUsed: 'EMAIL',
            scoringModelId: model.id
          }
        })
      }
    }

    await job.updateProgress(100)
    log('analyze-reply', `Done classification=${parsed.classification} isAutoReply=${parsed.isAutoReply}`)
    return parsed
  },
  { connection, concurrency: 5 }
)

// ── sync-mailbox ──────────────────────────────────────────────────────────────
const mailboxWorker = new Worker(
  'sync-mailbox',
  async (job) => {
    const { workspaceId } = job.data as { workspaceId?: string }
    log('sync-mailbox', `Processing workspaceId=${workspaceId}`)

    await job.updateProgress(10)
    const { syncMailboxOnce } = await import('../../api/src/services/mail.js')
    const result = await syncMailboxOnce()
    await job.updateProgress(100)

    log('sync-mailbox', `Done workspaceId=${workspaceId} inspected=${result.inspected} matched=${result.matched} queued=${result.queued}`)
    return result
  },
  { connection, concurrency: 1 }
)

// ── score-prospects ────────────────────────────────────────────────────────────
const scoreProspectsWorker = new Worker(
  'score-prospects',
  async (job) => {
    const { workspaceId } = job.data as { workspaceId: string }
    log('score-prospects', `Rescoring prospects for workspaceId=${workspaceId}`)

    await job.updateProgress(10)

    const [icp, scoringModel] = await Promise.all([
      prisma.workspaceICP.findUnique({ where: { workspaceId } }),
      prisma.scoringModel.findUnique({ where: { workspaceId }, select: { signalWeights: true } })
    ])
    const signalWeights = (scoringModel?.signalWeights ?? null) as SignalWeights | null

    const BATCH_SIZE = 200
    let cursor: string | undefined
    let updated = 0

    while (true) {
      const batch = await prisma.prospect.findMany({
        where: { workspaceId },
        include: { signals: true },
        orderBy: { id: 'asc' },
        take: BATCH_SIZE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      })
      if (batch.length === 0) break

      await Promise.all(batch.map(async prospect => {
        const rawSignals = prospect.signals.map(toRawSignal)
        const scores = calculateOpportunityScores(rawSignals, {
          industry:      prospect.industry,
          employeeCount: prospect.employeeCount,
          contactEmail:  prospect.contactEmail,
          contactName:   prospect.contactName,
          domain:        prospect.domain,
          location:      prospect.location,
        }, icp ?? undefined, signalWeights ?? undefined)
        const buyingStage          = detectBuyingStage(rawSignals, scores.opportunityScore)
        const winProbability       = calcWinProbability(buyingStage, scores.opportunityScore)
        const expectedRevenueScore = calculateExpectedRevenue(
          winProbability,
          prospect.expectedDealValue,
          prospect.retentionProbability,
          prospect.expansionProbability,
        )
        await prisma.prospect.update({
          where: { id: prospect.id },
          data: { ...scores, buyingStage, winProbability, expectedRevenueScore },
        })

        // Problem-Owner Activation detection
        const fullSignals = prospect.signals.map(s => toFullSignal({
          type: s.type as SignalType,
          strength: s.strength,
          sourceReliability: s.sourceReliability,
          industryRelevance: s.industryRelevance,
          detectedAt: s.detectedAt,
          title: s.title,
          description: s.description,
        }))
        const activation = detectProblemOwnerActivation(fullSignals)
        if (activation.activated) {
          const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000)
          const hasRecent = prospect.signals.some(s =>
            s.type === 'PROBLEM_OWNER_ACTIVATION' && s.detectedAt > sevenDaysAgo
          )
          if (!hasRecent) {
            const norm = normalizeSignal('PROBLEM_OWNER_ACTIVATION')
            await prisma.signal.create({
              data: {
                workspaceId,
                prospectId: prospect.id,
                type: 'PROBLEM_OWNER_ACTIVATION',
                strength: activation.recommendedStrength,
                sourceReliability: 85,
                industryRelevance: 90,
                title: `Problem-Owner Activation (${activation.activationTier})`,
                description: activation.evidencePieces.join(' · '),
                source: 'system',
                ...norm,
                expiresAt: computeSignalExpiry('PROBLEM_OWNER_ACTIVATION', new Date()),
              }
            })
          }
        }
      }))

      updated += batch.length
      cursor = batch[batch.length - 1].id
      if (batch.length < BATCH_SIZE) break
    }

    await job.updateProgress(100)
    log('score-prospects', `Done: ${updated} prospects rescored — triggering strategy cards`)
    await getQueue('generate-strategy-cards').add(
      'generate-strategy-cards',
      { workspaceId },
      { ...defaultJobOptions, jobId: `strategy-cards:${workspaceId}` }
    )
    return { workspaceId, updated }
  },
  { connection, concurrency: 1 }
)

// ── generate-recommendations ──────────────────────────────────────────────────
const recommendWorker = new Worker(
  'generate-recommendations',
  async (job) => {
    const { prospectId, workspaceId } = job.data as { prospectId: string; workspaceId: string }
    log('generate-recommendations', `Generating for prospectId=${prospectId}`)

    const prospect = await prisma.prospect.findUnique({
      where: { id: prospectId },
      include: { signals: true }
    })
    if (!prospect) throw new Error(`Prospect ${prospectId} not found`)

    await job.updateProgress(20)

    const rawSignals = prospect.signals.map(toRawSignal)

    const rec = generateRuleBasedRecommendation(
      {
        industry:      prospect.industry,
        employeeCount: prospect.employeeCount,
        contactEmail:  prospect.contactEmail,
        contactName:   prospect.contactName,
        contactPhone:  prospect.contactPhone,
        linkedinUrl:   prospect.linkedinUrl,
        domain:        prospect.domain,
        location:      prospect.location,
      },
      rawSignals,
      prospect.winProbability ?? 0,
    )

    const expectedRevenue = calculateExpectedRevenue(
      prospect.winProbability,
      prospect.expectedDealValue,
      prospect.retentionProbability,
      prospect.expansionProbability,
    )

    await prisma.recommendation.create({
      data: {
        workspaceId,
        prospectId,
        ...rec,
        expectedRevenue,
        expiresAt: new Date(Date.now() + 7 * 86_400_000)
      }
    })

    await job.updateProgress(100)
    log('generate-recommendations', `Done prospectId=${prospectId} channel=${rec.bestChannel}`)
    return { prospectId, ...rec }
  },
  { connection, concurrency: 3 }
)

// ── calibrate-scoring ─────────────────────────────────────────────────────────
const calibrateWorker = new Worker(
  'calibrate-scoring',
  async (job) => {
    const { workspaceId } = job.data as { workspaceId: string }
    log('calibrate-scoring', `Calibrating workspace=${workspaceId}`)

    await job.updateProgress(10)

    const [rawOutcomes, rawMessageOutcomes] = await Promise.all([
      prisma.prospectOutcome.findMany({
        where: { workspaceId, stage: { in: ['WON', 'LOST'] } },
        select: {
          stage: true,
          prospect: {
            select: {
              industry: true,
              employeeCount: true,
              signals: { select: { type: true } },
            },
          },
        },
        orderBy: { recordedAt: 'desc' },
        take: 100,
      }),
      prisma.messageOutcome.findMany({
        where: { workspaceId },
        select: {
          event: true,
          channel: true,
          sentAt: true,
          experiment: { select: { industry: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 500,
      }),
    ])

    await job.updateProgress(30)

    const outcomes = rawOutcomes.map(o => ({
      stage: o.stage as 'WON' | 'LOST',
      prospect: {
        industry: o.prospect.industry,
        employeeCount: o.prospect.employeeCount,
        signals: o.prospect.signals.map(s => ({ type: s.type }))
      }
    }))

    const messageOutcomes = rawMessageOutcomes.map(mo => ({
      event:     mo.event as string,
      channel:   mo.channel,
      industry:  mo.experiment?.industry ?? null,
      sentAtHour: mo.sentAt ? new Date(mo.sentAt).getUTCHours() : undefined,
      sentAtDow:  mo.sentAt ? new Date(mo.sentAt).getUTCDay()   : undefined,
    }))

    const result = calibrate(outcomes, messageOutcomes)
    await job.updateProgress(60)

    if (!result.stats.calibrated) {
      log('calibrate-scoring', `Skipped: ${result.stats.reason} (${result.stats.totalOutcomes} outcomes)`)
      return result.stats
    }

    await prisma.scoringModel.upsert({
      where: { workspaceId },
      create: {
        workspaceId,
        weights: DEFAULT_SCORING_WEIGHTS,
        signalWeights: result.signalWeights,
        channelWeights: result.channelWeights,
        timingWeights: result.timingWeights,
        performanceMetrics: {
          totalOutcomes: result.stats.totalOutcomes,
          winRate: result.stats.baselineWinRate,
          calibratedAt: new Date().toISOString()
        }
      },
      update: {
        signalWeights: result.signalWeights,
        channelWeights: result.channelWeights,
        timingWeights: result.timingWeights,
        lastWeightUpdate: new Date(),
        updateCount: { increment: 1 },
        performanceMetrics: {
          totalOutcomes: result.stats.totalOutcomes,
          winRate: result.stats.baselineWinRate,
          calibratedAt: new Date().toISOString()
        }
      }
    })

    await job.updateProgress(80)

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
        }
      })
    }

    await job.updateProgress(100)
    log('calibrate-scoring', `Done workspace=${workspaceId} winRate=${Math.round(result.stats.baselineWinRate * 100)}% signalTypes=${Object.keys(result.signalWeights).length}`)
    return result.stats
  },
  { connection, concurrency: 1 }
)

// ── generate-strategy-cards ───────────────────────────────────────────────────
const strategyCardsWorker = new Worker(
  'generate-strategy-cards',
  async (job) => {
    const { workspaceId } = job.data as { workspaceId: string }
    log('generate-strategy-cards', `Generating strategy cards for workspaceId=${workspaceId}`)

    await job.updateProgress(10)

    const prospects = await prisma.prospect.findMany({
      where: { workspaceId, outcomeStage: { notIn: ['WON', 'LOST'] } },
      include: {
        signals: true,
        recommendations: { orderBy: { createdAt: 'desc' }, take: 1 }
      },
      orderBy: { expectedRevenueScore: 'desc' },
      take: 20,
    })

    await job.updateProgress(20)

    const now = Date.now()
    const STALE_MS = 7 * 86_400_000

    let generated = 0
    for (const prospect of prospects) {
      const latestRec = prospect.recommendations[0]
      const isStale = !latestRec || (now - new Date(latestRec.createdAt).getTime()) > STALE_MS
      if (!isStale) continue

      const rawSignals = prospect.signals.map(toRawSignal)

      const rec = generateRuleBasedRecommendation(
        {
          industry:      prospect.industry,
          employeeCount: prospect.employeeCount,
          contactEmail:  prospect.contactEmail,
          contactName:   prospect.contactName,
          contactPhone:  prospect.contactPhone,
          linkedinUrl:   prospect.linkedinUrl,
          domain:        prospect.domain,
          location:      prospect.location,
        },
        rawSignals,
        prospect.winProbability ?? 0,
      )

      const expectedRevenue = calculateExpectedRevenue(
        prospect.winProbability,
        prospect.expectedDealValue,
        prospect.retentionProbability,
        prospect.expansionProbability,
      )

      await prisma.recommendation.create({
        data: {
          workspaceId,
          prospectId: prospect.id,
          ...rec,
          expectedRevenue,
          expiresAt: new Date(now + STALE_MS),
        }
      })
      generated++
    }

    await job.updateProgress(100)
    log('generate-strategy-cards', `Done workspaceId=${workspaceId} generated=${generated}/${prospects.length}`)
    return { workspaceId, generated, total: prospects.length }
  },
  { connection, concurrency: 1 }
)

// ── advance-cadence ───────────────────────────────────────────────────────────
const advanceCadenceWorker = new Worker(
  'advance-cadence',
  async (job) => {
    const { enrollmentId } = job.data as { enrollmentId: string }
    log('advance-cadence', `Processing enrollmentId=${enrollmentId}`)

    const enrollment = await (prisma as any).cadenceEnrollment.findUnique({
      where:   { id: enrollmentId },
      include: {
        prospect: {
          include: {
            signals:         { orderBy: { detectedAt: 'desc' }, take: 10 },
            recommendations: { orderBy: { priority: 'desc' }, take: 1 },
          },
        },
        cadence: true,
      },
    })

    if (!enrollment) throw new Error(`Enrollment ${enrollmentId} not found`)
    if (enrollment.status !== 'ACTIVE') {
      log('advance-cadence', `Enrollment ${enrollmentId} is ${enrollment.status} — skipping`)
      return { skipped: true, reason: enrollment.status }
    }

    const { prospect } = enrollment

    // Auto-complete if prospect has moved past the contact stage
    if (['MEETING', 'PROPOSAL', 'WON', 'LOST'].includes(prospect.outcomeStage)) {
      await (prisma as any).cadenceEnrollment.update({
        where: { id: enrollmentId },
        data:  { status: 'COMPLETED', completedAt: new Date() },
      })
      log('advance-cadence', `Auto-completed: prospect ${prospect.id} is at ${prospect.outcomeStage}`)
      return { completed: true, reason: 'prospect_advanced' }
    }

    const steps = enrollment.cadence.steps as Array<{ dayOffset: number; channel: string; templateType: string }>
    const step  = steps[enrollment.currentStep]

    if (!step) {
      await (prisma as any).cadenceEnrollment.update({
        where: { id: enrollmentId },
        data:  { status: 'COMPLETED', completedAt: new Date() },
      })
      log('advance-cadence', `No more steps — completing ${enrollmentId}`)
      return { completed: true }
    }

    if (!prospect.contactEmail) {
      await (prisma as any).cadenceEnrollment.update({
        where: { id: enrollmentId },
        data:  { status: 'PAUSED' },
      })
      log('advance-cadence', `No contact email — pausing ${enrollmentId}`)
      return { paused: true, reason: 'no_email' }
    }

    if (!isMailConfigured()) {
      await (prisma as any).cadenceEnrollment.update({
        where: { id: enrollmentId },
        data:  { status: 'PAUSED' },
      })
      log('advance-cadence', `Mail not configured — pausing ${enrollmentId}`)
      return { paused: true, reason: 'mail_not_configured' }
    }

    await job.updateProgress(20)

    const poaSignal = prospect.signals.find((s: { type: string }) => s.type === 'PROBLEM_OWNER_ACTIVATION')
    const poaTier   = (poaSignal?.title as string | undefined)?.match(/\((POSSIBLE|PROBABLE|CONFIRMED)\)/)?.[1]

    const raw = await generateSignalAwareOutreach({
      businessName:     prospect.companyName,
      category:         prospect.industry    ?? undefined,
      city:             prospect.location    ?? undefined,
      contactName:      prospect.contactName ?? undefined,
      aiSummary:        prospect.aiSummary   ?? undefined,
      outreachAngle:    prospect.recommendations[0]?.messageAngle ?? undefined,
      signals:          prospect.signals.map((s: { type: string; title: string | null; description: string | null; strength: number }) => ({
        type: s.type, title: s.title, description: s.description, strength: s.strength,
      })),
      buyingStage:      prospect.buyingStage,
      opportunityScore: prospect.opportunityScore,
      poaActivated:     Boolean(poaSignal),
      poaTier,
      templateType:     step.templateType as 'INITIAL' | 'FOLLOWUP_1' | 'FOLLOWUP_2',
    })

    await job.updateProgress(60)

    const parsed = parseJson<{ subject?: string; email?: string }>(raw, {})
    if (!parsed.subject || !parsed.email) {
      log('advance-cadence', `AI output invalid for ${enrollmentId} — skipping step`)
      return { error: 'invalid_ai_output' }
    }

    await sendMail(
      prospect.contactEmail,
      parsed.subject,
      `<p style="font-family:sans-serif;line-height:1.6">${parsed.email.replace(/\n/g, '<br>')}</p>`
    )

    await job.updateProgress(80)

    const nextStep      = steps[enrollment.currentStep + 1]
    const nextActionAt  = nextStep
      ? new Date(new Date(enrollment.enrolledAt).getTime() + nextStep.dayOffset * 86_400_000)
      : null

    await prisma.$transaction([
      prisma.messageOutcome.create({
        data: { workspaceId: prospect.workspaceId, prospectId: prospect.id, event: 'SENT', channel: 'EMAIL', sentAt: new Date() },
      }),
      prisma.prospect.update({
        where: { id: prospect.id },
        data:  { outcomeStage: 'CONTACTED', lastContactedAt: new Date() },
      }),
      (prisma as any).cadenceEnrollment.update({
        where: { id: enrollmentId },
        data: {
          currentStep:  enrollment.currentStep + 1,
          nextActionAt,
          status:       nextStep ? 'ACTIVE' : 'COMPLETED',
          completedAt:  nextStep ? null : new Date(),
        },
      }),
    ])

    // Track AI usage — non-fatal
    const month = new Date().toISOString().slice(0, 7)
    prisma.usageRecord.upsert({
      where:  { workspaceId_month_action: { workspaceId: prospect.workspaceId, month, action: 'AI_OUTREACH' } },
      create: { workspaceId: prospect.workspaceId, month, action: 'AI_OUTREACH', count: 1 },
      update: { count: { increment: 1 } },
    }).catch(() => {})

    await job.updateProgress(100)
    log('advance-cadence', `Step ${enrollment.currentStep} sent to ${prospect.contactEmail} — next: ${nextActionAt?.toISOString() ?? 'none (completed)'}`)
    return { sent: true, step: enrollment.currentStep, nextActionAt }
  },
  { connection, concurrency: 5 }
)

// ── harvest-signals ───────────────────────────────────────────────────────────
const harvestSignalsWorker = new Worker(
  'harvest-signals',
  async (job) => {
    const { workspaceId } = job.data as { workspaceId: string }
    log('harvest-signals', `Harvesting signals for workspaceId=${workspaceId}`)

    await job.updateProgress(10)

    // Find prospects with domains not harvested in the last 24h
    const oneDayAgo = new Date(Date.now() - 86_400_000)
    const recentRows = await prisma.signal.findMany({
      where:    { workspaceId, type: 'JOB_POSTING_SPIKE', source: 'apollo-harvest', detectedAt: { gte: oneDayAgo } },
      select:   { prospectId: true },
      distinct: ['prospectId'],
    })
    const harvestedSet = new Set(recentRows.map(r => r.prospectId))

    const prospects = await prisma.prospect.findMany({
      where: {
        workspaceId,
        domain:       { not: null },
        outcomeStage: { notIn: ['WON', 'LOST'] },
        NOT: { id: { in: [...harvestedSet] } },
      },
      select: { id: true, domain: true },
      take: 50,
    })

    await job.updateProgress(20)

    let signalsCreated = 0
    const step = Math.max(1, Math.floor(60 / Math.max(prospects.length, 1)))

    for (const prospect of prospects) {
      if (!prospect.domain) continue

      try {
        const postings        = await fetchJobPostings(prospect.domain)
        const matchingPostings = postings.filter(p =>
          ROLE_KEYWORDS.some(kw => p.title.toLowerCase().includes(kw.toLowerCase()))
        )

        if (matchingPostings.length > 0) {
          const strength = Math.min(100, 45 + matchingPostings.length * 8)
          const titles   = matchingPostings.slice(0, 3).map(p => p.title).join(', ')
          const norm     = normalizeSignal('JOB_POSTING_SPIKE')
          const now      = new Date()

          await prisma.signal.create({
            data: {
              workspaceId,
              prospectId:       prospect.id,
              type:             'JOB_POSTING_SPIKE',
              strength,
              sourceReliability: 80,
              industryRelevance: 85,
              title:            `${matchingPostings.length} matching job posting${matchingPostings.length > 1 ? 's' : ''} detected`,
              description:      `Roles: ${titles}`,
              source:           'apollo-harvest',
              ...norm,
              detectedAt:       now,
              expiresAt:        computeSignalExpiry('JOB_POSTING_SPIKE', now),
            },
          })
          signalsCreated++
        }
      } catch (err) {
        log('harvest-signals', `Failed for prospect ${prospect.id}: ${(err as Error).message}`)
      }

      await job.updateProgress(20 + step)
    }

    if (signalsCreated > 0) {
      await getQueue('score-prospects').add(
        'score-prospects',
        { workspaceId },
        { ...defaultJobOptions, jobId: `score-after-harvest:${workspaceId}` }
      )
    }

    await job.updateProgress(100)
    log('harvest-signals', `Done workspaceId=${workspaceId} prospects=${prospects.length} signalsCreated=${signalsCreated}`)
    return { workspaceId, prospects: prospects.length, signalsCreated }
  },
  { connection, concurrency: 1 }
)

// ── Error handlers ─────────────────────────────────────────────────────────────
for (const [name, worker] of [
  ['research-lead',            researchWorker],
  ['generate-outreach',        outreachWorker],
  ['analyze-reply',            replyWorker],
  ['sync-mailbox',             mailboxWorker],
  ['score-prospects',          scoreProspectsWorker],
  ['generate-recommendations', recommendWorker],
  ['calibrate-scoring',        calibrateWorker],
  ['generate-strategy-cards',  strategyCardsWorker],
  ['advance-cadence',          advanceCadenceWorker],
  ['harvest-signals',          harvestSignalsWorker],
] as [string, Worker][]) {
  worker.on('failed', (job, err) => {
    log(name, `Job ${job?.id} failed (attempt ${job?.attemptsMade}): ${err.message}`)
  })
  worker.on('error', (err) => {
    log(name, `Worker error: ${err.message}`)
  })
}

// ── Graceful shutdown ──────────────────────────────────────────────────────────
async function shutdown(signal: string) {
  console.log(`[worker] ${signal} received — shutting down`)
  await Promise.all([
    researchWorker.close(),
    outreachWorker.close(),
    replyWorker.close(),
    mailboxWorker.close(),
    scoreProspectsWorker.close(),
    recommendWorker.close(),
    calibrateWorker.close(),
    strategyCardsWorker.close(),
    advanceCadenceWorker.close(),
    harvestSignalsWorker.close(),
  ])
  await prisma.$disconnect()
  console.log('[worker] Shutdown complete')
  process.exit(0)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT',  () => shutdown('SIGINT'))

console.log('[worker] Started — listening on 10 queues (research-lead, generate-outreach, analyze-reply, sync-mailbox, score-prospects, generate-recommendations, calibrate-scoring, generate-strategy-cards, advance-cadence, harvest-signals)')
