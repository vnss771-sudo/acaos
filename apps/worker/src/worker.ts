import 'dotenv/config'
import { validateEnv } from '../../api/src/lib/env.js'
validateEnv()
import { Worker } from 'bullmq'
import { connection, getQueue, defaultJobOptions } from './lib/queue.js'
import { generateLeadResearch, generateOutreach, analyzeReply, generateSignalAwareOutreach, generateOpportunityBrief } from '../../api/src/services/openai.js'
import type { ProductContext } from '../../api/src/services/openai.js'
import { sendMail, isMailConfigured } from '../../api/src/services/mail.js'
import { fetchJobPostings } from '../../api/src/services/apollo.js'
import { fetchNewsForCompany } from '../../api/src/services/news.js'
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
  explainOpportunityScores,
  classifyProspectSignals,
  signalPatternKey,
  computeLearnedWeights,
  ROLE_KEYWORDS,
  getActionRecommendation,
  getWindowExpiresInDays,
} from '../../api/src/lib/signalEngine.js'
import type { SignalWeights, SignalType, SignalDecision } from '../../api/src/lib/signalEngine.js'
import { calibrate } from '../../api/src/lib/learningLoop.js'
import { cfg } from '../../api/src/lib/env.js'
import { detectVertical } from '../../api/src/lib/verticals.js'

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
    const { replyBody, leadId, prospectId } = job.data as { replyBody: string; leadId?: string; prospectId?: string }
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

    // Prospect reply handling — update outcome stage based on classification
    if (prospectId && parsed.classification && !parsed.isAutoReply) {
      const prospectStageMap: Record<string, string> = {
        INTERESTED:      'MEETING',
        NOT_INTERESTED:  'LOST',
        NEEDS_MORE_INFO: 'MEETING',
        NOT_NOW:         'CONTACTED',
        REFERRAL:        'MEETING',
        OUT_OF_OFFICE:   'CONTACTED',
      }
      const newOutcomeStage = prospectStageMap[parsed.classification]
      const prospect = await prisma.prospect.findUnique({
        where: { id: prospectId },
        select: { workspaceId: true, contactEmail: true, contactName: true, industry: true },
        // include signals for combination tracking
      })
      const prospectWithSignals = prospect ? await prisma.prospect.findUnique({
        where:   { id: prospectId },
        include: { signals: { select: { type: true, strength: true, sourceReliability: true, detectedAt: true } } },
      }) : null

      if (prospect) {
        if (newOutcomeStage) {
          await prisma.prospect.update({
            where: { id: prospectId },
            data:  { outcomeStage: newOutcomeStage as import('@prisma/client').OutcomeStage, lastContactedAt: new Date() },
          })
        }

        // Record message outcome for the learning loop
        prisma.messageOutcome.create({
          data: {
            workspaceId: prospect.workspaceId,
            prospectId,
            event:       'REPLIED',
            channel:     'EMAIL',
            respondedAt: new Date(),
          },
        }).catch(() => {})

        // Update signal combination performance — track reply outcome
        if (prospectWithSignals?.signals) {
          const rawSigs = prospectWithSignals.signals.map(s => ({
            type:              s.type as SignalType,
            strength:          s.strength,
            sourceReliability: s.sourceReliability,
            industryRelevance: 70,
            detectedAt:        s.detectedAt,
          }))
          const pattern = signalPatternKey(rawSigs)
          const isPositive = ['INTERESTED', 'NEEDS_MORE_INFO', 'REFERRAL'].includes(parsed.classification ?? '')
          const isMeeting  = parsed.classification === 'INTERESTED'
          const isUnsub    = parsed.classification === 'NOT_INTERESTED'
          prisma.signalCombinationPerformance.upsert({
            where:  { workspaceId_signalPattern: { workspaceId: prospect.workspaceId, signalPattern: pattern } },
            create: {
              workspaceId:      prospect.workspaceId,
              signalPattern:    pattern,
              vertical:         prospectWithSignals.industry ?? null,
              replyCount:       isPositive ? 1 : 0,
              meetingCount:     isMeeting  ? 1 : 0,
              unsubscribeCount: isUnsub    ? 1 : 0,
            },
            update: {
              replyCount:       isPositive ? { increment: 1 } : undefined,
              meetingCount:     isMeeting  ? { increment: 1 } : undefined,
              unsubscribeCount: isUnsub    ? { increment: 1 } : undefined,
            },
          }).catch(() => {})

          // Trigger weight retraining once workspace has enough pattern data (>=10 patterns with >=5 sends each)
          prisma.signalCombinationPerformance.count({
            where: { workspaceId: prospect.workspaceId, sentCount: { gte: 5 } },
          }).then(count => {
            if (count >= 10) {
              getQueue('retrain-signal-weights').add(
                'retrain-signal-weights',
                { workspaceId: prospect.workspaceId },
                { ...defaultJobOptions, jobId: `retrain-weights:${prospect.workspaceId}` }
              ).catch(() => {})
            }
          }).catch(() => {})
        }

        // When INTERESTED and a calendar URL is configured, auto-send booking link
        if (parsed.classification === 'INTERESTED' && prospect.contactEmail && isMailConfigured()) {
          const productConfig = await prisma.workspaceProduct.findUnique({
            where: { workspaceId: prospect.workspaceId },
            select: { calendarUrl: true, productName: true },
          })
          if (productConfig?.calendarUrl) {
            const firstName = prospect.contactName?.split(' ')[0] ?? 'there'
            const calHtml = `
              <p>Hi ${firstName},</p>
              <p>Great to hear from you!</p>
              <p>Here's a link to pick a time that works for you:</p>
              <p><a href="${productConfig.calendarUrl}" style="color:#3b82f6">${productConfig.calendarUrl}</a></p>
              <p>Looking forward to connecting.</p>
            `
            sendMail(
              prospect.contactEmail,
              'Quick follow-up — booking link',
              calHtml
            ).then(() => {
              prisma.messageOutcome.create({
                data: {
                  workspaceId: prospect.workspaceId,
                  prospectId,
                  event:   'SENT',
                  channel: 'EMAIL',
                  sentAt:  new Date(),
                },
              }).catch(() => {})
            }).catch(() => {})
          }
        }
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

    const [icp, scoringModel, ownerEmails] = await Promise.all([
      prisma.workspaceICP.findUnique({ where: { workspaceId } }),
      prisma.scoringModel.findUnique({ where: { workspaceId }, select: { signalWeights: true } }),
      prisma.membership.findMany({
        where: { workspaceId, role: 'owner' },
        include: { user: { select: { email: true } } },
      }),
    ])
    const signalWeights  = (scoringModel?.signalWeights ?? null) as SignalWeights | null
    const alertAddresses = ownerEmails.map(m => m.user.email).filter(Boolean)
    const icpConfig = icp ? {
      targetIndustries: icp.targetIndustries,
      minEmployees:     icp.minEmployees  ?? undefined,
      maxEmployees:     icp.maxEmployees  ?? undefined,
      targetGeos:       icp.targetGeos,
      mustHaveEmail:    icp.mustHaveEmail,
    } : undefined

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
        }, icpConfig, signalWeights ?? undefined)
        const buyingStage          = detectBuyingStage(rawSignals, scores.opportunityScore)
        const winProbability       = calcWinProbability(buyingStage, scores.opportunityScore)
        const expectedRevenueScore = calculateExpectedRevenue(
          winProbability,
          prospect.expectedDealValue,
          prospect.retentionProbability,
          prospect.expansionProbability,
        )
        const fpfResult = classifyProspectSignals(rawSignals, {
          industry:      prospect.industry,
          employeeCount: prospect.employeeCount,
          contactEmail:  prospect.contactEmail,
          contactName:   prospect.contactName,
          domain:        prospect.domain,
          location:      prospect.location,
        })
        await prisma.prospect.update({
          where: { id: prospect.id },
          data: {
            ...scores,
            buyingStage,
            winProbability,
            expectedRevenueScore,
            fpfDecision: fpfResult.decision,
            fpfReason:   fpfResult.reason,
          },
        })

        // Alert owners when a prospect transitions INTO PURCHASING stage
        const previousStage = prospect.buyingStage
        if (buyingStage === 'PURCHASING' && previousStage !== 'PURCHASING') {
          log('score-prospects', `🚨 PURCHASING transition: ${prospect.companyName} (${prospect.id})`)
          if (alertAddresses.length > 0 && isMailConfigured()) {
            const alertHtml = `
              <h2 style="color:#f59e0b">⚡ Buying Window Open</h2>
              <p><strong>${prospect.companyName}</strong> has entered the <strong>PURCHASING</strong> stage.</p>
              <ul>
                <li>Opportunity Score: ${scores.opportunityScore}/100</li>
                <li>Win Probability: ${Math.round(winProbability * 100)}%</li>
                ${prospect.contactEmail ? `<li>Contact: ${prospect.contactName ?? ''} &lt;${prospect.contactEmail}&gt;</li>` : ''}
              </ul>
              <p>Act now — this buying window typically closes within 7–14 days.</p>
            `
            for (const email of alertAddresses) {
              sendMail(email, `⚡ ${prospect.companyName} is ready to buy`, alertHtml).catch(() => {})
            }
          }
        }

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
            const poaSignal = await prisma.signal.create({
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

            // Immediately rescore with the new POA signal so this prospect's
            // buying stage and opportunity score reflect activation in this cycle
            // (not waiting for the next score-prospects run).
            const updatedRawSignals = [...prospect.signals, poaSignal].map(toRawSignal)
            const updatedScores = calculateOpportunityScores(updatedRawSignals, {
              industry:      prospect.industry,
              employeeCount: prospect.employeeCount,
              contactEmail:  prospect.contactEmail,
              contactName:   prospect.contactName,
              domain:        prospect.domain,
              location:      prospect.location,
            }, icpConfig, signalWeights ?? undefined)
            const updatedStage   = detectBuyingStage(updatedRawSignals, updatedScores.opportunityScore)
            const updatedWinProb = calcWinProbability(updatedStage, updatedScores.opportunityScore)
            const updatedExpRev  = calculateExpectedRevenue(
              updatedWinProb,
              prospect.expectedDealValue,
              prospect.retentionProbability,
              prospect.expansionProbability,
            )
            await prisma.prospect.update({
              where: { id: prospect.id },
              data:  { ...updatedScores, buyingStage: updatedStage, winProbability: updatedWinProb, expectedRevenueScore: updatedExpRev },
            })

            // Check for PURCHASING transition triggered by the POA signal
            if (updatedStage === 'PURCHASING' && buyingStage !== 'PURCHASING') {
              log('score-prospects', `🚨 POA-triggered PURCHASING transition: ${prospect.companyName}`)
              if (alertAddresses.length > 0 && isMailConfigured()) {
                const alertHtml = `
                  <h2 style="color:#f59e0b">⚡ Buying Window Open (POA Triggered)</h2>
                  <p><strong>${prospect.companyName}</strong> just activated a Problem-Owner signal and entered <strong>PURCHASING</strong> stage.</p>
                  <ul>
                    <li>Opportunity Score: ${updatedScores.opportunityScore}/100</li>
                    <li>Win Probability: ${Math.round(updatedWinProb * 100)}%</li>
                    <li>POA Tier: ${activation.activationTier}</li>
                    ${prospect.contactEmail ? `<li>Contact: ${prospect.contactName ?? ''} &lt;${prospect.contactEmail}&gt;</li>` : ''}
                  </ul>
                  <p>Act now — this buying window typically closes within 7–14 days.</p>
                `
                for (const email of alertAddresses) {
                  sendMail(email, `⚡ ${prospect.companyName} is ready to buy (POA)`, alertHtml).catch(() => {})
                }
              }
            }
          }
        }
      }))

      updated += batch.length
      cursor = batch[batch.length - 1].id
      if (batch.length < BATCH_SIZE) break
    }

    // Enqueue Opportunity Briefs for HOT prospects that pass the False Positive Filter
    const hotProspects = await prisma.prospect.findMany({
      where:   { workspaceId, opportunityScore: { gte: 72 }, outcomeStage: { notIn: ['WON', 'LOST'] } },
      include: { signals: true },
      take:    50,
    })
    for (const hp of hotProspects) {
      // Use persisted fpfDecision from the scoring pass above — no recompute needed
      if (hp.fpfDecision === 'IGNORE') {
        log('score-prospects', `FPF: skipping brief for ${hp.companyName} (${hp.id}) — ${hp.fpfReason ?? 'ignored'}`)
        continue
      }
      await getQueue('generate-opportunity-brief').add(
        'generate-opportunity-brief',
        { prospectId: hp.id, workspaceId },
        { ...defaultJobOptions, jobId: `opportunity-brief:${hp.id}` }
      )
    }

    await job.updateProgress(100)
    log('score-prospects', `Done: ${updated} prospects rescored — triggering downstream jobs`)
    await Promise.all([
      getQueue('generate-strategy-cards').add(
        'generate-strategy-cards',
        { workspaceId },
        { ...defaultJobOptions, jobId: `strategy-cards:${workspaceId}` }
      ),
      getQueue('harvest-signals').add(
        'harvest-signals',
        { workspaceId },
        { ...defaultJobOptions, jobId: `harvest-signals:${workspaceId}` }
      ),
    ])
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

    const enrollment = await prisma.cadenceEnrollment.findUnique({
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
      await prisma.cadenceEnrollment.update({
        where: { id: enrollmentId },
        data:  { status: 'COMPLETED', completedAt: new Date() },
      })
      log('advance-cadence', `Auto-completed: prospect ${prospect.id} is at ${prospect.outcomeStage}`)
      return { completed: true, reason: 'prospect_advanced' }
    }

    const steps = enrollment.cadence.steps as Array<{ dayOffset: number; channel: string; templateType: string }>
    const step  = steps[enrollment.currentStep]

    if (!step) {
      await prisma.cadenceEnrollment.update({
        where: { id: enrollmentId },
        data:  { status: 'COMPLETED', completedAt: new Date() },
      })
      log('advance-cadence', `No more steps — completing ${enrollmentId}`)
      return { completed: true }
    }

    const nextStep     = steps[enrollment.currentStep + 1]
    const nextActionAt = nextStep
      ? new Date(new Date(enrollment.enrolledAt).getTime() + nextStep.dayOffset * 86_400_000)
      : null

    await job.updateProgress(20)

    // ── Channel dispatch ──────────────────────────────────────────────────────
    if (step.channel === 'LINKEDIN' || step.channel === 'PHONE') {
      // Non-email channels: record the touch as a manual-task placeholder and advance.
      // The CRM records the event so the rep knows what to do; no automated send.
      const hasLinkedIn = step.channel === 'LINKEDIN' && Boolean(prospect.linkedinUrl)
      const hasPhone    = step.channel === 'PHONE'    && Boolean(prospect.contactPhone)

      if (!hasLinkedIn && !hasPhone && step.channel === 'LINKEDIN') {
        log('advance-cadence', `No LinkedIn URL for ${prospect.id} — skipping step ${enrollment.currentStep}`)
      } else if (!hasPhone && step.channel === 'PHONE') {
        log('advance-cadence', `No phone for ${prospect.id} — skipping step ${enrollment.currentStep}`)
      } else {
        await prisma.messageOutcome.create({
          data: {
            workspaceId: prospect.workspaceId,
            prospectId:  prospect.id,
            event:       'SENT',
            channel:     step.channel,
            sentAt:      new Date(),
          },
        })
        log('advance-cadence', `${step.channel} touch recorded for ${prospect.id} step ${enrollment.currentStep}`)
      }

      await prisma.$transaction([
        prisma.prospect.update({
          where: { id: prospect.id },
          data:  { outcomeStage: 'CONTACTED', lastContactedAt: new Date() },
        }),
        prisma.cadenceEnrollment.update({
          where: { id: enrollmentId },
          data: {
            currentStep:  enrollment.currentStep + 1,
            nextActionAt,
            status:       nextStep ? 'ACTIVE' : 'COMPLETED',
            completedAt:  nextStep ? null : new Date(),
          },
        }),
      ])

      await job.updateProgress(100)
      log('advance-cadence', `${step.channel} step ${enrollment.currentStep} done — next: ${nextActionAt?.toISOString() ?? 'none'}`)
      return { channel: step.channel, step: enrollment.currentStep, nextActionAt }
    }

    // ── EMAIL channel ─────────────────────────────────────────────────────────
    // Check email suppression list before sending
    if (prospect.contactEmail) {
      const suppressed = await prisma.emailSuppression.findUnique({
        where: { workspaceId_email: { workspaceId: prospect.workspaceId, email: prospect.contactEmail } },
      })
      if (suppressed) {
        await prisma.cadenceEnrollment.update({
          where: { id: enrollmentId },
          data:  { status: 'PAUSED' },
        })
        log('advance-cadence', `Email suppressed for ${prospect.contactEmail} — pausing ${enrollmentId}`)
        return { paused: true, reason: 'email_suppressed' }
      }
    }

    if (!prospect.contactEmail) {
      await prisma.cadenceEnrollment.update({
        where: { id: enrollmentId },
        data:  { status: 'PAUSED' },
      })
      log('advance-cadence', `No contact email — pausing ${enrollmentId}`)
      return { paused: true, reason: 'no_email' }
    }

    if (!isMailConfigured()) {
      await prisma.cadenceEnrollment.update({
        where: { id: enrollmentId },
        data:  { status: 'PAUSED' },
      })
      log('advance-cadence', `Mail not configured — pausing ${enrollmentId}`)
      return { paused: true, reason: 'mail_not_configured' }
    }

    // Require human review for INITIAL step when cadence has requiresReview=true
    if (enrollment.cadence.requiresReview && step.templateType === 'INITIAL') {
      await prisma.cadenceEnrollment.update({
        where: { id: enrollmentId },
        data:  { status: 'PENDING_REVIEW' },
      })
      log('advance-cadence', `Cadence ${enrollment.cadenceId} requires review — pausing enrollment ${enrollmentId} for human approval`)
      return { paused: true, reason: 'pending_review' }
    }

    // Enforce workspace daily send limit
    const workspaceProduct = await prisma.workspaceProduct.findUnique({
      where: { workspaceId: prospect.workspaceId },
    }) as ProductContext | null
    const sendLimit = (workspaceProduct as { sendLimitPerDay?: number | null } | null)?.sendLimitPerDay ?? 50
    const todayStart = new Date()
    todayStart.setUTCHours(0, 0, 0, 0)
    const todaySends = await prisma.messageSend.count({
      where: { workspaceId: prospect.workspaceId, channel: 'EMAIL', sentAt: { gte: todayStart } },
    })
    if (todaySends >= sendLimit) {
      // Re-schedule for tomorrow
      const tomorrow = new Date(todayStart.getTime() + 86_400_000)
      await prisma.cadenceEnrollment.update({
        where: { id: enrollmentId },
        data:  { nextActionAt: tomorrow },
      })
      log('advance-cadence', `Daily send limit reached (${todaySends}/${sendLimit}) — rescheduling ${enrollmentId} for tomorrow`)
      return { rescheduled: true, nextActionAt: tomorrow, reason: 'daily_send_limit' }
    }

    const poaSignal      = prospect.signals.find((s: { type: string }) => s.type === 'PROBLEM_OWNER_ACTIVATION')
    const poaTier        = (poaSignal?.title as string | undefined)?.match(/\((POSSIBLE|PROBABLE|CONFIRMED)\)/)?.[1]

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
      product:          workspaceProduct ?? undefined,
    })

    await job.updateProgress(60)

    const parsed = parseJson<{ subject?: string; email?: string }>(raw, {})
    if (!parsed.subject || !parsed.email) {
      log('advance-cadence', `AI output invalid for ${enrollmentId} — skipping step`)
      return { error: 'invalid_ai_output' }
    }

    // Create outcome record before sending so its ID is available for tracking injection
    const outcome = await prisma.messageOutcome.create({
      data: { workspaceId: prospect.workspaceId, prospectId: prospect.id, event: 'SENT', channel: 'EMAIL', sentAt: new Date() },
    })

    // Append-only send ledger — preserves denominator for learning loop
    const messageSend = await prisma.messageSend.create({
      data: {
        workspaceId:    prospect.workspaceId,
        prospectId:     prospect.id,
        channel:        'EMAIL',
        subject:        parsed.subject,
        bodyText:       parsed.email,
        recipientEmail: prospect.contactEmail,
      },
    })

    // Record signal pattern for combination performance tracking (fire-and-forget)
    const rawSigs = prospect.signals.map(toRawSignal)
    const pattern = signalPatternKey(rawSigs)
    prisma.signalCombinationPerformance.upsert({
      where:  { workspaceId_signalPattern: { workspaceId: prospect.workspaceId, signalPattern: pattern } },
      create: { workspaceId: prospect.workspaceId, signalPattern: pattern, vertical: prospect.industry ?? null, sentCount: 1 },
      update: { sentCount: { increment: 1 } },
    }).catch(() => {})

    // Personalise email with brief page URL when available
    const appUrl = cfg.appUrl
    const pageToken = prospect.prospectPageToken
    if (appUrl && pageToken) {
      parsed.email += `\n\nP.S. I've put together a quick intelligence brief on ${prospect.companyName}: ${appUrl}/for/${pageToken}`
    }

    await sendMail(
      prospect.contactEmail,
      parsed.subject,
      `<p style="font-family:sans-serif;line-height:1.6">${parsed.email.replace(/\n/g, '<br>')}</p>`,
      outcome.id
    )
    void messageSend

    await job.updateProgress(80)

    // Advance state atomically — outcome record already created before send
    await prisma.$transaction([
      prisma.prospect.update({
        where: { id: prospect.id },
        data:  { outcomeStage: 'CONTACTED', lastContactedAt: new Date() },
      }),
      prisma.cadenceEnrollment.update({
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
      where:    { workspaceId, source: { in: ['apollo-harvest', 'serper-news'] }, detectedAt: { gte: oneDayAgo } },
      select:   { prospectId: true },
      distinct: ['prospectId'],
    })
    const harvestedSet = new Set(recentRows.map(r => r.prospectId))

    const prospects = await prisma.prospect.findMany({
      where: {
        workspaceId,
        outcomeStage: { notIn: ['WON', 'LOST'] },
        NOT: { id: { in: [...harvestedSet] } },
      },
      select: { id: true, companyName: true, domain: true },
      take: 50,
    })

    await job.updateProgress(20)

    let signalsCreated = 0
    let prospectFailures = 0
    const step = Math.max(1, Math.floor(60 / Math.max(prospects.length, 1)))

    for (const prospect of prospects) {
      try {
        // ── Apollo job postings ──
        if (prospect.domain) {
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
                prospectId:        prospect.id,
                type:              'JOB_POSTING_SPIKE',
                strength,
                sourceReliability: 80,
                industryRelevance: 85,
                title:             `${matchingPostings.length} matching job posting${matchingPostings.length > 1 ? 's' : ''} detected`,
                description:       `Roles: ${titles}`,
                source:            'apollo-harvest',
                ...norm,
                detectedAt:        now,
                expiresAt:         computeSignalExpiry('JOB_POSTING_SPIKE', now),
              },
            })
            signalsCreated++
          }
        }

        // ── News mentions (Serper) ──
        const articles = await fetchNewsForCompany(prospect.companyName, prospect.domain, { limit: 5, withinDays: 14 })
        if (articles.length > 0) {
          const strength = Math.min(100, 40 + articles.length * 10)
          const headlines = articles.slice(0, 3).map(a => a.title).join(' · ')
          const norm      = normalizeSignal('NEWS_MENTION')
          const now       = new Date()

          await prisma.signal.create({
            data: {
              workspaceId,
              prospectId:        prospect.id,
              type:              'NEWS_MENTION',
              strength,
              sourceReliability: 70,
              industryRelevance: 70,
              title:             `${articles.length} news article${articles.length > 1 ? 's' : ''} in the last 14 days`,
              description:       headlines,
              source:            'serper-news',
              ...norm,
              detectedAt:        now,
              expiresAt:         computeSignalExpiry('NEWS_MENTION', now),
            },
          })
          signalsCreated++
        }
      } catch (err) {
        prospectFailures++
        log('harvest-signals', `Failed for prospect ${prospect.id}: ${(err as Error).message}`)
      }

      await job.updateProgress(20 + step)
    }

    // Degraded-job detection: >50% failure rate means the integration is broken
    if (prospects.length > 0 && prospectFailures / prospects.length > 0.5) {
      const msg = `[harvest-signals] DEGRADED workspaceId=${workspaceId} — ${prospectFailures}/${prospects.length} prospects failed. Check APOLLO_API_KEY and SERPER_API_KEY.`
      console.error(msg)
      // Alert workspace owner by email when SMTP is available
      if (isMailConfigured()) {
        const ownerMembership = await prisma.membership.findFirst({
          where: { workspaceId, role: 'OWNER' },
          include: { user: { select: { email: true } } }
        }).catch(() => null)
        const ownerEmail = ownerMembership?.user?.email
        if (ownerEmail) {
          await sendMail(
            ownerEmail,
            '[ACAOS] Signal harvesting degraded — action required',
            `<p style="font-family:sans-serif;line-height:1.6">` +
            `${prospectFailures} out of ${prospects.length} prospects failed signal harvesting.<br><br>` +
            `This usually means <strong>APOLLO_API_KEY</strong> or <strong>SERPER_API_KEY</strong> is missing or rate-limited.<br><br>` +
            `Please check your integration keys in the environment settings.</p>`
          ).catch(() => {}) // fire-and-forget, never block the job
        }
      }
    }

    if (signalsCreated > 0) {
      await Promise.all([
        getQueue('score-prospects').add(
          'score-prospects',
          { workspaceId },
          { ...defaultJobOptions, jobId: `score-after-harvest:${workspaceId}` }
        ),
        getQueue('re-engage').add(
          're-engage',
          { workspaceId },
          { ...defaultJobOptions, jobId: `re-engage:${workspaceId}` }
        ),
      ])
    }

    await job.updateProgress(100)
    log('harvest-signals', `Done workspaceId=${workspaceId} prospects=${prospects.length} signalsCreated=${signalsCreated}`)
    return { workspaceId, prospects: prospects.length, signalsCreated }
  },
  { connection, concurrency: 1 }
)

