import 'dotenv/config'
import { Worker, Queue } from 'bullmq'
import { connection, getQueue } from './lib/queue.js'
import { startHealthServer } from './health.js'
import { incJob, observeJobDuration, type QueueDepth, type DomainSnapshot } from './lib/metrics.js'
import { evaluateSenderReputation } from '@acaos/backend-core/lib/senderReputation.js'
import { warmupDailyCap } from '@acaos/backend-core/lib/warmup.js'
import { createCachedValue } from '@acaos/backend-core/lib/cachedValue.js'
import { createRejectionTracker } from '@acaos/backend-core/lib/rejectionTracker.js'
import { analyzeReply } from '@acaos/backend-core/services/openai.js'
import { closeMailTransports } from '@acaos/backend-core/services/mail.js'
import {
  parseAiJson,
  ReplyAnalysisOutputSchema,
} from '@acaos/backend-core/lib/aiSchemas.js'
import { assertAiUsageAllowed } from '@acaos/backend-core/lib/limits.js'
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
  DiscoverProspectsPayloadSchema,
  RetentionPurgePayloadSchema,
  SendFollowupPayloadSchema,
  DlqAutoRetryPayloadSchema,
  DomainHealthPayloadSchema,
} from '@acaos/backend-core/lib/queueSchemas.js'
import { purgeExpiredData } from '@acaos/backend-core/lib/retention.js'
import { runDomainHealthSweep, isDomainHealthEnabled, domainHealthIntervalMs } from '@acaos/backend-core/lib/domainHealth.js'
import { recoverStaleSends } from '@acaos/backend-core/lib/staleSends.js'
import { reconcileEnabled, reconcileCampaignStats } from '@acaos/backend-core/lib/reconciliation.js'
import { isFeatureEnabled, areFollowupsEnabled } from '@acaos/backend-core/lib/launchControls.js'
import { prisma } from '@acaos/backend-core/lib/prisma.js'
import {
  generateRuleBasedRecommendation,
  toRawSignal,
} from '@acaos/backend-core/lib/signalEngine.js'
import { scoreProspects, calibrateScoring, sendCampaignBatch, applyReplyAnalysis, discoverProspectsBatch, sendFollowupTask, researchLead, generateOutreachDraft } from './processors.js'
import { runInWorkspaceContext } from '@acaos/backend-core/lib/tenantContext.js'
import { enqueueGenerateRecommendations, enqueueDueFollowups } from '@acaos/backend-core/lib/queues.js'
import { evidenceGatedPriority } from '@acaos/backend-core/lib/recommendationPolicy.js'
import { createOutreachIntentForRecommendation } from '@acaos/backend-core/lib/outreachIntent.js'
import { captureError } from '@acaos/backend-core/lib/observability.js'
import { initTracing, withConsumerSpan } from '@acaos/backend-core/lib/tracing.js'
import { getRuntimeMetadata } from '@acaos/backend-core/lib/release.js'
import { logLifecycleEvent } from '@acaos/backend-core/lib/lifecycle.js'
import { logger } from '@acaos/backend-core/lib/logger.js'
import { initErrorReporting } from '@acaos/backend-core/lib/errorReporting.js'
import { checkEncryptionKeyHealth, checkEmailEncryptionKeyConfigured } from '@acaos/backend-core/lib/encrypt.js'
import { attachBreakerStore } from '@acaos/backend-core/lib/circuit.js'
import { createRedisBreakerStore } from '@acaos/backend-core/lib/breakerStore.js'
import { attachProviderQuotaStore } from '@acaos/backend-core/lib/providerQuota.js'
import { isFinalAttempt } from './lib/failureReporting.js'
import {
  createAdaptiveScaler,
  isAdaptiveConcurrencyEnabled,
  adaptivePollIntervalMs,
  loadAdaptiveConfigFromEnv,
  type AdaptiveScaler,
} from './lib/adaptiveConcurrency.js'
import {
  runAutoRetrySweep,
  isDlqAutoRetryEnabled,
  loadAutoRetryPolicyFromEnv,
  dlqAutoRetryIntervalMs,
  buildAutoRetryTargets,
} from './lib/dlqAutoRetry.js'

const SERVICE = 'acaos-worker'
const metadata = getRuntimeMetadata(SERVICE)
let shuttingDown = false

function log(queue: string, msg: string, requestId?: string) {
  logger.info(msg, { queue, service: SERVICE, releaseId: metadata.releaseId, ...(requestId ? { requestId } : {}) })
}

