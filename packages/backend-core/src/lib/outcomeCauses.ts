// Closed-loop learning, step 1: why did an opportunity close (or stall) the way
// it did? Deterministic rules over the outcome chain (outcomeGraph.ts) and the
// opportunity's own assessment — no model call.
//
//   LOST_TO_COMPETITOR  lost after a quote, or lost in a contested deal
//   WRONG_CONTACT       a bounce, a referral reply, or nobody reachable
//   WRONG_TIMING        the buyer said "not now", it was sold before the buyer
//                       had a requirement, or the evidence was old when sent
//   WRONG_SIGNAL        the event went stale or was never corroborated
//   BAD_MESSAGE         a good, timely opportunity that didn't land: no reply,
//                       "not interested", or an ungrounded draft went out
//   UNKNOWN             closed or stalled, and none of the above explains it
//
// Rules run in that order (with an explicit "not now" ahead of a stale signal);
// the first that matches is the cause. A WON chain has no cause, and an open
// chain only gets one once it has stalled after a send.
import type { OutcomeChain, OutcomeSend } from './outcomeGraph.js'

export const OUTCOME_CAUSES = [
  'LOST_TO_COMPETITOR', 'WRONG_CONTACT', 'WRONG_TIMING', 'WRONG_SIGNAL', 'BAD_MESSAGE', 'UNKNOWN',
] as const
export type OutcomeCause = (typeof OUTCOME_CAUSES)[number]

export type CauseContext = {
  /** Status of the commercial event the opportunity was built on. */
  eventStatus: string | null
  intelligenceGate: boolean
  buyingStage: string
  competition: number | null
  contactability: number
  /** Newest evidence date behind the opportunity (ISO). */
  newestEvidenceAt: string | null
  /** Sends stamped with this opportunity's intents. */
  sends: OutcomeSend[]
  /** False when a draft that went out failed its grounding check. */
  draftGrounded: boolean | null
}

export type CauseAttribution = {
  cause: OutcomeCause
  /** 0..100 — how directly the evidence points at the cause. */
  confidence: number
  reasons: string[]
  /** CLOSED once WON/LOST; STALLED when sent with no response in the window. */
  basis: 'CLOSED' | 'STALLED'
}

/** No buyer response this long after the first send counts as stalled. */
export const STALL_DAYS = 21
/** Evidence older than this when the outreach went out was stale timing. */
const STALE_EVIDENCE_DAYS = 30
const COMPETITIVE = 60
const UNREACHABLE = 40
const EARLY_STAGES = new Set(['NO_DETECTABLE_NEED', 'EMERGING_TRIGGER', 'PROBLEM_LIKELY'])
const DAY = 86_400_000

export function attributeCause(chain: OutcomeChain, ctx: CauseContext, now: number): CauseAttribution | null {
  if (chain.final === 'WON') return null
  const stages = new Set(chain.nodes.map(n => n.stage))
  const sent = chain.nodes.find(n => n.stage === 'SENT')
  const responded = chain.nodes.some(n => n.stage === 'REPLIED' || n.stage === 'MEETING' || n.stage === 'QUOTED')

  let basis: CauseAttribution['basis']
  if (chain.final === 'LOST') basis = 'CLOSED'
  else if (sent && !responded && now - Date.parse(sent.at) >= STALL_DAYS * DAY) basis = 'STALLED'
  else return null

  const replies = ctx.sends.filter(s => s.repliedAt && s.replyIsAutoReply !== true).map(s => s.replyIntent)
  const out = (cause: OutcomeCause, confidence: number, ...reasons: string[]): CauseAttribution => ({ cause, confidence, reasons, basis })

  if (chain.final === 'LOST') {
    if (stages.has('QUOTED')) return out('LOST_TO_COMPETITOR', 75, 'Lost after a quote was with the buyer')
    if ((ctx.competition ?? 0) >= COMPETITIVE) return out('LOST_TO_COMPETITOR', 55, `Lost in a contested deal (competition ${ctx.competition})`)
  }
  if (ctx.sends.some(s => s.status === 'BOUNCED')) return out('WRONG_CONTACT', 85, 'The outreach bounced')
  if (replies.includes('REFERRAL')) return out('WRONG_CONTACT', 75, 'The buyer referred us to someone else')
  if (replies.includes('NOT_NOW')) return out('WRONG_TIMING', 80, 'The buyer said "not now"')
  if (ctx.eventStatus === 'STALE') return out('WRONG_SIGNAL', 70, 'The commercial event is no longer supported by the evidence')
  if (!ctx.intelligenceGate) return out('WRONG_SIGNAL', 60, 'The opportunity was never corroborated by an independent source')
  if (ctx.contactability < UNREACHABLE) return out('WRONG_CONTACT', 50, `Low contactability (${ctx.contactability})`)
  if (sent && EARLY_STAGES.has(ctx.buyingStage)) {
    return out('WRONG_TIMING', 55, `Sold while the buyer was at "${ctx.buyingStage.toLowerCase().replace(/_/g, ' ')}"`)
  }
  if (sent && ctx.newestEvidenceAt) {
    const age = Math.floor((Date.parse(sent.at) - Date.parse(ctx.newestEvidenceAt)) / DAY)
    if (age > STALE_EVIDENCE_DAYS) return out('WRONG_TIMING', 50, `The newest evidence was ${age} days old when the outreach went out`)
  }
  if (sent) {
    if (ctx.draftGrounded === false) return out('BAD_MESSAGE', 65, 'A draft that failed its grounding check went out')
    if (replies.includes('NOT_INTERESTED')) return out('BAD_MESSAGE', 55, 'A corroborated, timely opportunity replied "not interested"')
    if (!responded) return out('BAD_MESSAGE', 45, `No response ${STALL_DAYS}+ days after a corroborated, timely send`)
  }
  return out('UNKNOWN', 20, chain.final === 'LOST' ? 'Lost with no outreach or signal pattern to explain it' : 'Stalled with no clear pattern')
}