// ── re-engage ─────────────────────────────────────────────────────────────────
const reEngageWorker = new Worker(
  're-engage',
  async (job) => {
    const { workspaceId } = job.data as { workspaceId: string }
    log('re-engage', `Scanning re-engagement candidates for workspaceId=${workspaceId}`)

    await job.updateProgress(10)

    const fourteenDaysAgo = new Date(Date.now() - 14 * 86_400_000)
    const thirtyDaysAgo   = new Date(Date.now() - 30 * 86_400_000)

    // Prospects with score ≥55, not yet contacted or last contacted >30 days ago,
    // with a fresh signal in the past 14 days — worth a re-engagement nudge
    const candidates = await prisma.prospect.findMany({
      where: {
        workspaceId,
        opportunityScore: { gte: 55 },
        outcomeStage:     { in: ['DISCOVERED', 'VIEWED', 'CONTACTED'] },
        contactEmail:     { not: null },
        lastSignalAt:     { gte: fourteenDaysAgo },
        OR: [
          { lastContactedAt: null },
          { lastContactedAt: { lt: thirtyDaysAgo } },
        ],
      },
      select: { id: true, companyName: true, lastContactedAt: true, lastSignalAt: true },
      take: 20,
    })

    await job.updateProgress(40)

    // Filter: only re-engage if there are new signals since last contact
    const toEnroll = candidates.filter(p =>
      !p.lastContactedAt ||
      (p.lastSignalAt && p.lastSignalAt > p.lastContactedAt)
    )

    let enrolled = 0
    for (const prospect of toEnroll) {
      try {
        // Find or create the workspace default cadence
        let cadence = await prisma.cadence.findFirst({
          where: { workspaceId, isDefault: true },
        })
        if (!cadence) {
          cadence = await prisma.cadence.create({
            data: {
              workspaceId,
              name:      'Default 3-Step Email Sequence',
              isDefault: true,
              steps: [
                { dayOffset: 0,  channel: 'EMAIL', templateType: 'INITIAL'    },
                { dayOffset: 4,  channel: 'EMAIL', templateType: 'FOLLOWUP_1' },
                { dayOffset: 10, channel: 'EMAIL', templateType: 'FOLLOWUP_2' },
              ],
            },
          })
        }

        const enrollment = await prisma.cadenceEnrollment.upsert({
          where:  { prospectId_cadenceId: { prospectId: prospect.id, cadenceId: cadence.id } },
          create: {
            workspaceId,
            prospectId:   prospect.id,
            cadenceId:    cadence.id,
            currentStep:  0,
            status:       'ACTIVE',
            nextActionAt: new Date(),
          },
          update: {
            status:       'ACTIVE',
            currentStep:  0,
            nextActionAt: new Date(),
            completedAt:  null,
          },
        })

        await getQueue('advance-cadence').add('advance-cadence', { enrollmentId: enrollment.id }, defaultJobOptions)
        enrolled++
        log('re-engage', `Enrolled ${prospect.companyName} (${prospect.id}) in cadence`)
      } catch (err) {
        log('re-engage', `Failed to enroll ${prospect.id}: ${(err as Error).message}`)
      }
    }

    await job.updateProgress(100)
    log('re-engage', `Done workspaceId=${workspaceId} candidates=${candidates.length} enrolled=${enrolled}`)
    return { workspaceId, candidates: candidates.length, enrolled }
  },
  { connection, concurrency: 1 }
)

