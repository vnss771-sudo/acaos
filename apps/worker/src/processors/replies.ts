// Pure-DB queue processors, extracted from worker.ts so they can be unit-tested
// against a real database without instantiating BullMQ Workers (which connect to
// Redis on construction). worker.ts wires these into Workers; tests call them
// directly.

import { prisma } from '@acaos/backend-core/lib/prisma.js'
import { DEFAULT_MESSAGE_RELEVANCE, getOrCreateScoringModel, maybeRecomputeScoringWeights, type ScoringWeights } from '@acaos/backend-core/lib/scoring.js'
import { effectiveReplyClassification, REPLY_STAGE, replyOutcomeFor } from '@acaos/backend-core/lib/replyGating.js'
import { parseRiskFlags } from '@acaos/backend-core/lib/riskEscalation.js'
import { type ReplyAnalysisOutput } from '@acaos/backend-core/lib/aiSchemas.js'
import { trackEvent } from '@acaos/backend-core/lib/analytics.js'
import { emitWebhookEvent } from '@acaos/backend-core/lib/webhooks.js'
import type { LeadStage } from '@acaos/shared'

/** Recompute opportunity scores for every prospect in a workspace. */

export async function applyReplyAnalysis(leadId: string, parsed: ReplyAnalysisOutput): Promise<void> {
  // Read the lead first: confirm it exists + capture its workspace, and scope every
  // write by workspaceId so a forged/mis-routed job can't touch another tenant.
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    select: { workspaceId: true, score: true },
  })
  if (!lead) return

  // Stamp AI-derived reply metadata onto the send that just flipped to REPLIED so
  // the Inbox can show classification/summary/suggested action — for every
  // classification, incl. auto-replies. The raw reply body is never persisted.
  const target = await prisma.outreachSent.findFirst({
    where: { leadId, workspaceId: lead.workspaceId, status: 'REPLIED' },
    orderBy: { repliedAt: 'desc' },
    select: { id: true, messageRelevanceScore: true, timingFitScore: true, replyRiskFlags: true },
  })
  // Risk flags were set deterministically at sync time (lib/riskEscalation.ts).
  // An escalated reply — legal action, a payment dispute, a complaint, a damage
  // claim — is a person's call: the AI label is still recorded for the Inbox, but
  // it never drives the irreversible DEAD transition or teaches the scorer.
  const escalated = parseRiskFlags(target?.replyRiskFlags).length > 0
  if (target) {
    await prisma.outreachSent.update({
      where: { id: target.id },
      data: {
        replyIntent: parsed.classification,
        replySummary: parsed.summary ?? null,
        replyKeyQuote: parsed.keyQuote ?? null,
        replySuggestedAction: parsed.suggestedAction ?? null,
        replyUrgency: parsed.urgency ?? null,
        replyConfidence: parsed.confidence != null ? Math.round(parsed.confidence) : null,
        replyIsAutoReply: parsed.isAutoReply ?? false,
      },
    })
  }

  // Auto-replies (OOO/bounce-like) carry no buying intent — record them on the send
  // (above) but never advance the lead or feed the scoring model.
  if (parsed.isAutoReply) return

  // Activation-funnel: a genuine (non-auto) reply is "first value". Best-effort.
  void trackEvent({ name: 'reply.received', workspaceId: lead.workspaceId, properties: { leadId, classification: parsed.classification } })
  // Notify any customer webhook endpoints subscribed to reply.received. Best-effort.
  void emitWebhookEvent(lead.workspaceId, 'reply.received', { leadId, classification: parsed.classification })

  // Confidence-gate the one IRREVERSIBLE consequence (NOT_INTERESTED → DEAD): a
  // low-confidence negative is downgraded to NEEDS_MORE_INFO so the lead is kept
  // for human review rather than auto-killed. The raw classification/confidence were
  // already stamped on the send above; only the automated effects use the gated value.
  const effectiveClassification = effectiveReplyClassification(parsed.classification, parsed.confidence)

  const mapped = REPLY_STAGE[effectiveClassification] as LeadStage | undefined
  const newStage = escalated && mapped === 'DEAD' ? 'REPLIED' : mapped
  if (newStage) {
    await prisma.lead.updateMany({ where: { id: leadId, workspaceId: lead.workspaceId }, data: { stage: newStage } })
  }

  // The label on an escalated reply isn't trustworthy evidence of buying intent
  // either way; keep it out of the learning loop.
  if (escalated) return

  // Common path is a read: the scoring model almost always already exists. The
  // @unique(workspaceId) means a concurrent first-reply race can lose the create
  // with P2002; re-read in that case so we still get the id.
  const model = await getOrCreateScoringModel(lead.workspaceId)

  // Use the gated classification for the scoring outcome too, so a downgraded
  // low-confidence negative doesn't feed the learning loop a false "not replied".
  const { replied, replyIntent } = replyOutcomeFor(effectiveClassification)

  await prisma.scoringOutcome.create({
    data: {
      workspaceId: lead.workspaceId,
      leadId,
      // Lead-sourced outcome — there is no Prospect.
      prospectId: null,
      score: lead.score,
      replied,
      replyIntent,
      // The replied-to message's relevance, scored and frozen at SEND time —
      // never derived from the reply (that would leak the outcome into its own
      // predictor). Sends from before relevance scoring fall back to the default.
      messageRelevance: target?.messageRelevanceScore ?? DEFAULT_MESSAGE_RELEVANCE,
      timingFit: target?.timingFitScore ?? null,
      channelUsed: 'EMAIL',
      scoringModelId: model.id,
    },
  })

  // Feed the same learning loop the external FieldOps ingest endpoint
  // (POST /api/outcomes) already drives, so a customer's own reply data — not
  // just FieldOps's — retunes their scoring weights over time.
  await maybeRecomputeScoringWeights(lead.workspaceId, model.id, model.weights as ScoringWeights)
}
