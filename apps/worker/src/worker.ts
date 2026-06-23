import 'dotenv/config'
import { Worker, Queue } from 'bullmq'
import { connection, getQueue } from './lib/queue.js'
import { startHealthServer } from './health.js'
import { incJob, observeJobDuration, type QueueDepth, type DomainSnapshot } from './lib/metrics.js'
import { evaluateSenderReputation } from '@acaos/backend-core/lib/senderReputation.js'
import { warmupDailyCap } from '@acaos/backend-core/lib/warmup.js'
import { generateLeadResearch, generateOutreach, analyzeReply, outreachGenerationMeta } from '@acaos/backend-core/services/openai.js'
import { resolvePromptVersionId } from '@acaos/backend-core/lib/aiPromptRegistry.js'
import { closeMailTransports } from '@acaos/backend-core/services/mail.js'
import {
  parseAiJson,
  parseLeadResearchJson,
  OutreachDraftOutputSchema,
  ReplyAnalysisOutputSchema,
} from '@acaos/backend-core/lib/aiSchemas.js'
import { assertOutreachTone } from '@acaos/backend-core/lib/outreachTone.js'
import { replaceLeadEvidence } from '@acaos/backend-core/lib/leadEvidence.js'
import { resolveOutreachGate } from '@acaos/backend-core/lib/outreachGate.js'
import { refundAiUsage } from '@acaos/backend-core/lib/limits.js'
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
} from '@acaos/backend-core/lib/queueSchemas.js'
import { purgeExpiredData } from '@acaos/backend-core/lib/retention.js'
import { recoverStaleSends } from '@acaos/backend-core/lib/staleSends.js'
import { reconcileEnabled, reconcileCampaignStats } from '@acaos/backend-core/lib/reconciliation.js'
import { isFeatureEnabled, areFollowupsEnabled } from '@acaos/backend-core/lib/launchControls.js'
import { prisma } from '@acaos/backend-core/lib/prisma.js'
import { explainLeadScore, getWorkspaceWeights } from '@acaos/backend-core/lib/scoring.js'
import {
  generateRuleBasedRecommendation,
  toRawSignal,
} from '@acaos/backend-core/lib/signalEngine.js'
import { scoreProspects, calibrateScoring, sendCampaignBatch, applyReplyAnalysis, discoverProspectsBatch, sendFollowupTask } from './processors.js'
import { runInWorkspaceContext } from '@acaos/backend-core/lib/tenantContext.js'
import { enqueueGenerateRecommendations, enqueueDueFollowups } from '@acaos/backend-core/lib/queues.js'
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

const SERVICE = 'acaos-worker'
const metadata = getRuntimeMetadata(SERVICE)
let shuttingDown = false

function log(queue: string, msg: string, requestId?: string) {
  logger.info(msg, { queue, service: SERVICE, releaseId: metadata.releaseId, ...(requestId ? { requestId } : {}) })
}

// ── research-lead ─────────────────────────────────────────────────────────────
const researchWorker = new Worker(
  'research-lead',
  async (job) => {
    const { leadId, workspaceId } = parseJobPayload(ResearchLeadPayloadSchema, 'research-lead', job.data)
    if (!isFeatureEnabled('ai')) { log('research-lead', 'skipped: FEATURE_AI disabled'); return { skipped: true, reason: 'FEATURE_AI disabled' } }
    log('research-lead', `Processing leadId=${leadId}`)

    // Tenant-scoped fetch: never act on a lead outside the job's workspace.
    const lead = await prisma.lead.findFirst({ where: { id: leadId, workspaceId } })
    if (!lead) throw new Error(`Lead ${leadId} not found in workspace ${workspaceId}`)

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
    // Deterministic score + its rationale (the "why 75"), so the breakdown is
    // captured in the job result/log rather than thrown away.
    const explanation = explainLeadScore(enrichedLead, weights)
    const computedScore = explanation.score
    const finalScore = (typeof parsed.icpScore === 'number' && parsed.icpScore >= 0 && parsed.icpScore <= 100)
      ? Math.round((parsed.icpScore + computedScore) / 2)
      : computedScore

    await job.updateProgress(80)

    // Auditable intelligence snapshot persisted on the lead: the deterministic
    // score rationale plus the model's provenance-labelled evidence. JSON-only
    // values (no undefined) so it round-trips cleanly through the JSONB column.
    const aiIntelligence = {
      capturedAt: new Date().toISOString(),
      finalScore,
      computedScore,
      tier: explanation.tier,
      modelIcpScore: typeof parsed.icpScore === 'number' ? parsed.icpScore : null,
      topReasons: explanation.topReasons,
      signals: explanation.signals,
      evidence: parsed.evidence ?? [],
      riskFlags: parsed.riskFlags ?? [],
      recommendedAction: parsed.recommendedAction ?? null,
      confidence: parsed.confidence ?? null,
      digitalMaturity: parsed.digitalMaturity ?? null,
      estimatedTeamSize: parsed.estimatedTeamSize ?? null,
      hiringSignals: parsed.hiringSignals ?? null,
    }

    // Atomic: persist the lead's intelligence snapshot AND replace its normalized
    // evidence rows together, so a re-research can't leave stale evidence behind.
    await prisma.$transaction(async (tx) => {
      await tx.lead.update({
        where: { id: leadId },
        data: {
          aiSummary: parsed.aiSummary ?? null,
          outreachAngle: parsed.outreachAngle ?? null,
          aiIntelligence,
          score: finalScore,
          stage: 'RESEARCHED'
        }
      })
      await replaceLeadEvidence(tx, { workspaceId: lead.workspaceId, leadId, evidence: parsed.evidence })
    })

    await job.updateProgress(100)
    log('research-lead', `Done leadId=${leadId} stage=RESEARCHED score=${finalScore} why=${explanation.topReasons.join('; ') || 'n/a'}`)
    return {
      leadId,
      aiSummary: parsed.aiSummary,
      outreachAngle: parsed.outreachAngle,
      score: finalScore,
      scoreReasons: explanation.topReasons,
      signals: explanation.signals,
      evidence: parsed.evidence,
      riskFlags: parsed.riskFlags,
      recommendedAction: parsed.recommendedAction,
    }
  },
  { connection, concurrency: 3 }
)

