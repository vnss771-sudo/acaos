// Single source of truth for Lead.stage transitions. Every worker/route that
// advances a lead should call transitionLeadStage(current, event) instead of
// writing Lead.stage directly, so the pipeline's ordering and terminal rules are
// enforced in ONE place and can't drift or regress.
//
// Pure and dependency-free (no Prisma) so it's exhaustively unit-testable; the
// caller persists `nextStage` only when `changed` is true.
//
// Pipeline:  NEW → RESEARCHED → OUTREACH_SENT → REPLIED → BOOKED → CLOSED
// Terminals: CLOSED and DEAD (no transitions out). The LeadStage enum has no
// BOUNCED/UNSUBSCRIBED stage, so a bounce/unsubscribe makes the lead DEAD
// (uncontactable) rather than introducing a new stage.
import type { LeadStage } from '@acaos/shared'

export type LeadStageEvent =
  | 'OUTREACH_SENT'
  | 'REPLY_INTERESTED'
  | 'REPLY_NOT_INTERESTED'
  | 'BOUNCE'
  | 'UNSUBSCRIBE'
  | 'BOOK_MEETING'
  | 'MARK_CLOSED'
  | 'MARK_DEAD'

export interface LeadStageTransition {
  nextStage: LeadStage
  changed: boolean
  reason: string
}

// Forward order within the contactable pipeline. DEAD is terminal and sits
// outside this ranking (handled explicitly).
const RANK: Record<Exclude<LeadStage, 'DEAD'>, number> = {
  NEW: 0,
  RESEARCHED: 1,
  OUTREACH_SENT: 2,
  REPLIED: 3,
  BOOKED: 4,
  CLOSED: 5,
}

// The stage each event targets. Reply intent (interested vs not) is recorded
// separately on the send/lead — for the STAGE it's just "REPLIED". A bounce or
// unsubscribe ends contactability → DEAD.
const EVENT_TARGET: Record<LeadStageEvent, LeadStage> = {
  OUTREACH_SENT: 'OUTREACH_SENT',
  REPLY_INTERESTED: 'REPLIED',
  REPLY_NOT_INTERESTED: 'REPLIED',
  BOUNCE: 'DEAD',
  UNSUBSCRIBE: 'DEAD',
  BOOK_MEETING: 'BOOKED',
  MARK_CLOSED: 'CLOSED',
  MARK_DEAD: 'DEAD',
}

const TERMINAL: ReadonlySet<LeadStage> = new Set<LeadStage>(['CLOSED', 'DEAD'])

/**
 * Resolve the next lead stage for an event. Never regresses within the pipeline
 * (e.g. a late reply can't pull a BOOKED lead back to REPLIED) and never moves a
 * terminal lead (CLOSED/DEAD stay put — a DEAD lead must be manually reopened).
 * Returns the next stage plus whether it actually changed and a short reason.
 */
export function transitionLeadStage(current: LeadStage, event: LeadStageEvent): LeadStageTransition {
  const noop = (reason: string): LeadStageTransition => ({ nextStage: current, changed: false, reason })

  // Terminal stages don't transition (DEAD requires an explicit manual reopen,
  // which isn't one of these lifecycle events).
  if (TERMINAL.has(current)) {
    return noop(`terminal: ${current} does not transition on ${event}`)
  }

  const target = EVENT_TARGET[event]

  // Terminating events apply from any non-terminal stage.
  if (target === 'DEAD') {
    return { nextStage: 'DEAD', changed: true, reason: `${event} → DEAD (uncontactable)` }
  }
  if (target === 'CLOSED') {
    return { nextStage: 'CLOSED', changed: true, reason: `${event} → CLOSED` }
  }

  // Pipeline progression: only forward moves count; an equal-or-backward target
  // is a no-op so a stage can't regress.
  const currentRank = RANK[current as Exclude<LeadStage, 'DEAD'>]
  const targetRank = RANK[target as Exclude<LeadStage, 'DEAD'>]
  if (targetRank > currentRank) {
    return { nextStage: target, changed: true, reason: `${current} → ${target}` }
  }
  return noop(`no-op: ${current} does not regress to ${target} on ${event}`)
}