// ── generate-opportunity-brief ────────────────────────────────────────────────
const opportunityBriefWorker = new Worker(
  'generate-opportunity-brief',
  async (job) => {
    const { prospectId, workspaceId } = job.data as { prospectId: string; workspaceId: string }
    log('generate-opportunity-brief', `Generating brief for prospectId=${prospectId}`)

    const prospect = await prisma.prospect.findUnique({
      where: { id: prospectId },
      include: {
        signals: { orderBy: { detectedAt: 'desc' } },
        workspace: { include: { workspaceProduct: true } },
      },
    })
    if (!prospect) {
      log('generate-opportunity-brief', `Prospect ${prospectId} not found — skipping`)
      return null
    }

    await job.updateProgress(20)

    const rawSignals = prospect.signals.map(toRawSignal)
    const icpRow     = await prisma.workspaceICP.findUnique({ where: { workspaceId } })
    const icpConfig  = icpRow ? {
      targetIndustries: icpRow.targetIndustries,
      minEmployees:     icpRow.minEmployees  ?? undefined,
      maxEmployees:     icpRow.maxEmployees  ?? undefined,
      targetGeos:       icpRow.targetGeos,
      mustHaveEmail:    icpRow.mustHaveEmail,
    } : undefined

    const { evidence, ...scores } = explainOpportunityScores(
      rawSignals,
      {
        industry:      prospect.industry,
        employeeCount: prospect.employeeCount,
        contactEmail:  prospect.contactEmail,
        contactName:   prospect.contactName,
        domain:        prospect.domain,
        location:      prospect.location,
      },
      icpConfig,
    )

    await job.updateProgress(40)

    const signalsForBrief = prospect.signals.slice(0, 8).map(s => ({
      type:        s.type,
      title:       s.title,
      description: s.description,
      strength:    s.strength,
      ageDays:     Math.round((Date.now() - s.detectedAt.getTime()) / 86_400_000),
    }))

    const vertical = detectVertical(prospect.industry, prospect.description)
    const brief = await generateOpportunityBrief({
      companyName:      prospect.companyName,
      industry:         prospect.industry,
      location:         prospect.location,
      employeeCount:    prospect.employeeCount,
      contactTitle:     prospect.contactTitle ?? null,
      buyingStage:      prospect.buyingStage,
      opportunityScore: prospect.opportunityScore,
      signals:          signalsForBrief,
      evidence,
      product:          (prospect.workspace.workspaceProduct as ProductContext | null) ?? null,
      verticalContext:  vertical ? { likelyProblems: vertical.likelyProblems, ownerRoles: vertical.ownerRoles, offerAngles: vertical.offerAngles } : null,
    })

    await job.updateProgress(80)

    // Enrich with computed action recommendation and window expiry
    const computedAction = getActionRecommendation(
      scores.opportunityScore,
      scores.confidenceScore,
      prospect.fpfDecision as SignalDecision | null,
      prospect.buyingStage,
    )
    const computedWindowDays = getWindowExpiresInDays(prospect.signals, prospect.buyingStage)

    // Prefer AI recommendation when present and makes sense, fall back to computed
    const actionRecommendation = brief.actionRecommendation ?? computedAction
    const windowExpiresInDays  = brief.windowExpiresInDays  ?? computedWindowDays

    const expiresAt = new Date(Date.now() + 3 * 86_400_000) // 3 days
    await prisma.opportunityBrief.upsert({
      where:  { prospectId },
      create: {
        workspaceId,
        prospectId,
        ...brief,
        evidenceItems:    evidence.intentContributions,
        scoreBenchmark:   scores,
        rejectionReasons: evidence.rejectionReasons,
        actionRecommendation,
        whatNotToSay:       brief.whatNotToSay ?? null,
        windowExpiresInDays,
        expiresAt,
      },
      update: {
        ...brief,
        evidenceItems:    evidence.intentContributions,
        scoreBenchmark:   scores,
        rejectionReasons: evidence.rejectionReasons,
        actionRecommendation,
        whatNotToSay:       brief.whatNotToSay ?? null,
        windowExpiresInDays,
        generatedAt:      new Date(),
        expiresAt,
      },
    })

    // Generate and persist the public brief page token if this prospect doesn't have one yet
    if (!prospect.prospectPageToken) {
      const { randomBytes } = await import('node:crypto')
      const pageToken = randomBytes(20).toString('hex')
      await prisma.prospect.update({
        where: { id: prospectId },
        data:  { prospectPageToken: pageToken },
      })
    }

    await job.updateProgress(100)
    log('generate-opportunity-brief', `Done prospectId=${prospectId} confidence=${brief.confidenceScore} window=${brief.buyingWindowStrength}`)
    return { prospectId, confidenceScore: brief.confidenceScore, buyingWindowStrength: brief.buyingWindowStrength }
  },
  { connection, concurrency: 2 }
)

