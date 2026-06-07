import 'dotenv/config'
import { Worker } from 'bullmq'
import { connection, defaultJobOptions } from './lib/queue.js'
import { generateLeadResearch, generateOutreach, analyzeReply } from '../../api/src/services/openai.js'
import { prisma } from '../../api/src/lib/prisma.js'
import { computeLeadScore, DEFAULT_SCORING_WEIGHTS } from '../../api/src/lib/scoring.js'
import { logActivity } from '../../api/src/lib/activity.js'
import type { ScoringWeights } from '../../api/src/lib/scoring.js'

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

    // Build the enriched lead data for scoring
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

    // Use AI's icpScore if available and plausible, otherwise compute from signals
    const weights = await getWorkspaceWeights(lead.workspaceId)
    const computedScore = computeLeadScore(enrichedLead, weights)
    const finalScore = (typeof parsed.icpScore === 'number' && parsed.icpScore >= 0 && parsed.icpScore <= 100)
      ? Math.round((parsed.icpScore + computedScore) / 2) // blend AI + signal scores
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

    await logActivity({
      leadId, workspaceId: lead.workspaceId,
      type: 'AI_RESEARCH',
      meta: { score: finalScore, hiringSignals: parsed.hiringSignals, digitalMaturity: parsed.digitalMaturity, estimatedTeamSize: parsed.estimatedTeamSize }
    })

    log('research-lead', `Done leadId=${leadId} stage=RESEARCHED score=${finalScore}`)
    return { leadId, aiSummary: parsed.aiSummary, outreachAngle: parsed.outreachAngle, score: finalScore }
  },
  { connection, concurrency: 3, ...defaultJobOptions }
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

      // Advance to OUTREACH_SENT if still at RESEARCHED
      if (lead.stage === 'RESEARCHED') {
        await prisma.lead.update({ where: { id: lead.id }, data: { stage: 'OUTREACH_SENT' } })
      }
    }

    await job.updateProgress(100)

    if (parsed.subject && parsed.email) {
      await logActivity({
        leadId: lead.id, workspaceId: lead.workspaceId,
        type: 'AI_OUTREACH',
        meta: { subject: parsed.subject }
      })
    }

    log('generate-outreach', `Done leadId=${leadId}`)
    return { leadId, subject: parsed.subject, email: parsed.email, followup: parsed.followup }
  },
  { connection, concurrency: 3, ...defaultJobOptions }
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
          const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { stage: true, workspaceId: true, businessName: true } })
          if (lead) {
            await prisma.lead.update({ where: { id: leadId }, data: { stage: newStage } })
            await logActivity({
              leadId, workspaceId: lead.workspaceId,
              type: 'AI_REPLY',
              meta: { classification: parsed.classification, confidence: parsed.confidence, urgency: parsed.urgency, keyQuote: parsed.keyQuote, from: lead.stage, to: newStage }
            })
            // Fire webhook on noteworthy stage transitions
            const { fireStageWebhook } = await import('../../api/src/lib/webhook.js')
            fireStageWebhook(lead.workspaceId, leadId, lead.businessName, lead.stage, newStage)
          }
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
  { connection, concurrency: 5, ...defaultJobOptions }
)