// ── research-lead ─────────────────────────────────────────────────────────────
const researchWorker = new Worker(
  'research-lead',
  async (job) => withConsumerSpan('research-lead', job.name, job.data?.traceparent, { 'acaos.request_id': job.data?.requestId, 'acaos.workspace_id': job.data?.workspaceId }, async () => {
    const { leadId, workspaceId } = parseJobPayload(ResearchLeadPayloadSchema, 'research-lead', job.data)
    if (!isFeatureEnabled('ai')) { log('research-lead', 'skipped: FEATURE_AI disabled'); return { skipped: true, reason: 'FEATURE_AI disabled' } }
    log('research-lead', `Processing leadId=${leadId}`)
    const result = await runInWorkspaceContext(workspaceId, () => researchLead(leadId, workspaceId, (n) => job.updateProgress(n)))
    log('research-lead', `Done leadId=${leadId} stage=RESEARCHED score=${result.score} why=${result.scoreReasons.join('; ') || 'n/a'}`)
    return result
  }),
  { connection, concurrency: 3 }
)

// ── generate-outreach ─────────────────────────────────────────────────────────
const outreachWorker = new Worker(
  'generate-outreach',
  async (job) => withConsumerSpan('generate-outreach', job.name, job.data?.traceparent, { 'acaos.request_id': job.data?.requestId, 'acaos.workspace_id': job.data?.workspaceId }, async () => {
    const { leadId, workspaceId, override } = parseJobPayload(GenerateOutreachPayloadSchema, 'generate-outreach', job.data)
    if (!isFeatureEnabled('ai')) { log('generate-outreach', 'skipped: FEATURE_AI disabled'); return { skipped: true, reason: 'FEATURE_AI disabled' } }
    log('generate-outreach', `Processing leadId=${leadId}`)
    const result = await runInWorkspaceContext(workspaceId, () => generateOutreachDraft(leadId, workspaceId, override, (n) => job.updateProgress(n)))
    if (result.skipped) {
      log('generate-outreach', `suppressed leadId=${leadId}: ${result.reason}`)
    } else {
      if (result.toneWarnings && result.toneWarnings.length > 0) {
        log('generate-outreach', `tone warnings leadId=${leadId}: ${result.toneWarnings.join(', ')}`)
      }
      log('generate-outreach', `Done leadId=${leadId}`)
    }
    return result
  }),
  { connection, concurrency: 3 }
)

// ── analyze-reply ─────────────────────────────────────────────────────────────
const replyWorker = new Worker(
  'analyze-reply',
  async (job) => withConsumerSpan('analyze-reply', job.name, job.data?.traceparent, { 'acaos.request_id': job.data?.requestId, 'acaos.workspace_id': job.data?.workspaceId }, async () => {
    const { replyBody, leadId, workspaceId } = parseJobPayload(AnalyzeReplyPayloadSchema, 'analyze-reply', job.data)
    if (!isFeatureEnabled('ai')) { log('analyze-reply', 'skipped: FEATURE_AI disabled'); return { skipped: true, reason: 'FEATURE_AI disabled' } }
    log('analyze-reply', `Processing${leadId ? ` leadId=${leadId}` : ''}`)

    await job.updateProgress(10)
    // Defense-in-depth re-check right before the model call — see the same
    // comment in the research-lead worker above. workspaceId is the one payload
    // field every enqueue site sets even though the schema allows it to be
    // absent; without it there's no tenant to check quota against.
    if (workspaceId) await assertAiUsageAllowed(workspaceId)
    const raw = await analyzeReply(replyBody)
    await job.updateProgress(70)

    // Strict: classification drives CRM stage + scoring, so an unknown value must
    // fail closed (throw → retry) rather than silently mis-route a lead.
    const parsed = parseAiJson(ReplyAnalysisOutputSchema, raw, 'analyze-reply')

    // Apply the parsed classification's DB effects (lead stage, reply metadata on
    // the send, scoring outcome). Extracted to processors.applyReplyAnalysis so the
    // logic is unit-tested against a real DB without OpenAI/BullMQ.
    if (leadId) await applyReplyAnalysis(leadId, parsed)

    await job.updateProgress(100)
    log('analyze-reply', `Done classification=${parsed.classification} isAutoReply=${parsed.isAutoReply}`)
    return parsed
  }),
  { connection, concurrency: 5 }
)