// ── retrain-signal-weights ────────────────────────────────────────────────────
const retrainWeightsWorker = new Worker(
  'retrain-signal-weights',
  async (job) => {
    const { workspaceId } = job.data as { workspaceId: string }
    log('retrain-signal-weights', `Retraining for workspaceId=${workspaceId}`)

    await job.updateProgress(10)

    const patterns = await prisma.signalCombinationPerformance.findMany({
      where: { workspaceId },
      select: { signalPattern: true, sentCount: true, replyCount: true, meetingCount: true },
    })

    await job.updateProgress(40)

    const learnedWeights = computeLearnedWeights(patterns)

    if (Object.keys(learnedWeights).length === 0) {
      log('retrain-signal-weights', `Not enough data for workspaceId=${workspaceId} — skipping`)
      return { workspaceId, skipped: true }
    }

    // Merge into existing ScoringModel.signalWeights — workspace may not have one yet
    await prisma.scoringModel.upsert({
      where:  { workspaceId },
      create: {
        workspaceId,
        weights:           {},
        signalWeights:     learnedWeights,
        performanceMetrics: {},
        updateCount:       1,
        lastWeightUpdate:  new Date(),
      },
      update: {
        signalWeights:    learnedWeights,
        updateCount:      { increment: 1 },
        lastWeightUpdate: new Date(),
      },
    })

    await job.updateProgress(80)

    // Immediately re-score so prospects reflect the new weights
    await getQueue('score-prospects').add(
      'score-prospects',
      { workspaceId },
      { ...defaultJobOptions, jobId: `score-after-retrain:${workspaceId}` }
    )

    await job.updateProgress(100)
    log('retrain-signal-weights', `Done workspaceId=${workspaceId} updated=${Object.keys(learnedWeights).length} signal types`)
    return { workspaceId, updatedTypes: Object.keys(learnedWeights).length }
  },
  { connection, concurrency: 2 }
)