// ── recompute-weights ─────────────────────────────────────────────────────────
const weightsWorker = new Worker(
  'recompute-weights',
  async (job) => {
    const { workspaceId } = job.data as { workspaceId: string }
    log('recompute-weights', `Processing workspaceId=${workspaceId}`)

    const model = await prisma.scoringModel.findUnique({ where: { workspaceId } })
    if (!model) { log('recompute-weights', 'No scoring model found, skipping'); return }

    const all = await prisma.scoringOutcome.findMany({
      where: { scoringModelId: model.id },
      select: { score: true, replied: true, messageRelevance: true, channelUsed: true }
    })
    if (all.length < 7) { log('recompute-weights', 'Not enough outcomes yet, skipping'); return }

    // Inline weight computation (same logic as outcomes.ts recomputeWeights)
    type Outcome = { score: number; replied: boolean; messageRelevance: number; channelUsed: string }
    type Weights = Record<string, number>

    function calculateCorrelation(outcomes: Outcome[]): number {
      if (outcomes.length < 2) return 0
      const meanScore = outcomes.reduce((s, o) => s + o.score, 0) / outcomes.length
      const meanReply = outcomes.filter(o => o.replied).length / outcomes.length
      let num = 0, denS = 0, denR = 0
      for (const o of outcomes) {
        const ds = o.score - meanScore, dr = (o.replied ? 1 : 0) - meanReply
        num += ds * dr; denS += ds * ds; denR += dr * dr
      }
      return (denS === 0 || denR === 0) ? 0 : num / Math.sqrt(denS * denR)
    }

    const replied = all.filter(o => o.replied)
    const notReplied = all.filter(o => !o.replied)
    const correlation = calculateCorrelation(all)
    const replyRate = all.length > 0 ? replied.length / all.length : 0
    const avgRepliedScore = replied.length > 0 ? replied.reduce((s, o) => s + o.score, 0) / replied.length : 0
    const avgNotRepliedScore = notReplied.length > 0 ? notReplied.reduce((s, o) => s + o.score, 0) / notReplied.length : 0
    const avgMessageRelevance = replied.length > 0 ? replied.reduce((s, o) => s + o.messageRelevance, 0) / replied.length : 0.5
    const linkedInReplies = replied.filter(o => o.channelUsed === 'LINKEDIN').length
    const emailReplies = replied.filter(o => o.channelUsed === 'EMAIL').length

    const weights = { ...(model.weights as Weights) }
    const learnRate = Math.min(0.15, 1 / all.length)
    if (Math.abs(correlation) > 0.1) weights['industry'] = Math.min(0.35, Math.max(0.05, weights['industry'] + learnRate * correlation * 0.3))
    if (avgMessageRelevance > 0.7) weights['messageRelevance'] = Math.min(0.20, (weights['messageRelevance'] ?? 0.08) + learnRate * 0.1)
    else if (avgMessageRelevance < 0.3) weights['messageRelevance'] = Math.max(0.02, (weights['messageRelevance'] ?? 0.08) - learnRate * 0.1)
    if (linkedInReplies > emailReplies * 2) weights['channelFit'] = Math.min(0.15, (weights['channelFit'] ?? 0.05) + learnRate * 0.05)
    const total = Object.values(weights).reduce((s, v) => s + v, 0)
    for (const k of Object.keys(weights)) weights[k] = Math.round((weights[k] / total) * 1000) / 1000

    const metrics = { totalScored: all.length, totalReplied: replied.length, replyRate, correlationScore: Math.round(correlation * 100) / 100, avgScoreOfReplied: Math.round(avgRepliedScore), avgScoreOfNotReplied: Math.round(avgNotRepliedScore) }

    await prisma.scoringModel.update({
      where: { id: model.id },
      data: { weights, performanceMetrics: metrics, updateCount: { increment: 1 }, lastWeightUpdate: new Date() }
    })

    log('recompute-weights', `Done workspaceId=${workspaceId} outcomes=${all.length} replyRate=${(replyRate * 100).toFixed(1)}% correlation=${correlation.toFixed(2)}`)
    return { workspaceId, totalOutcomes: all.length, replyRate, correlation }
  },
  { connection, concurrency: 2, attempts: 2, backoff: { type: 'exponential', delay: 3000 } }
)

// ── sync-mailbox ──────────────────────────────────────────────────────────────
const mailboxWorker = new Worker(
  'sync-mailbox',
  async (job) => {
    const { workspaceId } = job.data as { workspaceId?: string }
    log('sync-mailbox', `Processing workspaceId=${workspaceId ?? 'scheduled'}`)

    await job.updateProgress(10)
    const { syncMailboxOnce } = await import('../../api/src/services/mail.js')
    const result = await syncMailboxOnce()
    await job.updateProgress(100)

    log('sync-mailbox', `Done inspected=${result.inspected} matched=${result.matched} queued=${result.queued}`)
    return result
  },
  { connection, concurrency: 1, attempts: 2, backoff: { type: 'exponential', delay: 10_000 } }
)

// Attach error handlers
for (const [name, worker] of [
  ['research-lead', researchWorker],
  ['generate-outreach', outreachWorker],
  ['analyze-reply', replyWorker],
  ['recompute-weights', weightsWorker],
  ['sync-mailbox', mailboxWorker]
] as [string, Worker][]) {
  worker.on('failed', (job, err) => {
    log(name, `Job ${job?.id} failed (attempt ${job?.attemptsMade}): ${err.message}`)
  })
  worker.on('error', (err) => {
    log(name, `Worker error: ${err.message}`)
  })
}

// Set up recurring mailbox sync (every 5 minutes) — best effort
import('../../api/src/lib/queues.js').then(({ scheduleRecurringSync }) => {
  return scheduleRecurringSync()
}).then(() => {
  console.log('[worker] Recurring mailbox sync scheduled (every 5 min)')
}).catch(err => {
  console.warn('[worker] Could not schedule recurring sync:', err.message)
})

// Graceful shutdown
async function shutdown(signal: string) {
  console.log(`[worker] ${signal} received — shutting down`)
  await Promise.all([
    researchWorker.close(),
    outreachWorker.close(),
    replyWorker.close(),
    weightsWorker.close(),
    mailboxWorker.close()
  ])
  await prisma.$disconnect()
  console.log('[worker] Shutdown complete')
  process.exit(0)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

console.log('[worker] Started — listening on 5 queues (research-lead, generate-outreach, analyze-reply, recompute-weights, sync-mailbox)')
