// Recommendation Engine — one explained recommendation per commercial opportunity.
//
// Derived from what the opportunity already knows: the buying stage's play, the
// scorecard, the (gated) next-best-action and the offer's recommendedActions and
// proofPoints. The move is one of RECOMMENDATION_KINDS; the "why" cites the
// evidence claims behind it ("$4.2M project awarded — 9 days ago").
//
// Gate 2, decision truth: no explanation → no recommendation. A move that
// contacts the buyer must cite at least one evidence claim. Contact-now and
// case-study moves only follow a CONTACT_NOW next-best-action, which has already
// passed the corroboration and stage gates.
//
// Nothing here sends: an outreach move becomes a Recommendation row (the entry
// to the intent → approval → send bridge) and stops there. Deterministic; `now`
// is passed in, never read from the clock.
import type { EngagementStage } from './buyingStage.js'
import type { EvidenceClaim } from './commercialEventEngine.js'
import type { OfferDefinition } from './offerModel.js'
import type { OpportunityAssessment } from './opportunityEngine.js'

export const RECOMMENDATION_KINDS = [
  'CONTACT_NOW', 'WAIT', 'FIND_BUYER', 'RESEARCH_INCUMBENT', 'SEND_CASE_STUDY',
  'ASK_QUALIFYING_QUESTION', 'DONT_CONTACT', 'MONITOR', 'ESCALATE', 'RE_ENGAGE',
] as const
export type RecommendationKind = (typeof RECOMMENDATION_KINDS)[number]

/** Moves that contact the buyer — these go through the approval bridge. */
export const OUTREACH_KINDS: ReadonlySet<RecommendationKind> = new Set([
  'CONTACT_NOW', 'SEND_CASE_STUDY', 'ASK_QUALIFYING_QUESTION', 'RE_ENGAGE',
])

export type RecommendationCitation = {
  signalId: string | null
  claim: string
  source: string
  sourceUrl: string | null
  eventDate: string
  ageDays: number
}

export type OpportunityRecommendation = {
  kind: RecommendationKind
  label: string
  /** One line: the move and the evidence it rests on. */
  headline: string
  /** Every reason, in order of weight. Never empty. */
  why: string[]
  citations: RecommendationCitation[]
  /** True when the move contacts the buyer (needs approval to go anywhere). */
  outreach: boolean
  urgency: 'HIGH' | 'MEDIUM' | 'LOW'
  priority: number
  /** For WAIT: how long, and when to look again. */
  waitDays: number | null
  revisitAt: string | null
  proofPoint: string | null
  nextSteps: string[]
  basis: { buyingStage: string; stance: string; nextBestAction: string }
}

export type RecommendationInput = {
  assessment: Omit<OpportunityAssessment, 'recommendation'>
  offer: Pick<OfferDefinition, 'proofPoints' | 'recommendedActions'>
  engagement?: EngagementStage | null
  now: number
}

/** Competition at or above this makes the incumbent worth researching first. */
const COMPETITIVE = 60
const WAIT_AFTER_CONTACT_DAYS = 7
const WAIT_FOR_TRIGGER_DAYS = 14
const MAX_CITATIONS = 3
const DAY = 86_400_000

const LABEL: Record<RecommendationKind, string> = {
  CONTACT_NOW: 'Contact now',
  WAIT: 'Wait',
  FIND_BUYER: 'Find the buyer',
  RESEARCH_INCUMBENT: 'Research the incumbent',
  SEND_CASE_STUDY: 'Send a case study',
  ASK_QUALIFYING_QUESTION: 'Ask a qualifying question',
  DONT_CONTACT: 'Don\'t contact',
  MONITOR: 'Monitor',
  ESCALATE: 'Escalate',
  RE_ENGAGE: 'Re-engage',
}

const STEP: Record<RecommendationKind, string> = {
  CONTACT_NOW: 'Reach the buyer about the triggering event',
  WAIT: 'Hold outreach until the revisit date, then reassess',
  FIND_BUYER: 'Identify and verify the decision maker before any outreach',
  RESEARCH_INCUMBENT: 'Find out who supplies them today and why they would switch',
  SEND_CASE_STUDY: 'Send the most relevant proof point',
  ASK_QUALIFYING_QUESTION: 'Ask one question that confirms the problem and who owns it',
  DONT_CONTACT: 'No outreach — keep the record for history',
  MONITOR: 'Keep watching for corroborating or fresher evidence',
  ESCALATE: 'Bring in the account owner to drive the decision',
  RE_ENGAGE: 'Reopen the conversation, tied to the new trigger',
}

function ageText(days: number): string {
  if (days <= 0) return 'today'
  return days === 1 ? '1 day ago' : `${days} days ago`
}

function lowerFirst(s: string): string {
  return /^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s
}

/** The trustworthy claims first, newest first; at most MAX_CITATIONS. */
export function citeEvidence(evidence: EvidenceClaim[], now: number): RecommendationCitation[] {
  return [...evidence]
    .sort((a, b) => Number(b.trustworthy) - Number(a.trustworthy) || Date.parse(b.eventDate) - Date.parse(a.eventDate))
    .slice(0, MAX_CITATIONS)
    .map(c => ({
      signalId: c.signalId,
      claim: c.claim,
      source: c.sourceKey || c.source,
      sourceUrl: c.sourceUrl,
      eventDate: c.eventDate,
      ageDays: Math.max(0, Math.floor((now - Date.parse(c.eventDate)) / DAY)),
    }))
}

type Choice = { kind: RecommendationKind; reason: string; waitDays?: number }