// ── maintenance ───────────────────────────────────────────────────────────────
const maintenanceWorker = new Worker(
  'maintenance',
  async (job) => {
    log('maintenance', 'Daily maintenance run starting')
    const now         = new Date()
    const ninetyAgo   = new Date(now.getTime() - 90 * 86_400_000)

    await job.updateProgress(10)

    // 1. Delete expired Opportunity Briefs
    const briefs = await prisma.opportunityBrief.deleteMany({
      where: { expiresAt: { lt: now } },
    })

    await job.updateProgress(35)

    // 2. Delete expired Signals (only those with an explicit expiresAt set)
    const signals = await prisma.signal.deleteMany({
      where: { expiresAt: { not: null, lt: now } },
    })

    await job.updateProgress(60)

    // 3. Prune EngagementEvents older than 90 days
    const events = await prisma.engagementEvent.deleteMany({
      where: { occurredAt: { lt: ninetyAgo } },
    })

    await job.updateProgress(80)

    // 4. Prune MessageSends with no linked events older than 90 days
    const sends = await prisma.messageSend.deleteMany({
      where: {
        sentAt: { lt: ninetyAgo },
        events: { none: {} },
      },
    })

    // 5. Prune ProspectPageSession chat history older than 90 days (GDPR)
    const sessions = await prisma.prospectPageSession.deleteMany({
      where: { lastSeenAt: { lt: ninetyAgo } },
    })

    // 6. Prune old DailyBrief records (keep 30 days)
    const thirtyAgo = new Date(now.getTime() - 30 * 86_400_000)
    const dailyBriefs = await prisma.dailyBrief.deleteMany({
      where: { createdAt: { lt: thirtyAgo } },
    })

    await job.updateProgress(100)
    log('maintenance', `Done — briefs=${briefs.count} signals=${signals.count} events=${events.count} sends=${sends.count} sessions=${sessions.count} dailyBriefs=${dailyBriefs.count}`)
    return { briefs: briefs.count, signals: signals.count, events: events.count, sends: sends.count, sessions: sessions.count, dailyBriefs: dailyBriefs.count }
  },
  { connection, concurrency: 1 }
)