// ── sync-mailbox ──────────────────────────────────────────────────────────────
const mailboxWorker = new Worker(
  'sync-mailbox',
  async (job) => withConsumerSpan('sync-mailbox', job.name, job.data?.traceparent, { 'acaos.request_id': job.data?.requestId, 'acaos.workspace_id': job.data?.workspaceId }, async () => {
    const { workspaceId, autoSync } = parseJobPayload(SyncMailboxPayloadSchema, 'sync-mailbox', job.data)
    if (!isFeatureEnabled('mailboxSync')) { log('sync-mailbox', 'skipped: FEATURE_MAILBOX_SYNC disabled'); return { skipped: true, reason: 'FEATURE_MAILBOX_SYNC disabled' } }
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
    log('sync-mailbox', `Done workspaceId=${workspaceId} inspected=${result.inspected} matched=${result.matched} queued=${result.queued} bounced=${result.bounced} complained=${result.complained}`)
    return result
  }),
  { connection, concurrency: 1 }
)

// ── score-prospects ────────────────────────────────────────────────────────────
const scoreProspectsWorker = new Worker(
  'score-prospects',
  async (job) => withConsumerSpan('score-prospects', job.name, job.data?.traceparent, { 'acaos.request_id': job.data?.requestId, 'acaos.workspace_id': job.data?.workspaceId }, async () => {
    const { workspaceId } = parseJobPayload(ScoreProspectsPayloadSchema, 'score-prospects', job.data)
    log('score-prospects', `Rescoring prospects for workspaceId=${workspaceId}`)
    const result = await runInWorkspaceContext(workspaceId, () => scoreProspects(workspaceId, (n) => job.updateProgress(n)))
    log('score-prospects', `Done: ${result.updated} prospects rescored`)
    // Auto-advance the spine: prospects that cleared the threshold get a
    // recommendation generated. The generate-recommendations worker dedupes, so
    // repeated rescoring won't spam recommendations.
    for (const prospectId of result.toRecommend) {
      await enqueueGenerateRecommendations(prospectId, workspaceId).catch((e) =>
        log('score-prospects', `enqueue recommendation failed for ${prospectId}: ${(e as Error).message}`))
    }
    return result
  }),
  { connection, concurrency: 1 }
)

// ── discover-prospects ────────────────────────────────────────────────────────
// Off-request prospect discovery: the /discover route creates the RUNNING run +
// enqueues this; here we call the provider and import results, finalizing the run
// as SUCCEEDED / PARTIAL / FAILED. Gated by the same 'discovery' feature flag the
// route checks. Low concurrency — provider calls are metered and rate-limited.
const discoverWorker = new Worker(
  'discover-prospects',
  async (job) => withConsumerSpan('discover-prospects', job.name, job.data?.traceparent, { 'acaos.request_id': job.data?.requestId, 'acaos.workspace_id': job.data?.workspaceId }, async () => {
    const { runId, workspaceId } = parseJobPayload(DiscoverProspectsPayloadSchema, 'discover-prospects', job.data)
    if (!isFeatureEnabled('discovery')) { log('discover-prospects', 'skipped: FEATURE_DISCOVERY disabled'); return { skipped: true, reason: 'FEATURE_DISCOVERY disabled' } }
    log('discover-prospects', `Discovering run=${runId} workspace=${workspaceId}`)
    const result = await runInWorkspaceContext(workspaceId, () => discoverProspectsBatch(runId, workspaceId, (n) => job.updateProgress(n)))
    log('discover-prospects', `Done run=${runId} status=${result.status} imported=${result.imported} skipped=${result.skipped}`)
    return result
  }),
  { connection, concurrency: 2 }
)

// ── generate-recommendations ──────────────────────────────────────────────────
const recommendWorker = new Worker(
  'generate-recommendations',
  async (job) => withConsumerSpan('generate-recommendations', job.name, job.data?.traceparent, { 'acaos.request_id': job.data?.requestId, 'acaos.workspace_id': job.data?.workspaceId }, async () => {
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
  }),
  { connection, concurrency: 3 }
)

