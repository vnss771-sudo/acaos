import 'dotenv/config'
import { Worker, Queue } from 'bullmq'
import { connection, getQueue } from './lib/queue.js'
import { startHealthServer } from './health.js'
import { incJob, observeJobDuration, type QueueDepth } from './lib/metrics.js'
import { generateLeadResearch, generateOutreach, analyzeReply } from '@acaos/backend-core/services/openai.js'
import {
  parseAiJson,
  parseLeadResearchJson,
  OutreachDraftOutputSchema,
  ReplyAnalysisOutputSchema,
} from '@acaos/backend-core/lib/aiSchemas.js'
import {
  parseJobPayload,
  ResearchLeadPayloadSchema,
  GenerateOutreachPayloadSchema,
  AnalyzeReplyPayloadSchema,
  SyncMailboxPayloadSchema,
  ScoreProspectsPayloadSchema,
  GenerateRecommendationsPayloadSchema,
  CalibrateScoringPayloadSchema,
  SendCampaignPayloadSchema,
  RetentionPurgePayloadSchema,
} from '@acaos/backend-core/lib/queueSchemas.js'
import { purgeExpiredData } from '@acaos/backend-core/lib/retention.js'
import { prisma } from '@acaos/backend-core/lib/prisma.js'
import { computeLeadScore, DEFAULT_SCORING_WEIGHTS } from '@acaos/backend-core/lib/scoring.js'
import type { ScoringWeights } from '@acaos/backend-core/lib/scoring.js'
import {
  generateRuleBasedRecommendation,
  toRawSignal,
} from '@acaos/backend-core/lib/signalEngine.js'
import { scoreProspects, calibrateScoring, sendCampaignBatch } from './processors.js'
import { enqueueGenerateRecommendations } from '@acaos/backend-core/lib/queues.js'
import { evidenceGatedPriority } from '@acaos/backend-core/lib/recommendationPolicy.js'
import { createOutreachIntentForRecommendation } from '@acaos/backend-core/lib/outreachIntent.js'
import { captureError } from '@acaos/backend-core/lib/observability.js'
import { getRuntimeMetadata } from '@acaos/backend-core/lib/release.js'
import { logLifecycleEvent } from '@acaos/backend-core/lib/lifecycle.js'
import { logger } from '@acaos/backend-core/lib/logger.js'
import { initErrorReporting } from '@acaos/backend-core/lib/errorReporting.js'
import { attachBreakerStore } from '@acaos/backend-core/lib/circuit.js'
import { createRedisBreakerStore } from '@acaos/backend-core/lib/breakerStore.js'
import { isFinalAttempt } from './lib/failureReporting.js'
import type { LeadStage } from '@acaos/shared'

const SERVICE = 'acaos-worker'
const metadata = getRuntimeMetadata(SERVICE)
let shuttingDown = false

