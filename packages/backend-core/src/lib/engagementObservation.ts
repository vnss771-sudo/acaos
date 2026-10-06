// Engagement observation: once a send's observation window closes, classify it
// ONCE, from what happened inside the window.
//
//   SENT ─ window ─┬─ BOUNCED       delivery failed (known failure, not silence)
//                  ├─ COMPLAINT     marked as spam
//                  ├─ UNSUBSCRIBED  explicit opt-out
//                  ├─ REPLIED       replied within the window
//                  └─ NO_RESPONSE   none of the above within the window
//
// NO_RESPONSE means "this outreach produced no observable response during the
// window" — NOT "this prospect is bad" and NOT a commercial LOST (commercial
// outcomes live in ProspectOutcome, a separate dimension). Opens/clicks are
// not responses. The classification is immutable: a reply arriving after the
// window stays on repliedAt / the ContactEvent ledger as a later event, so
// "no response within the window" is preserved for latency analysis.

import { prisma } from './prisma.js'
import { normalizeEmail } from './normalize.js'
import { DEFAULT_MESSAGE_RELEVANCE, getOrCreateScoringModel, maybeRecomputeScoringWeights, type ScoringWeights } from './scoring.js'

export type EngagementOutcome = 'REPLIED' | 'BOUNCED' | 'UNSUBSCRIBED' | 'COMPLAINT' | 'NO_RESPONSE'

/** Observation window in days (NO_RESPONSE_AFTER_DAYS, default 21, 1–365). */
export function noResponseAfterDays(): number {
  const n = Number(process.env.NO_RESPONSE_AFTER_DAYS)
  return Number.isInteger(n) && n >= 1 && n <= 365 ? n : 21
}

const DAY_MS = 86_400_000

/**
 * Pure classifier over the evidence inside [sentAt, observationDueAt].
 * Precedence: a bounce means the message never arrived, so it wins; then the
 * explicit negative signals; then a reply; otherwise silence.
 */
export function classifyEngagement(e: {
  bouncedInWindow: boolean
  unsubscribeSourceInWindow: string | null
  repliedInWindow: boolean
}): EngagementOutcome {
  if (e.bouncedInWindow) return 'BOUNCED'
  if (e.unsubscribeSourceInWindow === 'COMPLAINT') return 'COMPLAINT'
  if (e.unsubscribeSourceInWindow) return 'UNSUBSCRIBED'
  if (e.repliedInWindow) return 'REPLIED'
  return 'NO_RESPONSE'
}

// Outcomes the reply-learning loop consumes as "did not reply". REPLIED is
// already recorded by the reply-analysis pipeline; BOUNCED is a delivery
// failure and says nothing about the prospect, so it is never learned from.
const LEARN_AS_NOT_REPLIED: ReadonlySet<EngagementOutcome> = new Set(['NO_RESPONSE', 'UNSUBSCRIBED', 'COMPLAINT'])

export type ObservationRunResult = { observed: number; byOutcome: Partial<Record<EngagementOutcome, number>> }

/**
 * Classify every dispatched send whose window has closed and that isn't classified
 * yet. Idempotent: each row is claimed with a conditional update
 * (engagementOutcome IS NULL), so re-runs and concurrent runs never produce a
 * second outcome — or a second learning sample — for the same send.
 */
export async function observeEngagementOutcomes(
  now: Date = new Date(),
  opts: { batchSize?: number; maxBatches?: number } = {},
): Promise<ObservationRunResult> {
  const windowDays = noResponseAfterDays()
  const cutoff = new Date(now.getTime() - windowDays * DAY_MS)
  const batchSize = opts.batchSize ?? 500
  const maxBatches = opts.maxBatches ?? 20
  const result: ObservationRunResult = { observed: 0, byOutcome: {} }

  for (let batch = 0; batch < maxBatches; batch++) {
    const rows = await prisma.outreachSent.findMany({
      // Every dispatched send: status moves SENT → REPLIED / BOUNCED in place.
      // FAILED / PENDING / SENDING were never delivered, so there is nothing to observe.
      where: { status: { in: ['SENT', 'REPLIED', 'BOUNCED'] }, engagementOutcome: null, sentAt: { lte: cutoff } },
      orderBy: { sentAt: 'asc' },
      take: batchSize,
      select: { id: true, workspaceId: true, leadId: true, toEmail: true, sentAt: true, repliedAt: true, status: true, messageRelevanceScore: true, timingFitScore: true },
    })
    if (rows.length === 0) break

    for (const row of rows) {
      const due = new Date(row.sentAt.getTime() + windowDays * DAY_MS)
      const inWindow = { gte: row.sentAt, lte: due }
      const emailKey = normalizeEmail(row.toEmail)
      const [bounce, unsub] = await Promise.all([
        prisma.contactEvent.findFirst({
          where: { workspaceId: row.workspaceId, emailKey, type: 'BOUNCED', occurredAt: inWindow }, select: { id: true },
        }),
        prisma.unsubscribeEvent.findFirst({
          where: { workspaceId: row.workspaceId, emailKey, occurredAt: inWindow },
          orderBy: { occurredAt: 'asc' }, select: { source: true },
        }),
      ])
      const outcome = classifyEngagement({
        // A bounce is a delivery failure whenever it's reported, so the row's own
        // BOUNCED status counts even without an in-window ledger event.
        bouncedInWindow: row.status === 'BOUNCED' || bounce !== null,
        unsubscribeSourceInWindow: unsub?.source ?? null,
        repliedInWindow: row.repliedAt !== null && row.repliedAt <= due,
      })

      const claimed = await prisma.outreachSent.updateMany({
        where: { id: row.id, engagementOutcome: null },
        data: { engagementOutcome: outcome, observationWindowDays: windowDays, observationDueAt: due, observedAt: now },
      })
      if (claimed.count === 0) continue // another run got here first
      result.observed++
      result.byOutcome[outcome] = (result.byOutcome[outcome] ?? 0) + 1

      if (LEARN_AS_NOT_REPLIED.has(outcome) && row.leadId) {
        const lead = await prisma.lead.findUnique({ where: { id: row.leadId }, select: { score: true } })
        if (!lead) continue
        const model = await getOrCreateScoringModel(row.workspaceId)
        await prisma.scoringOutcome.create({
          data: {
            workspaceId: row.workspaceId, leadId: row.leadId, prospectId: null,
            score: lead.score, replied: false, replyIntent: outcome,
            messageRelevance: row.messageRelevanceScore ?? DEFAULT_MESSAGE_RELEVANCE, timingFit: row.timingFitScore, channelUsed: 'EMAIL', scoringModelId: model.id,
          },
        })
        // Same guarded loop as replies (mode-gated; retunes on every Nth
        // outcome, so it must see each outcome individually). Not in one
        // transaction with the claim: a crash between them loses one sample
        // rather than ever duplicating one.
        await maybeRecomputeScoringWeights(row.workspaceId, model.id, model.weights as ScoringWeights)
      }
    }
    if (rows.length < batchSize) break
  }

  return result
}