// ── send-campaign ─────────────────────────────────────────────────────────────
const sendCampaignWorker = new Worker(
  'send-campaign',
  async (job) => withConsumerSpan('send-campaign', job.name, job.data?.traceparent, { 'acaos.request_id': job.data?.requestId, 'acaos.workspace_id': job.data?.workspaceId }, async () => {
    const { campaignId, workspaceId, leadIds } = parseJobPayload(SendCampaignPayloadSchema, 'send-campaign', job.data)
    if (!isFeatureEnabled('send')) { log('send-campaign', 'skipped: FEATURE_SEND disabled'); return { skipped: true, reason: 'FEATURE_SEND disabled', sent: 0, skipped_count: leadIds?.length ?? 0 } }
    log('send-campaign', `Sending campaign=${campaignId} workspace=${workspaceId}`)
    const result = await runInWorkspaceContext(workspaceId, () => sendCampaignBatch(campaignId, workspaceId, leadIds, (n) => job.updateProgress(n)))
    // Compact skip breakdown (non-zero reasons only) so the operator log answers
    // "why didn't these send?" at a glance.
    const reasons = Object.entries(result.skippedByReason).filter(([, n]) => n > 0).map(([r, n]) => `${r}=${n}`).join(' ')
    log('send-campaign', `Done campaign=${campaignId} sent=${result.sent} skipped=${result.skipped} failed=${result.failed}${reasons ? ` [${reasons}]` : ''}`)
    return result
  }),
  { connection, concurrency: 2 }
)

// ── send-followup ─────────────────────────────────────────────────────────────
// Automatic multi-step follow-up sender. DOUBLE-gated and DORMANT by default: the
// global FEATURE_SEND kill-switch AND the opt-IN FOLLOWUPS_ENABLED flag must both
// be on, on top of each campaign's autoFollowupsEnabled (re-checked inside
// sendFollowupTask). With FOLLOWUPS_ENABLED off (the default) both the periodic
// scan and any per-task job short-circuit to a no-op, so the worker is wired and
// visible in metrics but sends nothing until an operator explicitly turns it on.
// Two job shapes share this queue: `{ scan: true }` (the scheduler-driven sweep
// that enqueues per-task children) and `{ taskId }` (dispatch one due step).
const sendFollowupWorker = new Worker(
  'send-followup',
  async (job) => withConsumerSpan('send-followup', job.name, job.data?.traceparent, { 'acaos.request_id': job.data?.requestId, 'acaos.workspace_id': job.data?.workspaceId }, async () => {
    const { taskId, scan } = parseJobPayload(SendFollowupPayloadSchema, 'send-followup', job.data)
    if (!isFeatureEnabled('send')) { log('send-followup', 'skipped: FEATURE_SEND disabled'); return { skipped: true, reason: 'FEATURE_SEND disabled' } }
    if (!areFollowupsEnabled()) { log('send-followup', 'skipped: FOLLOWUPS_ENABLED off'); return { skipped: true, reason: 'FOLLOWUPS_ENABLED off' } }
    if (scan) {
      const enqueued = await enqueueDueFollowups()
      if (enqueued > 0) log('send-followup', `Scan enqueued ${enqueued} due follow-up(s)`)
      return { scan: true, enqueued }
    }
    log('send-followup', `Dispatching task=${taskId}`)
    const result = await sendFollowupTask(taskId!)
    log('send-followup', `Done task=${taskId} status=${result.status}${result.reason ? ` reason=${result.reason}` : ''}`)
    return result
  }),
  { connection, concurrency: 2 }
)

// ── calibrate-scoring ─────────────────────────────────────────────────────────
const calibrateWorker = new Worker(
  'calibrate-scoring',
  async (job) => withConsumerSpan('calibrate-scoring', job.name, job.data?.traceparent, { 'acaos.request_id': job.data?.requestId, 'acaos.workspace_id': job.data?.workspaceId }, async () => {
    const { workspaceId } = parseJobPayload(CalibrateScoringPayloadSchema, 'calibrate-scoring', job.data)
    log('calibrate-scoring', `Calibrating workspace=${workspaceId}`)
    const stats = await runInWorkspaceContext(workspaceId, () => calibrateScoring(workspaceId, (n) => job.updateProgress(n)))
    if (!stats.calibrated) {
      log('calibrate-scoring', `Skipped: ${stats.reason} (${stats.totalOutcomes} outcomes)`)
    } else {
      log('calibrate-scoring', `Done workspace=${workspaceId} winRate=${Math.round(stats.baselineWinRate * 100)}%`)
    }
    return stats
  }),
  { connection, concurrency: 1 }
)

