import 'dotenv/config'
import { Worker, Queue } from 'bullmq'
import { connection } from './lib/queue.js'
import { startHealthServer } from './health.js'
import { generateLeadResearch, generateOutreach, analyzeReply } from '../../api/src/services/openai.js'
import { prisma } from '../../api/src/lib/prisma.js'
import { computeLeadScore, DEFAULT_SCORING_WEIGHTS } from '../../api/src/lib/scoring.js'
import type { ScoringWeights } from '../../api/src/lib/scoring.js'
import {
  calculateOpportunityScores,
  detectBuyingStage,
  calcWinProbability,
  generateRuleBasedRecommendation,
  toRawSignal,
} from '../../api/src/lib/signalEngine.js'
import type { SignalWeights } from '../../api/src/lib/signalEngine.js'
import { scoreProspects, calibrateScoring, sendCampaignBatch } from './processors.js'

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

      // Generating a draft is NOT a send. Do not advance the lead to
      // OUTREACH_SENT here — sendCampaignBatch excludes that stage from the send
      // selection, so marking it now would prevent the campaign from ever
      // sending the draft. sendCampaignBatch sets OUTREACH_SENT only after SMTP
      // delivery is recorded in OutreachSent.
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
            // Lead-sourced outcome — there is no Prospect. (Previously this
            // wrote the Lead id into prospectId, corrupting the column.)
            prospectId: null,
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
    const { workspaceId, autoSync } = job.data as { workspaceId?: string; autoSync?: boolean }
    const { syncMailboxOnce, isMailboxConfigured } = await import('../../api/src/services/mail.js')

    if (autoSync) {
      log('sync-mailbox', 'Auto-scanning all workspace mailboxes')
      const configs = await prisma.workspaceEmailConfig.findMany({
        where: { imapHost: { not: null } }
      })
      let synced = 0
      for (const cfg of configs) {
        if (!isMailboxConfigured(cfg)) continue
        try {
          await syncMailboxOnce(cfg as any, cfg.workspaceId)
          synced++
        } catch (err) {
          log('sync-mailbox', `Auto-sync failed for ${cfg.workspaceId}: ${(err as Error).message}`)
        }
      }
      log('sync-mailbox', `Auto-sync complete: ${synced}/${configs.length} workspaces`)
      return { autoSync: true, synced, total: configs.length }
    }

    log('sync-mailbox', `Processing workspaceId=${workspaceId}`)
    await job.updateProgress(10)
    const cfg = workspaceId
      ? await prisma.workspaceEmailConfig.findUnique({ where: { workspaceId } })
      : null
    if (!isMailboxConfigured(cfg ?? undefined)) {
      log('sync-mailbox', `No IMAP config for workspaceId=${workspaceId}, skipping`)
      await job.updateProgress(100)
      return { inspected: 0, matched: 0, queued: 0 }
    }
    const result = await syncMailboxOnce(cfg as any, workspaceId)
    await job.updateProgress(100)
    log('sync-mailbox', `Done workspaceId=${workspaceId} inspected=${result.inspected} matched=${result.matched} queued=${result.queued} bounced=${result.bounced}`)
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
    const result = await scoreProspects(workspaceId, (n) => job.updateProgress(n))
    log('score-prospects', `Done: ${result.updated} prospects rescored`)
    return result
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
      rawSignals
    )

    await prisma.recommendation.create({
      data: {
        workspaceId,
        prospectId,
        ...rec,
        expiresAt: new Date(Date.now() + 7 * 86_400_000)
      }
    })

    await job.updateProgress(100)
    log('generate-recommendations', `Done prospectId=${prospectId} channel=${rec.bestChannel}`)
    return { prospectId, ...rec }
  },
  { connection, concurrency: 3 }
)

// ── send-campaign ─────────────────────────────────────────────────────────────
const sendCampaignWorker = new Worker(
  'send-campaign',
  async (job) => {
    const { campaignId, workspaceId, leadIds } = job.data as {
      campaignId: string
      workspaceId: string
      leadIds?: string[]
    }
    log('send-campaign', `Sending campaign=${campaignId} workspace=${workspaceId}`)
    const result = await sendCampaignBatch(campaignId, workspaceId, leadIds, (n) => job.updateProgress(n))
    log('send-campaign', `Done campaign=${campaignId} sent=${result.sent} skipped=${result.skipped} failed=${result.failed}`)
    return result
  },
  { connection, concurrency: 2 }
)

// ── calibrate-scoring ─────────────────────────────────────────────────────────
const calibrateWorker = new Worker(
  'calibrate-scoring',
  async (job) => {
    const { workspaceId } = job.data as { workspaceId: string }
    log('calibrate-scoring', `Calibrating workspace=${workspaceId}`)
    const stats = await calibrateScoring(workspaceId, (n) => job.updateProgress(n))
    if (!stats.calibrated) {
      log('calibrate-scoring', `Skipped: ${stats.reason} (${stats.totalOutcomes} outcomes)`)
    } else {
      log('calibrate-scoring', `Done workspace=${workspaceId} winRate=${Math.round(stats.baselineWinRate * 100)}%`)
    }
    return stats
  },
  { connection, concurrency: 1 }
)

// ── Error handlers ─────────────────────────────────────────────────────────────
for (const [name, worker] of [
  ['research-lead',           researchWorker],
  ['generate-outreach',       outreachWorker],
  ['analyze-reply',           replyWorker],
  ['sync-mailbox',            mailboxWorker],
  ['score-prospects',         scoreProspectsWorker],
  ['generate-recommendations',recommendWorker],
  ['calibrate-scoring',       calibrateWorker],
  ['send-campaign',           sendCampaignWorker],
] as [string, Worker][]) {
  worker.on('failed', (job, err) => {
    log(name, `Job ${job?.id} failed (attempt ${job?.attemptsMade}): ${err.message}`)
  })
  worker.on('error', (err) => {
    log(name, `Worker error: ${err.message}`)
  })
}

// ── Repeatable IMAP auto-sync (every 10 min) ──────────────────────────────────
// upsertJobScheduler is idempotent — safe to call on every worker restart.
{
  const syncQueue = new Queue('sync-mailbox', { connection })
  syncQueue.upsertJobScheduler(
    'auto-imap-sync',
    { every: 10 * 60 * 1000 },
    { name: 'auto-imap-sync', data: { autoSync: true }, opts: { attempts: 1, removeOnComplete: { count: 5 } } }
  ).catch(err => console.warn('[worker] Failed to schedule IMAP auto-sync:', err.message))
}

// ── Liveness probe ──────────────────────────────────────────────────────────────
const healthServer = startHealthServer(Number(process.env.WORKER_HEALTH_PORT || 9090))

// ── Graceful shutdown ──────────────────────────────────────────────────────────
async function shutdown(signal: string) {
  healthServer.close()
  console.log(`[worker] ${signal} received — shutting down`)
  await Promise.all([
    researchWorker.close(),
    outreachWorker.close(),
    replyWorker.close(),
    mailboxWorker.close(),
    scoreProspectsWorker.close(),
    recommendWorker.close(),
    calibrateWorker.close(),
    sendCampaignWorker.close(),
  ])
  await prisma.$disconnect()
  console.log('[worker] Shutdown complete')
  process.exit(0)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT',  () => shutdown('SIGINT'))

console.log('[worker] Started — listening on 8 queues (research-lead, generate-outreach, analyze-reply, sync-mailbox, score-prospects, generate-recommendations, calibrate-scoring, send-campaign)')