function choose(input: RecommendationInput): Choice {
  const a = input.assessment
  const stage = a.buyingStage
  const nba = a.recommendedAction
  const corroborated = a.gates.intelligenceTruth
  const trustworthy = a.trustworthySignals > 0
  const engagement = input.engagement ?? null

  if (stage === 'CUSTOMER') {
    return corroborated && a.urgency !== 'LOW'
      ? { kind: 'RE_ENGAGE', reason: 'An existing customer has a fresh, corroborated trigger — an expansion opening' }
      : { kind: 'MONITOR', reason: 'Already a customer — watch for repeat or expansion work' }
  }
  if (engagement === 'LOST') {
    return corroborated && (stage === 'ACTIVE_REQUIREMENT' || stage === 'EVALUATING_SOLUTIONS')
      ? { kind: 'RE_ENGAGE', reason: 'A previous opportunity was lost, but a new corroborated requirement has appeared' }
      : { kind: 'DONT_CONTACT', reason: 'A previous opportunity was lost — re-engage only on a new, corroborated trigger' }
  }
  if (stage === 'BUYING_DECISION') {
    return { kind: 'ESCALATE', reason: engagement === 'PROPOSAL' ? 'A proposal is with the buyer — the decision needs an owner' : 'A meeting has taken place — the buyer is deciding' }
  }
  if (stage === 'NO_DETECTABLE_NEED') return { kind: 'DONT_CONTACT', reason: 'No detectable need yet' }
  if (stage === 'EMERGING_TRIGGER') {
    return { kind: 'WAIT', waitDays: WAIT_FOR_TRIGGER_DAYS, reason: 'Only an emerging trigger so far — too early to sell' }
  }
  if (nba === 'MONITOR') return { kind: 'MONITOR', reason: a.actionReason }
  if (nba === 'HOLD') return { kind: 'MONITOR', reason: a.actionReason }
  if (nba === 'ENRICH') return { kind: 'FIND_BUYER', reason: a.actionReason }

  if (nba === 'CONTACT_NOW') {
    if (engagement === 'CONTACTED') {
      return { kind: 'WAIT', waitDays: WAIT_AFTER_CONTACT_DAYS, reason: 'Already contacted — give the buyer time before a follow-up' }
    }
    if (stage === 'EVALUATING_SOLUTIONS') {
      if (input.offer.proofPoints.length > 0) return { kind: 'SEND_CASE_STUDY', reason: 'The buyer is evaluating solutions — proof gets you shortlisted' }
      if (a.competition >= COMPETITIVE) return { kind: 'RESEARCH_INCUMBENT', reason: 'A contested evaluation and no proof point on file — know the incumbent first' }
    }
    return { kind: 'CONTACT_NOW', reason: a.actionReason }
  }

  // RESEARCH_CONTACT: plausible, but not yet contact-now (weak fit, uncorroborated, or stage-gated).
  if (!trustworthy) return { kind: 'MONITOR', reason: 'No trustworthy evidence to raise with the buyer yet' }
  if (corroborated && a.competition >= COMPETITIVE) {
    return { kind: 'RESEARCH_INCUMBENT', reason: 'Likely contested — understand the incumbent before reaching out' }
  }
  return { kind: 'ASK_QUALIFYING_QUESTION', reason: a.actionReason }
}

/**
 * The recommendation for one assessed opportunity, or null when it can't be
 * explained (gate 2).
 */
export function recommendForOpportunity(input: RecommendationInput): OpportunityRecommendation | null {
  const a = input.assessment
  const choice = choose(input)
  const kind = choice.kind
  const outreach = OUTREACH_KINDS.has(kind)
  const citations = citeEvidence(a.evidence, input.now)

  const why = [
    choice.reason,
    ...citations.map(c => `${c.claim} — ${ageText(c.ageDays)} (${c.source})`),
    ...a.buyingStageDetail.reasons,
    kind === 'FIND_BUYER' ? a.scorecard.contactability.reason : null,
    kind === 'RESEARCH_INCUMBENT' ? a.scorecard.competition.reason : null,
    outreach ? a.scorecard.timing.reason : null,
  ].filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
  const unique = [...new Set(why)]

  // Gate 2: no explanation, no recommendation; no contact without cited evidence.
  if (unique.length === 0 || !choice.reason.trim()) return null
  if (outreach && citations.length === 0) return null

  const label = kind === 'WAIT' ? `Wait ${choice.waitDays} days` : LABEL[kind]
  const cited = citations.slice(0, 2).map(c => `${lowerFirst(c.claim)} ${ageText(c.ageDays)}`)
  const headline = `${label}: ${cited.length ? cited.join(', ') : lowerFirst(choice.reason)}`
  const proofPoint = kind === 'SEND_CASE_STUDY' ? input.offer.proofPoints[0] ?? null : null
  const waitDays = choice.waitDays ?? null
  const quiet = kind === 'WAIT' || kind === 'MONITOR' || kind === 'DONT_CONTACT'

  return {
    kind,
    label,
    headline,
    why: unique,
    citations,
    outreach,
    urgency: quiet ? 'LOW' : a.urgency,
    priority: quiet ? Math.min(a.priority, 30) : a.priority,
    waitDays,
    revisitAt: waitDays != null ? new Date(input.now + waitDays * DAY).toISOString() : null,
    proofPoint,
    nextSteps: [
      STEP[kind],
      ...(proofPoint ? [`Proof point: ${proofPoint}`] : []),
      ...(outreach ? input.offer.recommendedActions.slice(0, 3) : []),
    ],
    basis: { buyingStage: a.buyingStage, stance: a.buyingStageDetail.play.stance, nextBestAction: a.recommendedAction },
  }
}