// ── retention-purge ───────────────────────────────────────────────────────────
// Enforces the documented data-retention windows (docs/DATA_RETENTION.md) by
// deleting rows past their window. Platform-wide, idempotent, runs daily.
const retentionWorker = new Worker(
  'retention-purge',
  async (job) => withConsumerSpan('retention-purge', job.name, job.data?.traceparent, {}, async () => {
    parseJobPayload(RetentionPurgePayloadSchema, 'retention-purge', job.data)
    log('retention-purge', 'Starting retention sweep')
    const deleted = await purgeExpiredData()
    const total = Object.values(deleted).reduce((a, b) => a + b, 0)
    // Reclaim outbox rows stranded in SENDING by a crashed dispatch — they otherwise
    // count against the send cap forever. Fail-closed (→ FAILED, never re-sent).
    const staleRecovered = await recoverStaleSends().catch((e) => {
      log('retention-purge', `stale-send recovery failed: ${(e as Error).message}`); return 0
    })
    // Opt-in ledger↔projection reconciliation: detect CampaignDailyStats drift from
    // the ContactEvent ledger and rebuild any drifted workspace. Default-off.
    const reconcile = reconcileEnabled()
      ? await reconcileCampaignStats({ rebuild: true }).catch((e) => {
          log('retention-purge', `stats reconcile failed: ${(e as Error).message}`); return null
        })
      : null
    if (reconcile) log('retention-purge', `stats reconcile: checked=${reconcile.campaignsChecked} drift=${reconcile.drifted.length} rebuilt=${reconcile.workspacesRebuilt}`)
    log('retention-purge', `Done — purged ${total} row(s): ${JSON.stringify(deleted)}; stale SENDING reclaimed: ${staleRecovered}`)
    return { ...deleted, staleSendsRecovered: staleRecovered, statsReconciled: reconcile?.workspacesRebuilt ?? 0 }
  }),
  { connection, concurrency: 1 }
)

// ── dlq-auto-retry ────────────────────────────────────────────────────────────
// Periodic sweep (see lib/dlqAutoRetry.ts): gives a few bonus retries to failed
// jobs — across every other queue — whose error looks transient and haven't
// already exhausted a small bonus-retry budget or gone stale. The manual,
// operator-invoked counterpart is scripts/queue-drain.mjs. Default ON
// (DLQ_AUTO_RETRY_ENABLED) — an operator can opt out if it ever misbehaves.
// WORKER_QUEUES is defined below this worker but the closure only reads it once
// a job actually runs, well after the module has finished initializing.
const dlqAutoRetryWorker = new Worker(
  'dlq-auto-retry',
  async (job) => {
    parseJobPayload(DlqAutoRetryPayloadSchema, 'dlq-auto-retry', job.data)
    if (!isDlqAutoRetryEnabled()) { log('dlq-auto-retry', 'skipped: DLQ_AUTO_RETRY_ENABLED off'); return { skipped: true } }
    const policy = loadAutoRetryPolicyFromEnv()
    const targets = buildAutoRetryTargets(WORKER_QUEUES.map(([name]) => name))
    const results = await runAutoRetrySweep(targets, getQueue, policy)
    const totalScanned = results.reduce((a, r) => a + r.scanned, 0)
    const totalRetried = results.reduce((a, r) => a + r.retried, 0)
    if (totalRetried > 0) {
      const perQueue = results.filter((r) => r.retried > 0).map((r) => `${r.queue}=${r.retried}`).join(' ')
      log('dlq-auto-retry', `Auto-retried ${totalRetried}/${totalScanned} scanned failed job(s) [${perQueue}]`)
    }
    return { scanned: totalScanned, retried: totalRetried, results }
  },
  { connection, concurrency: 1 }
)