// ── generate-outreach ─────────────────────────────────────────────────────────
const outreachWorker = new Worker(
  'generate-outreach',
  async (job) => {
    const { leadId, workspaceId, override } = parseJobPayload(GenerateOutreachPayloadSchema, 'generate-outreach', job.data)
    if (!isFeatureEnabled('ai')) { log('generate-outreach', 'skipped: FEATURE_AI disabled'); return { skipped: true, reason: 'FEATURE_AI disabled' } }
    log('generate-outreach', `Processing leadId=${leadId}`)

    // Tenant-scoped fetch: never act on a lead outside the job's workspace.
    const lead = await prisma.lead.findFirst({ where: { id: leadId, workspaceId } })
    if (!lead) throw new Error(`Lead ${leadId} not found in workspace ${workspaceId}`)

    // Outreach gate: honour the research recommendedAction. A poor-fit ("skip")
    // lead is suppressed (no model call) and marked for the review queue; a human
    // can override, which generates a draft into POLICY_REVIEW. manual_review and
    // override both force POLICY_REVIEW. auto_draft / none → normal DRAFTED flow.
    const intel = (lead.aiIntelligence ?? null) as { recommendedAction?: string } | null
    const gate = resolveOutreachGate({ recommendedAction: intel?.recommendedAction, override })

    if (!gate.generate) {
      await prisma.lead.update({
        where: { id: lead.id },
        data: { outreachSkippedAt: new Date(), outreachSkipReason: gate.skipReason },
      })
      // No model call was made — free the AI_OUTREACH credit the API metered up front.
      await refundAiUsage(lead.workspaceId, 'AI_OUTREACH')
      await job.updateProgress(100)
      log('generate-outreach', `suppressed leadId=${leadId}: ${gate.skipReason}`)
      return { leadId, skipped: true, reason: gate.skipReason }
    }

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

    // Tone guardrail: reject "creepy", presumptuous copy that asserts private
    // knowledge of the recipient's problems as fact (fail closed → BullMQ
    // regenerates). Buzzword warnings are surfaced but do not block.
    const toneWarnings = assertOutreachTone(parsed)
    if (toneWarnings.length > 0) {
      log('generate-outreach', `tone warnings leadId=${leadId}: ${toneWarnings.map((w) => w.match).join(', ')}`)
    }

    // Record generation provenance (model + prompt version) so the draft is
    // auditable/reproducible. Best-effort — never blocks draft creation.
    const promptVersionId = await resolvePromptVersionId({ workspaceId: lead.workspaceId, ...outreachGenerationMeta() })

    await prisma.outreachDraft.create({
      data: {
        leadId: lead.id,
        workspaceId: lead.workspaceId,
        subject: parsed.subject,
        emailBody: parsed.email,
        followup: parsed.followup ?? null,
        // Gated status: POLICY_REVIEW when research asked for manual review or a
        // human overrode a skip (held for a human); otherwise the normal DRAFTED.
        status: gate.draftStatus,
        promptVersionId,
      }
    })

    // A successful (over)ride generation clears any prior poor-fit suppression.
    if (lead.outreachSkippedAt) {
      await prisma.lead.update({ where: { id: lead.id }, data: { outreachSkippedAt: null, outreachSkipReason: null } })
    }

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
    if (!isFeatureEnabled('ai')) { log('analyze-reply', 'skipped: FEATURE_AI disabled'); return { skipped: true, reason: 'FEATURE_AI disabled' } }
    log('analyze-reply', `Processing${leadId ? ` leadId=${leadId}` : ''}`)

    await job.updateProgress(10)
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
  },
  { connection, concurrency: 5 }
)