// ── daily-brief ───────────────────────────────────────────────────────────────
const dailyBriefWorker = new Worker(
  'daily-brief',
  async (job) => {
    const { workspaceId } = job.data as { workspaceId: string }

    // Scheduler sentinel — broadcast to all workspaces
    if (workspaceId === '__scheduler__') {
      const workspaces = await prisma.workspace.findMany({ select: { id: true } })
      for (const ws of workspaces) {
        await getQueue('daily-brief').add(
          'daily-brief',
          { workspaceId: ws.id },
          { ...defaultJobOptions, jobId: `daily-brief:${ws.id}:${new Date().toISOString().slice(0, 10)}` }
        )
      }
      log('daily-brief', `Scheduled daily briefs for ${workspaces.length} workspaces`)
      return { scheduled: workspaces.length }
    }

    const today = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
    log('daily-brief', `Generating daily brief for workspaceId=${workspaceId} date=${today}`)

    await job.updateProgress(10)

    const [hotProspects, warmProspects, ownerEmails] = await Promise.all([
      prisma.prospect.findMany({
        where: { workspaceId, opportunityScore: { gte: 72 }, outcomeStage: { notIn: ['WON', 'LOST'] } },
        include: { opportunityBrief: { select: { whyNow: true, offerAngle: true } } },
        orderBy: { opportunityScore: 'desc' },
        take: 10,
      }),
      prisma.prospect.findMany({
        where: { workspaceId, opportunityScore: { gte: 45, lt: 72 }, outcomeStage: { notIn: ['WON', 'LOST'] } },
        orderBy: { opportunityScore: 'desc' },
        take: 5,
      }),
      prisma.membership.findMany({
        where: { workspaceId, role: 'owner' },
        include: { user: { select: { email: true } } },
      }),
    ])

    await job.updateProgress(40)

    const topOpps = hotProspects.slice(0, 5).map(p => ({
      id: p.id,
      companyName: p.companyName,
      score: p.opportunityScore,
      tier: 'HOT' as const,
      whyNow: (p.opportunityBrief?.whyNow as string[] | null)?.[0] ?? null,
      action: p.contactEmail ? 'Send outreach' : 'Find contact email',
    }))

    // Upsert — idempotent so if re-run same day it updates not duplicates
    await prisma.dailyBrief.upsert({
      where: { workspaceId_date: { workspaceId, date: today } },
      create: { workspaceId, date: today, hotCount: hotProspects.length, warmCount: warmProspects.length, topOpps },
      update: { hotCount: hotProspects.length, warmCount: warmProspects.length, topOpps },
    })

    await job.updateProgress(70)

    // Send morning digest email to owners
    if (isMailConfigured() && ownerEmails.length > 0 && (hotProspects.length > 0 || warmProspects.length > 0)) {
      const topOppRows = topOpps.map(o => `
        <tr>
          <td style="padding:8px 12px;border-bottom:1px solid #1e293b">${o.companyName}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #1e293b;color:#f59e0b">${o.score}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #1e293b;color:#94a3b8;font-size:13px">${o.whyNow ?? '—'}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #1e293b;color:#22c55e;font-size:13px">${o.action}</td>
        </tr>
      `).join('')

      const html = `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#0f172a;color:#e2e8f0;padding:24px;border-radius:12px">
          <h2 style="color:#f59e0b;margin:0 0 4px">⚡ Buying Window Brief — ${today}</h2>
          <p style="color:#94a3b8;margin:0 0 20px">Your pipeline snapshot for today</p>
          <div style="background:#1e293b;border-radius:8px;padding:16px;margin-bottom:20px">
            <span style="color:#f59e0b;font-size:24px;font-weight:bold">${hotProspects.length}</span>
            <span style="color:#94a3b8;margin-left:8px">HOT</span>
            <span style="margin:0 16px;color:#334155">·</span>
            <span style="color:#3b82f6;font-size:24px;font-weight:bold">${warmProspects.length}</span>
            <span style="color:#94a3b8;margin-left:8px">WARM</span>
          </div>
          ${topOpps.length > 0 ? `
          <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
            <thead>
              <tr style="background:#1e293b">
                <th style="text-align:left;padding:8px 12px;color:#94a3b8;font-weight:500">Company</th>
                <th style="text-align:left;padding:8px 12px;color:#94a3b8;font-weight:500">Score</th>
                <th style="text-align:left;padding:8px 12px;color:#94a3b8;font-weight:500">Why Now</th>
                <th style="text-align:left;padding:8px 12px;color:#94a3b8;font-weight:500">Next Action</th>
              </tr>
            </thead>
            <tbody>${topOppRows}</tbody>
          </table>` : ''}
          <p style="color:#475569;font-size:12px;margin:0">Powered by ACAOS signal intelligence</p>
        </div>
      `

      for (const m of ownerEmails) {
        sendMail(m.user.email, `⚡ ${hotProspects.length} HOT prospect${hotProspects.length !== 1 ? 's' : ''} in your pipeline — ${today}`, html).catch(() => {})
      }

      await prisma.dailyBrief.update({
        where: { workspaceId_date: { workspaceId, date: today } },
        data:  { sentAt: new Date() },
      })
    }

    await job.updateProgress(100)
    log('daily-brief', `Done workspaceId=${workspaceId} hot=${hotProspects.length} warm=${warmProspects.length}`)
    return { workspaceId, date: today, hotCount: hotProspects.length, warmCount: warmProspects.length }
  },
  { connection, concurrency: 2 }
)