function log(queue: string, msg: string) {
  logger.info(msg, { queue, service: SERVICE, releaseId: metadata.releaseId })
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
    const { leadId } = parseJobPayload(ResearchLeadPayloadSchema, 'research-lead', job.data)
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

    // Lenient: research is best-effort enrichment, so a malformed field is
    // dropped (not fatal) and the scorer falls back to its computed score.
    const parsed = parseLeadResearchJson(raw)

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
    const { leadId } = parseJobPayload(GenerateOutreachPayloadSchema, 'generate-outreach', job.data)
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

    // Strict: a draft missing subject/email is unusable. Fail closed — throwing
    // here marks the job failed so BullMQ retries rather than persisting garbage.
    const parsed = parseAiJson(OutreachDraftOutputSchema, raw, 'generate-outreach')

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
    const { replyBody, leadId } = parseJobPayload(AnalyzeReplyPayloadSchema, 'analyze-reply', job.data)
    log('analyze-reply', `Processing${leadId ? ` leadId=${leadId}` : ''}`)

    await job.updateProgress(10)
    const raw = await analyzeReply(replyBody)
    await job.updateProgress(70)

    // Strict: classification drives CRM stage + scoring, so an unknown value must
    // fail closed (throw → retry) rather than silently mis-route a lead.
    const parsed = parseAiJson(ReplyAnalysisOutputSchema, raw, 'analyze-reply')

    if (leadId) {
      // Read the lead first: the job payload is the only source of `leadId`, so
      // confirm the row exists (and capture its workspace) before any write, and
      // scope the stage update by workspaceId so a forged/mis-routed job can't
      // flip a lead in another tenant.
      const lead = await prisma.lead.findUnique({
        where: { id: leadId },
        select: { workspaceId: true, score: true }
      })

      if (lead && !parsed.isAutoReply) {
        const stageMap: Record<string, LeadStage> = {
          INTERESTED: 'REPLIED',
          NOT_INTERESTED: 'DEAD',
          NEEDS_MORE_INFO: 'REPLIED',
          NOT_NOW: 'REPLIED',
          REFERRAL: 'REPLIED',
          OUT_OF_OFFICE: 'OUTREACH_SENT'
        }
        const newStage = stageMap[parsed.classification]
        if (newStage) {
          await prisma.lead.updateMany({ where: { id: leadId, workspaceId: lead.workspaceId }, data: { stage: newStage } })
        }

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

        const replied = !['NOT_INTERESTED', 'OUT_OF_OFFICE'].includes(parsed.classification)

        await prisma.scoringOutcome.create({
          data: {
            workspaceId: lead.workspaceId,
            leadId,
            // Lead-sourced outcome — there is no Prospect. (Previously this
            // wrote the Lead id into prospectId, corrupting the column.)
            prospectId: null,
            score: lead.score,
            replied,
            replyIntent: replyIntentMap[parsed.classification] ?? null,
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
    const { workspaceId, autoSync } = parseJobPayload(SyncMailboxPayloadSchema, 'sync-mailbox', job.data)
    const { syncMailboxOnce, isMailboxConfigured } = await import('@acaos/backend-core/services/mail.js')

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
    const { workspaceId } = parseJobPayload(ScoreProspectsPayloadSchema, 'score-prospects', job.data)
    log('score-prospects', `Rescoring prospects for workspaceId=${workspaceId}`)
    const result = await scoreProspects(workspaceId, (n) => job.updateProgress(n))
    log('score-prospects', `Done: ${result.updated} prospects rescored`)
    // Auto-advance the spine: prospects that cleared the threshold get a
    // recommendation generated. The generate-recommendations worker dedupes, so
    // repeated rescoring won't spam recommendations.
    for (const prospectId of result.toRecommend) {
      await enqueueGenerateRecommendations(prospectId, workspaceId).catch((e) =>
        log('score-prospects', `enqueue recommendation failed for ${prospectId}: ${(e as Error).message}`))
    }
    return result
  },
  { connection, concurrency: 1 }
)

// ── generate-recommendations ──────────────────────────────────────────────────
const recommendWorker = new Worker(
  'generate-recommendations',
  async (job) => {
    const { prospectId, workspaceId } = parseJobPayload(GenerateRecommendationsPayloadSchema, 'generate-recommendations', job.data)
    log('generate-recommendations', `Generating for prospectId=${prospectId}`)

    // Scope by the payload workspaceId so a mis-routed job can't read a prospect
    // from — and cross-attach a recommendation/intent to — another tenant.
    const prospect = await prisma.prospect.findFirst({
      where: { id: prospectId, workspaceId },
      include: { signals: true }
    })
    if (!prospect) throw new Error(`Prospect ${prospectId} not found`)

    // Dedupe: skip if there's a recent, un-acted recommendation. Lets scoring
    // safely enqueue on every rescore without spamming the radar.
    const recent = await prisma.recommendation.findFirst({
      where: { prospectId, actedAt: null, createdAt: { gte: new Date(Date.now() - 7 * 86_400_000) } },
      select: { id: true },
    })
    if (recent) {
      log('generate-recommendations', `Skip prospectId=${prospectId}: recent recommendation exists`)
      return { prospectId, skipped: true }
    }

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

    // Evidence-first gate: a "high confidence / contact now" priority requires
    // provable, fresh evidence; otherwise cap it below the high-confidence line.
    const priority = evidenceGatedPriority(rec.priority, prospect.signals)

    const recommendation = await prisma.recommendation.create({
      data: {
        workspaceId,
        prospectId,
        ...rec,
        priority,
        expiresAt: new Date(Date.now() + 7 * 86_400_000)
      }
    })

    // Bridge (Stage 2): create the OutreachIntent that will carry this through
    // draft → approval → send. Best-effort — never break recommendation creation.
    await createOutreachIntentForRecommendation({
      workspaceId,
      prospectId,
      recommendationId: recommendation.id,
      messageAngle: rec.messageAngle,
      channel: rec.bestChannel,
      signals: prospect.signals,
      missionId: prospect.missionId,
    }).catch((e) => log('generate-recommendations', `intent create failed for ${prospectId}: ${(e as Error).message}`))

    await job.updateProgress(100)
    log('generate-recommendations', `Done prospectId=${prospectId} channel=${rec.bestChannel} priority=${priority}`)
    return { prospectId, ...rec, priority }
  },
  { connection, concurrency: 3 }
)

// ── send-campaign ─────────────────────────────────────────────────────────────
const sendCampaignWorker = new Worker(
  'send-campaign',
  async (job) => {
    const { campaignId, workspaceId, leadIds } = parseJobPayload(SendCampaignPayloadSchema, 'send-campaign', job.data)
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
    const { workspaceId } = parseJobPayload(CalibrateScoringPayloadSchema, 'calibrate-scoring', job.data)
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

// ── retention-purge ───────────────────────────────────────────────────────────
// Enforces the documented data-retention windows (docs/DATA_RETENTION.md) by
// deleting rows past their window. Platform-wide, idempotent, runs daily.
const retentionWorker = new Worker(
  'retention-purge',
  async (job) => {
    parseJobPayload(RetentionPurgePayloadSchema, 'retention-purge', job.data)
    log('retention-purge', 'Starting retention sweep')
    const deleted = await purgeExpiredData()
    const total = Object.values(deleted).reduce((a, b) => a + b, 0)
    log('retention-purge', `Done — purged ${total} row(s): ${JSON.stringify(deleted)}`)
    return deleted
  },
  { connection, concurrency: 1 }
)

// ── Error handlers + job metrics ───────────────────────────────────────────────
const WORKER_QUEUES: [string, Worker][] = [
  ['research-lead',           researchWorker],
  ['generate-outreach',       outreachWorker],
  ['analyze-reply',           replyWorker],
  ['sync-mailbox',            mailboxWorker],
  ['score-prospects',         scoreProspectsWorker],
  ['generate-recommendations',recommendWorker],
  ['calibrate-scoring',       calibrateWorker],
  ['send-campaign',           sendCampaignWorker],
  ['retention-purge',         retentionWorker],
]
for (const [name, worker] of WORKER_QUEUES) {
  worker.on('completed', (job) => {
    incJob(name, 'completed')
    if (job?.processedOn && job?.finishedOn) observeJobDuration(name, (job.finishedOn - job.processedOn) / 1000)
  })
  worker.on('failed', (job, err) => {
    log(name, `Job ${job?.id} failed (attempt ${job?.attemptsMade}): ${err.message}`)
    // Only count/report once the job has exhausted its retries — transient
    // failures that BullMQ will retry are noise, not faults.
    if (isFinalAttempt(job)) {
      incJob(name, 'failed')
      captureError(err, { source: 'worker.failed', queue: name, jobId: job?.id, attempts: job?.attemptsMade })
    }
  })
  worker.on('error', (err) => {
    log(name, `Worker error: ${err.message}`)
    captureError(err, { source: 'worker.error', queue: name })
  })
}

// Live queue-depth gauges for /metrics — counts pulled on scrape via BullMQ.
const DEPTH_STATES = ['waiting', 'active', 'completed', 'failed', 'delayed', 'paused'] as const
async function collectQueueDepths(): Promise<QueueDepth[]> {
  return Promise.all(WORKER_QUEUES.map(async ([name]) => ({
    queue: name,
    counts: await getQueue(name).getJobCounts(...DEPTH_STATES),
  })))
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

// ── Repeatable data-retention purge (daily) ───────────────────────────────────
// Interval overridable via RETENTION_PURGE_INTERVAL_MS (default 24h).
{
  const purgeQueue = new Queue('retention-purge', { connection })
  const every = Number(process.env.RETENTION_PURGE_INTERVAL_MS || 24 * 60 * 60 * 1000)
  purgeQueue.upsertJobScheduler(
    'daily-retention-purge',
    { every },
    { name: 'daily-retention-purge', data: {}, opts: { attempts: 1, removeOnComplete: { count: 7 } } }
  ).catch(err => console.warn('[worker] Failed to schedule retention purge:', err.message))
}

// Wire the error-capture seam to Sentry when SENTRY_DSN is set (no-op otherwise),
// so background-job failures (worker.ts handlers) reach the same transport as API errors.
void initErrorReporting()

// Share circuit-breaker state with the API via Redis (reusing the BullMQ
// connection) so a provider outage the worker trips also protects the API.
// Fail-open: falls back to per-process state if Redis is unavailable.
attachBreakerStore(createRedisBreakerStore(connection))

// ── Liveness probe + metrics ─────────────────────────────────────────────────────
// Bind to the platform-injected PORT when present (so Railway's healthcheck, which
// probes $PORT, can reach /live and restart a wedged worker) and fall back to the
// fixed 9090 locally/in Docker. WORKER_HEALTH_PORT overrides both.
const healthServer = startHealthServer(
  Number(process.env.WORKER_HEALTH_PORT || process.env.PORT || 9090),
  {
    collectQueueDepths,
    isReady: () => !shuttingDown && connection.status === 'ready',
  },
)

// ── Graceful shutdown ──────────────────────────────────────────────────────────
async function shutdown(signal: string) {
  if (shuttingDown) return
  shuttingDown = true
  logLifecycleEvent(SERVICE, 'shutdown', { signal, phase: 'begin' })
  healthServer.close()

  await Promise.all([
    researchWorker.close(),
    outreachWorker.close(),
    replyWorker.close(),
    mailboxWorker.close(),
    scoreProspectsWorker.close(),
    recommendWorker.close(),
    calibrateWorker.close(),
    sendCampaignWorker.close(),
    retentionWorker.close(),
  ])
  await prisma.$disconnect()
  logLifecycleEvent(SERVICE, 'shutdown', { signal, phase: 'complete' })
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT',  () => void shutdown('SIGINT'))

process.on('unhandledRejection', (reason) => {
  logLifecycleEvent(SERVICE, 'crash', { source: 'worker.unhandledRejection', reason: reason instanceof Error ? reason.message : String(reason) })
  captureError(reason, { source: 'worker.unhandledRejection' })
})
process.on('uncaughtException', (err) => {
  logLifecycleEvent(SERVICE, 'crash', { source: 'worker.uncaughtException', err: err.message })
  captureError(err, { source: 'worker.uncaughtException' })
})

logLifecycleEvent(SERVICE, 'deploy', { queueCount: WORKER_QUEUES.length })
logLifecycleEvent(SERVICE, 'startup', { queueCount: WORKER_QUEUES.length, releaseId: metadata.releaseId })