// ── Step 2: from causes to proposals ───────────────────────────────────────────

export type CausedOpportunity = {
  opportunityId: string
  cause: OutcomeCause
  eventType: string
  offerKey: string
  buyingStage: string
}

export type CauseDimension = 'eventType' | 'offerKey' | 'buyingStage'
const DIMENSIONS: CauseDimension[] = ['eventType', 'offerKey', 'buyingStage']

export type CauseGroup = {
  dimension: CauseDimension
  value: string
  total: number
  byCause: Partial<Record<OutcomeCause, number>>
}

export function summarizeCauses(items: CausedOpportunity[]): { total: number; byCause: Record<OutcomeCause, number>; groups: CauseGroup[] } {
  const byCause = Object.fromEntries(OUTCOME_CAUSES.map(c => [c, 0])) as Record<OutcomeCause, number>
  const groups = new Map<string, CauseGroup>()
  for (const it of items) {
    byCause[it.cause]++
    for (const d of DIMENSIONS) {
      const key = `${d}:${it[d]}`
      const g = groups.get(key) ?? { dimension: d, value: it[d], total: 0, byCause: {} }
      g.total++
      g.byCause[it.cause] = (g.byCause[it.cause] ?? 0) + 1
      groups.set(key, g)
    }
  }
  const sorted = [...groups.values()].sort((a, b) => b.total - a.total || a.dimension.localeCompare(b.dimension) || a.value.localeCompare(b.value))
  return { total: items.length, byCause, groups: sorted }
}

/** Advisory proposal type: approving acknowledges it; nothing is changed. */
export const OPPORTUNITY_CAUSE_TYPE = 'OPPORTUNITY_CAUSE'
/** A cause must explain at least this share of a group's closed/stalled opportunities. */
export const MIN_CAUSE_SHARE = 0.4

const ADVICE: Record<Exclude<OutcomeCause, 'UNKNOWN'>, string> = {
  LOST_TO_COMPETITOR: 'Research the incumbent and lead with proof before quoting on these',
  WRONG_CONTACT: 'Verify the decision maker before outreach on these',
  WRONG_TIMING: 'Wait for an active requirement and fresher evidence before contacting on these',
  WRONG_SIGNAL: 'Require stronger corroboration before treating these as opportunities',
  BAD_MESSAGE: 'Rework the message angle and proof for these',
}

const DIMENSION_LABEL: Record<CauseDimension, string> = { eventType: 'event', offerKey: 'offer', buyingStage: 'buying stage' }

export type CauseFinding = {
  cause: Exclude<OutcomeCause, 'UNKNOWN'>
  dimension: CauseDimension
  value: string
  advice: string
}

export type CauseFindingEvidence = CauseFinding & {
  basis: string
  total: number
  causeCount: number
  share: number
  byCause: Partial<Record<OutcomeCause, number>>
  examples: string[]
}

/**
 * One finding per (dimension, value) group whose dominant cause explains at
 * least MIN_CAUSE_SHARE of at least `minSample` closed or stalled outcomes.
 * UNKNOWN is reported in the summary but never becomes a finding.
 */
export function buildCauseFindings(items: CausedOpportunity[], minSample: number): CauseFindingEvidence[] {
  const { groups } = summarizeCauses(items)
  const findings: CauseFindingEvidence[] = []
  for (const g of groups) {
    if (g.total < minSample) continue
    const [cause, count] = (Object.entries(g.byCause) as Array<[OutcomeCause, number]>)
      .filter(([c]) => c !== 'UNKNOWN')
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] ?? []
    if (!cause || !count) continue
    const share = Math.round((count / g.total) * 1000) / 1000
    if (share < MIN_CAUSE_SHARE) continue
    const known = cause as Exclude<OutcomeCause, 'UNKNOWN'>
    findings.push({
      cause: known, dimension: g.dimension, value: g.value, advice: ADVICE[known],
      basis: `${count} of ${g.total} closed or stalled opportunities for ${DIMENSION_LABEL[g.dimension]} ${g.value}`,
      total: g.total, causeCount: count, share, byCause: g.byCause,
      examples: items.filter(i => i[g.dimension] === g.value && i.cause === cause).slice(0, 5).map(i => i.opportunityId),
    })
  }
  return findings
}

export type CauseProposalDraft = {
  type: typeof OPPORTUNITY_CAUSE_TYPE
  currentValue: null
  /** Only what a reviewer acts on — stable while the picture doesn't change. */
  proposedValue: { findings: CauseFinding[] }
  evidence: { basis: string; attributed: number; byCause: Record<OutcomeCause, number>; findings: CauseFindingEvidence[] }
  sampleSize: number
}

/**
 * The workspace's one advisory cause review (the schema allows one PENDING
 * proposal per type), or null when nothing clears the bars.
 */
export function buildCauseProposal(items: CausedOpportunity[], minSample: number): CauseProposalDraft | null {
  const findings = buildCauseFindings(items, minSample)
  if (findings.length === 0) return null
  const { byCause, total } = summarizeCauses(items)
  return {
    type: OPPORTUNITY_CAUSE_TYPE,
    currentValue: null,
    proposedValue: { findings: findings.map(({ cause, dimension, value, advice }) => ({ cause, dimension, value, advice })) },
    evidence: {
      basis: `${findings.length} repeated cause${findings.length === 1 ? '' : 's'} across ${total} closed or stalled opportunities`,
      attributed: total,
      byCause,
      findings,
    },
    sampleSize: total,
  }
}