// ── Error handlers ─────────────────────────────────────────────────────────────
for (const [name, worker] of [
  ['research-lead',               researchWorker],
  ['generate-outreach',           outreachWorker],
  ['analyze-reply',               replyWorker],
  ['sync-mailbox',                mailboxWorker],
  ['score-prospects',             scoreProspectsWorker],
  ['generate-recommendations',    recommendWorker],
  ['calibrate-scoring',           calibrateWorker],
  ['generate-strategy-cards',     strategyCardsWorker],
  ['advance-cadence',             advanceCadenceWorker],
  ['harvest-signals',             harvestSignalsWorker],
  ['re-engage',                   reEngageWorker],
  ['generate-opportunity-brief',  opportunityBriefWorker],
  ['retrain-signal-weights',      retrainWeightsWorker],
  ['maintenance',                 maintenanceWorker],
  ['daily-brief',                 dailyBriefWorker],
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
    reEngageWorker.close(),
    opportunityBriefWorker.close(),
    retrainWeightsWorker.close(),
    maintenanceWorker.close(),
    dailyBriefWorker.close(),
  ])
  await prisma.$disconnect()
  console.log('[worker] Shutdown complete')
  process.exit(0)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT',  () => shutdown('SIGINT'))

// Register daily maintenance as a repeatable job (03:00 UTC every day)
getQueue('maintenance').add(
  'maintenance',
  {},
  { repeat: { pattern: '0 3 * * *' }, jobId: 'maintenance:daily' }
).catch(err => console.warn('[worker] Failed to register maintenance repeatable:', err.message))

// Register daily-brief scheduler as a repeatable job (07:00 UTC every day)
getQueue('daily-brief').add(
  'daily-brief',
  { workspaceId: '__scheduler__' },
  { repeat: { pattern: '0 7 * * *' }, jobId: 'daily-brief:scheduler' }
).catch(err => console.warn('[worker] Failed to register daily-brief repeatable:', err.message))

console.log('[worker] Started — listening on 15 queues (research-lead, generate-outreach, analyze-reply, sync-mailbox, score-prospects, generate-recommendations, calibrate-scoring, generate-strategy-cards, advance-cadence, harvest-signals, re-engage, generate-opportunity-brief, retrain-signal-weights, maintenance, daily-brief)')