// ── sync-mailbox ──────────────────────────────────────────────────────────────
const mailboxWorker = new Worker(
  'sync-mailbox',
  async (job) => {
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
  },
  { connection, concurrency: 1 }
)

// ── score-prospects ────────────────────────────────────────────────────────────
const scoreProspectsWorker = new Worker(
  'score-prospects',
  async (job) => {
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
  },
  { connection, concurrency: 1 }
)

// ── discover-prospects ────────────────────────────────────────────────────────
// Off-request prospect discovery: the /discover route creates the RUNNING run +
// enqueues this; here we call the provider and import results, finalizing the run
// as SUCCEEDED / PARTIAL / FAILED. Gated by the same 'discovery' feature flag the
// route checks. Low concurrency — provider calls are metered and rate-limited.
const discoverWorker = new Worker(
  'discover-prospects',
  async (job) => {
    const { runId, workspaceId } = parseJobPayload(DiscoverProspectsPayloadSchema, 'discover-prospects', job.data)
    if (!isFeatureEnabled('discovery')) { log('discover-prospects', 'skipped: FEATURE_DISCOVERY disabled'); return { skipped: true, reason: 'FEATURE_DISCOVERY disabled' } }
    log('discover-prospects', `Discovering run=${runId} workspace=${workspaceId}`)
    const result = await runInWorkspaceContext(workspaceId, () => discoverProspectsBatch(runId, workspaceId, (n) => job.updateProgress(n)))
    log('discover-prospects', `Done run=${runId} status=${result.status} imported=${result.imported} skipped=${result.skipped}`)
    return result
  },
  { connection, concurrency: 2 }
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
    if (!isFeatureEnabled('send')) { log('send-campaign', 'skipped: FEATURE_SEND disabled'); return { skipped: true, reason: 'FEATURE_SEND disabled', sent: 0, skipped_count: leadIds?.length ?? 0 } }
    log('send-campaign', `Sending campaign=${campaignId} workspace=${workspaceId}`)
    const result = await runInWorkspaceContext(workspaceId, () => sendCampaignBatch(campaignId, workspaceId, leadIds, (n) => job.updateProgress(n)))
    // Compact skip breakdown (non-zero reasons only) so the operator log answers
    // "why didn't these send?" at a glance.
    const reasons = Object.entries(result.skippedByReason).filter(([, n]) => n > 0).map(([r, n]) => `${r}=${n}`).join(' ')
    log('send-campaign', `Done campaign=${campaignId} sent=${result.sent} skipped=${result.skipped} failed=${result.failed}${reasons ? ` [${reasons}]` : ''}`)
    return result
  },
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
  async (job) => {
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
  },
  { connection, concurrency: 2 }
)

// ── calibrate-scoring ─────────────────────────────────────────────────────────
const calibrateWorker = new Worker(
  'calibrate-scoring',
  async (job) => {
    const { workspaceId } = parseJobPayload(CalibrateScoringPayloadSchema, 'calibrate-scoring', job.data)
    log('calibrate-scoring', `Calibrating workspace=${workspaceId}`)
    const stats = await runInWorkspaceContext(workspaceId, () => calibrateScoring(workspaceId, (n) => job.updateProgress(n)))
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
  ['send-followup',           sendFollowupWorker],
  ['discover-prospects',      discoverWorker],
  ['retention-purge',         retentionWorker],
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
    collectDomainMetrics,
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
  ])
  closeMailTransports() // release pooled SMTP connections
  await prisma.$disconnect()
  clearTimeout(forceExit)
  logLifecycleEvent(SERVICE, 'shutdown', { signal, phase: 'complete' })
  process.exit(exitCode)
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
  // Inconsistent state after an uncaught exception — drain workers and exit
  // non-zero so the platform restarts a clean process (the in-shutdown watchdog
  // force-exits if a close wedges). unhandledRejection stays log-only above.
  void shutdown('worker.uncaughtException', 1)
})

logLifecycleEvent(SERVICE, 'deploy', { queueCount: WORKER_QUEUES.length })
logLifecycleEvent(SERVICE, 'startup', { queueCount: WORKER_QUEUES.length, releaseId: metadata.releaseId })