// ── domain-health ─────────────────────────────────────────────────────────────
// Daily sweep (see backend-core lib/domainHealth.ts): re-checks every workspace's
// sending domain for SPF/DKIM/DMARC and blocklist listings, stores the latest
// report, and alerts the workspace when a new problem appears. Default ON
// (DOMAIN_HEALTH_ENABLED) — it only makes DNS lookups.
const domainHealthWorker = new Worker(
  'domain-health',
  async (job) => withConsumerSpan('domain-health', job.name, job.data?.traceparent, {}, async () => {
    parseJobPayload(DomainHealthPayloadSchema, 'domain-health', job.data)
    if (!isDomainHealthEnabled()) { log('domain-health', 'skipped: DOMAIN_HEALTH_ENABLED off'); return { skipped: true } }
    const r = await runDomainHealthSweep()
    log('domain-health', `Checked ${r.domains} domain(s) for ${r.workspaces} workspace(s): ${r.degraded} degraded, ${r.unknown} undetermined`)
    return r
  }),
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
  ['send-followup',           sendFollowupWorker],
  ['discover-prospects',      discoverWorker],
  ['retention-purge',         retentionWorker],
  ['dlq-auto-retry',          dlqAutoRetryWorker],
  ['domain-health',           domainHealthWorker],
]
for (const [name, worker] of WORKER_QUEUES) {
  worker.on('completed', (job) => {
    incJob(name, 'completed')
    if (job?.processedOn && job?.finishedOn) observeJobDuration(name, (job.finishedOn - job.processedOn) / 1000)
  })
  worker.on('failed', (job, err) => {
    // Correlate the failure back to the originating API request when the enqueuer
    // threaded a requestId through the payload (optional — worker-internal jobs omit it).
    const requestId = typeof job?.data?.requestId === 'string' ? job.data.requestId : undefined
    log(name, `Job ${job?.id} failed (attempt ${job?.attemptsMade}): ${err.message}`, requestId)
    // Only count/report once the job has exhausted its retries — transient
    // failures that BullMQ will retry are noise, not faults.
    if (isFinalAttempt(job)) {
      incJob(name, 'failed')
      captureError(err, { source: 'worker.failed', queue: name, jobId: job?.id, attempts: job?.attemptsMade, requestId })
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

// Scrape-time deliverability snapshot for /metrics: follow-up backlog, reputation
// (bounded), and warmup state. Each piece is independently best-effort — a failure
// yields an empty field, never a failed scrape. Queries are indexed and bounded.
const REPUTATION_SCRAPE_LIMIT = 50
async function collectDomainMetrics(): Promise<DomainSnapshot> {
  const snapshot: DomainSnapshot = {}

  // Follow-up backlog by status + due-but-unsent (one groupBy + one count, indexed).
  try {
    const grouped = await prisma.followupTask.groupBy({ by: ['status'], _count: { _all: true } })
    snapshot.followupTasks = Object.fromEntries(grouped.map((g: { status: string; _count: { _all: number } }) => [g.status as string, g._count._all]))
    snapshot.followupDueUnsent = await prisma.followupTask.count({ where: { status: 'SCHEDULED', scheduledFor: { lte: new Date() } } })
  } catch { /* leave absent */ }

  // Reputation: evaluate only workspaces that sent in the window (bounded set, capped).
  try {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    const active = await prisma.contactEvent.groupBy({
      by: ['workspaceId'], where: { type: 'SENT', occurredAt: { gte: since } }, _count: { _all: true },
      orderBy: { _count: { workspaceId: 'desc' } }, take: REPUTATION_SCRAPE_LIMIT,
    })
    const perWorkspace: NonNullable<DomainSnapshot['reputation']>['perWorkspace'] = []
    let unhealthy = 0
    for (const a of active) {
      const v = await evaluateSenderReputation(a.workspaceId).catch(() => null)
      if (!v) continue
      if (!v.healthy) unhealthy++
      perWorkspace.push({ workspaceId: a.workspaceId, bounceRate: v.bounceRate, complaintRate: v.complaintRate, healthy: v.healthy })
    }
    snapshot.reputation = { evaluated: perWorkspace.length, unhealthy, perWorkspace }
  } catch { /* leave absent */ }

  // Warmup: only opt-in workspaces (warmupStartedAt set) — naturally bounded.
  try {
    const warming = await prisma.workspaceICP.findMany({ where: { warmupStartedAt: { not: null } }, select: { workspaceId: true, warmupStartedAt: true } })
    const now = new Date()
    snapshot.warmup = warming.map((w: { workspaceId: string; warmupStartedAt: Date | null }) => {
      const cap = warmupDailyCap(w.warmupStartedAt!, now)
      const dayIndex = Math.floor((now.getTime() - w.warmupStartedAt!.getTime()) / 86_400_000)
      return { workspaceId: w.workspaceId, day: cap == null ? 0 : dayIndex + 1, cap: cap ?? 0 }
    })
  } catch { /* leave absent */ }

  return snapshot
}

// The domain snapshot is DB-heavy (up to REPUTATION_SCRAPE_LIMIT reputation
// evaluations). Cache it on a short TTL so the cost is bounded by time, not by how
// often Prometheus scrapes — and coalesce racing scrapes onto one computation.
// METRICS_DOMAIN_CACHE_MS tunes the window (default 30s); the gauges it feeds
// (followup backlog, reputation, warmup) tolerate that much staleness.
const domainMetricsCache = createCachedValue(
  collectDomainMetrics,
  Number(process.env.METRICS_DOMAIN_CACHE_MS || 30_000),
)

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

// ── Repeatable DLQ auto-retry sweep (every 5 min by default) ─────────────────
// Interval overridable via DLQ_AUTO_RETRY_INTERVAL_MS. Always registered
// (idempotent), same as retention-purge/follow-up-scan above — the processor
// itself checks DLQ_AUTO_RETRY_ENABLED and no-ops when an operator turns it off.
{
  const dlqQueue = new Queue('dlq-auto-retry', { connection })
  const every = dlqAutoRetryIntervalMs()
  dlqQueue.upsertJobScheduler(
    'dlq-auto-retry-sweep',
    { every },
    { name: 'dlq-auto-retry-sweep', data: {}, opts: { attempts: 1, removeOnComplete: { count: 10 }, removeOnFail: { count: 20 } } }
  ).catch(err => console.warn('[worker] Failed to schedule DLQ auto-retry sweep:', err.message))
}

// ── Repeatable domain-health sweep (daily by default) ─────────────────────────
// Interval overridable via DOMAIN_HEALTH_INTERVAL_MS. Always registered
// (idempotent); the processor no-ops when DOMAIN_HEALTH_ENABLED is false.
{
  const domainHealthQueue = new Queue('domain-health', { connection })
  domainHealthQueue.upsertJobScheduler(
    'domain-health-sweep',
    { every: domainHealthIntervalMs() },
    { name: 'domain-health-sweep', data: {}, opts: { attempts: 1, removeOnComplete: { count: 7 }, removeOnFail: { count: 20 } } }
  ).catch(err => console.warn('[worker] Failed to schedule domain-health sweep:', err.message))
}

// ── Queue-depth-adaptive worker concurrency ───────────────────────────────────
// Opt-in via WORKER_ADAPTIVE_CONCURRENCY_ENABLED — off by default, so this is a
// pure addition: no worker's concurrency changes from its hardcoded value above
// unless an operator explicitly turns it on. See lib/adaptiveConcurrency.ts.
const adaptiveScalers: AdaptiveScaler[] = []
if (isAdaptiveConcurrencyEnabled()) {
  const pollIntervalMs = adaptivePollIntervalMs()
  for (const [name, worker] of WORKER_QUEUES) {
    const config = loadAdaptiveConfigFromEnv(name, worker.concurrency)
    if (config.min >= config.max) continue // no room to scale (e.g. static concurrency is already 1)
    adaptiveScalers.push(createAdaptiveScaler(name, getQueue(name), worker, {
      pollIntervalMs,
      config,
      onChange: ({ queue, from, to, action, waiting }) =>
        log(queue, `adaptive concurrency ${action}: ${from} -> ${to} (waiting=${waiting})`),
      onError: (err) => log(name, `adaptive concurrency poll failed: ${err instanceof Error ? err.message : String(err)}`),
    }))
  }
  console.log(`[worker] Adaptive concurrency enabled for ${adaptiveScalers.length}/${WORKER_QUEUES.length} queue(s), poll=${pollIntervalMs}ms`)
}

// ── Repeatable follow-up due-task scan (every 1 min by default) ───────────────
// The scheduler is ALWAYS registered (idempotent), but every scan job no-ops
// unless FOLLOWUPS_ENABLED is on (checked in the worker), so this stays dormant by
// default — the schedule exists and is visible without sending anything. Interval
// overridable via FOLLOWUP_SCAN_INTERVAL_MS.
{
  const followupQueue = new Queue('send-followup', { connection })
  const every = Number(process.env.FOLLOWUP_SCAN_INTERVAL_MS || 60 * 1000)
  followupQueue.upsertJobScheduler(
    'followup-due-scan',
    { every },
    { name: 'followup-due-scan', data: { scan: true }, opts: { attempts: 1, removeOnComplete: { count: 10 }, removeOnFail: { count: 20 } } }
  ).catch(err => console.warn('[worker] Failed to schedule follow-up scan:', err.message))
}

// Wire the error-capture seam to Sentry when SENTRY_DSN is set (no-op otherwise),
// so background-job failures (worker.ts handlers) reach the same transport as API errors.
void initErrorReporting()

// The API validates this at boot (server.ts, via checkEncryptionKeyHealth()); the
// worker never did, despite being the process that actually decrypts SMTP/IMAP
// credentials on every mail send/sync. Same non-fatal warn-only check.
checkEncryptionKeyHealth()

// The worker never ran the API's REQUIRED_IN_PRODUCTION presence check either,
// so a deployed worker with EMAIL_ENCRYPTION_KEY missing or malformed booted
// clean and only discovered it deep inside a job the first time it tried to
// decrypt an SMTP/IMAP credential — a mid-flight failure (and DLQ entry)
// instead of a clear boot-time crash. Fails loud here for the same deployed
// environments checkEncryptionKeyHealth() above leaves untouched.
checkEmailEncryptionKeyConfigured()

// Distributed tracing: no-op unless OTEL_EXPORTER_OTLP_ENDPOINT (or, for local
// debugging, OTEL_CONSOLE_EXPORTER) is set — see backend-core/lib/tracing.ts.
initTracing(SERVICE)

// Share circuit-breaker state with the API via Redis (reusing the BullMQ
// connection) so a provider outage the worker trips also protects the API.
// Fail-open: falls back to per-process state if Redis is unavailable.
attachBreakerStore(createRedisBreakerStore(connection))

// Share the platform-wide discovery-provider quota with the API the same way —
// the worker runs discovery jobs too (see processors.ts), against the same
// shared Apollo/Google Places contract.
attachProviderQuotaStore(connection)

// ── Liveness probe + metrics ─────────────────────────────────────────────────────
// Bind to the platform-injected PORT when present (so Railway's healthcheck, which
// probes $PORT, can reach /live and restart a wedged worker) and fall back to the
// fixed 9090 locally/in Docker. WORKER_HEALTH_PORT overrides both.
const healthServer = startHealthServer(
  Number(process.env.WORKER_HEALTH_PORT || process.env.PORT || 9090),
  {
    collectQueueDepths,
    collectDomainMetrics: () => domainMetricsCache.get(),
    isReady: () => !shuttingDown && connection.status === 'ready',
  },
)

// ── Graceful shutdown ──────────────────────────────────────────────────────────
async function shutdown(signal: string, exitCode = 0) {
  if (shuttingDown) return
  shuttingDown = true
  logLifecycleEvent(SERVICE, 'shutdown', { signal, phase: 'begin' })
  healthServer.close()

  // Watchdog: if a wedged BullMQ/Prisma close blocks the await below, force-exit
  // so the platform can restart us instead of the process hanging through SIGTERM
  // indefinitely (mirrors the API's shutdown timeout).
  const forceExit = setTimeout(() => {
    logLifecycleEvent(SERVICE, 'crash', { signal, reason: 'forced-exit-after-timeout' })
    process.exit(1)
  }, 10_000)
  forceExit.unref()

  for (const scaler of adaptiveScalers) scaler.stop()

  await Promise.all([
    researchWorker.close(),
    outreachWorker.close(),
    replyWorker.close(),
    mailboxWorker.close(),
    scoreProspectsWorker.close(),
    recommendWorker.close(),
    calibrateWorker.close(),
    sendCampaignWorker.close(),
    sendFollowupWorker.close(),
    discoverWorker.close(),
    retentionWorker.close(),
    dlqAutoRetryWorker.close(),
    domainHealthWorker.close(),
  ])
  closeMailTransports() // release pooled SMTP connections
  await prisma.$disconnect()
  clearTimeout(forceExit)
  logLifecycleEvent(SERVICE, 'shutdown', { signal, phase: 'complete' })
  process.exit(exitCode)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT',  () => void shutdown('SIGINT'))

// A single unhandledRejection stays log-only (often a benign stray promise), but a
// storm of them means the process is wedged in inconsistent state and "ready" is a
// lie — so after THRESHOLD within WINDOW we drain + exit non-zero for a clean restart.
const rejectionTracker = createRejectionTracker({
  threshold: Number(process.env.WORKER_REJECTION_THRESHOLD) || undefined,
  windowMs: Number(process.env.WORKER_REJECTION_WINDOW_MS) || undefined,
})
process.on('unhandledRejection', (reason) => {
  logLifecycleEvent(SERVICE, 'crash', { source: 'worker.unhandledRejection', reason: reason instanceof Error ? reason.message : String(reason) })
  captureError(reason, { source: 'worker.unhandledRejection' })
  if (rejectionTracker.record()) {
    logLifecycleEvent(SERVICE, 'crash', { source: 'worker.unhandledRejection.threshold', reason: 'too many unhandled rejections — restarting for a clean process' })
    void shutdown('worker.unhandledRejection.threshold', 1)
  }
})
process.on('uncaughtException', (err) => {
  logLifecycleEvent(SERVICE, 'crash', { source: 'worker.uncaughtException', err: err.message })
  captureError(err, { source: 'worker.uncaughtException' })
  // Inconsistent state after an uncaught exception — drain workers and exit
  // non-zero so the platform restarts a clean process (the in-shutdown watchdog
  // force-exits if a close wedges). unhandledRejection stays log-only above.
  void shutdown('worker.uncaughtException', 1)
})

logLifecycleEvent(SERVICE, 'deploy', { queueCount: WORKER_QUEUES.length })
logLifecycleEvent(SERVICE, 'startup', { queueCount: WORKER_QUEUES.length, releaseId: metadata.releaseId })
