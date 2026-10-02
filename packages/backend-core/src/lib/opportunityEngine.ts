// Opportunity Engine — the commercial opportunity, not the lead, is the unit.
//
// assessOpportunity() turns one prospect's signals + one offer into either an
// explainable opportunity ("capacity expansion at ABC Electrical, 87% confident,
// 4 independent sources, 94% offer fit — contact the operations manager this
// week") or null when the evidence doesn't support one for that offer.
//
// Events come from the commercial event engine (commercialEventEngine.ts); the
// opportunity is built on the strongest event the offer is triggered by (else
// the strongest event), and carries that event's evidence claims.
//
// Two gates are enforced here, not left to callers:
//   Gate 1 — intelligence truth: no corroborated, trustworthy evidence → no
//            high-confidence opportunity (the event engine caps confidence).
//   Gate 2 — decision truth: every recommendation carries its reasons, and a
//            "contact now" can't stand on evidence that failed gate 1.
// Deterministic: the same inputs always produce the same assessment.
import {
  detectCommercialEvents, eventMatchesTriggers, toCommercialEvent,
  type CommercialEventHypothesis, type CommercialEventKind, type EventFamily, type EvidenceClaim,
} from './commercialEventEngine.js'
import { chooseNextBestAction, type NextBestAction } from './nextBestAction.js'
import { evaluateOffer, offerTerms, type OfferDefinition } from './offerModel.js'
import { calculateOpportunityScores } from './signalEngine.js'
import {
  assessSignalQuality, eventDate, signalVelocity, toRawFromCanonical,
  type CanonicalSignal, type SignalVelocity,
} from './signalIntelligence.js'

export type { EvidenceClaim } from './commercialEventEngine.js'
export { SINGLE_SOURCE_CONFIDENCE_CAP as UNCORROBORATED_CONFIDENCE_CAP } from './commercialEventEngine.js'

/**
 * Where the buyer is in the buying process, inferred from the event family.
 * Provisional (a rules mapping) until outcome data can calibrate it.
 */
export type OpportunityBuyingStage =
  | 'EMERGING_TRIGGER' | 'PROBLEM_LIKELY' | 'ACTIVE_REQUIREMENT' | 'EVALUATING_SOLUTIONS'

export type OpportunityAssessment = {
  offerKey: string
  offerId: string | null
  missionId: string | null
  /** The specific event kind, e.g. TENDER_OPPORTUNITY. */
  eventType: CommercialEventKind
  eventFamily: EventFamily
  eventTitle: string
  implication: string
  whyNow: string
  /** Final confidence (0..100) that the opportunity is real, after gate 1. */
  confidence: number
  evidenceConfidence: number
  independentSources: number
  trustworthySignals: number
  offerFit: number
  offerFitLevel: 'LOW' | 'MEDIUM' | 'HIGH'
  intentScore: number
  timingScore: number
  contactability: number
  estimatedValueMinCents: number | null
  estimatedValueMaxCents: number | null
  /** 0..1 — confidence × offer fit. */
  probability: number
  urgency: 'HIGH' | 'MEDIUM' | 'LOW'
  /** 0..100 — expected value × probability × urgency, normalised. */
  priority: number
  buyingStage: OpportunityBuyingStage
  recommendedBuyer: string | null
  recommendedAction: NextBestAction['action']
  actionLabel: string
  actionReason: string
  blockers: string[]
  reasons: string[]
  evidence: EvidenceClaim[]
  velocity: SignalVelocity[]
  gates: { intelligenceTruth: boolean; decisionTruth: boolean }
}

export type OpportunityProspect = {
  id: string
  companyName: string
  industry?: string | null
  employeeCount?: number | null
  location?: string | null
  description?: string | null
  domain?: string | null
  contactName?: string | null
  contactEmail?: string | null
  contactTitle?: string | null
}

export type AssessOpportunityInput = {
  prospect: OpportunityProspect
  signals: CanonicalSignal[]
  offer: OfferDefinition
  /** Pre-computed events for these signals (the store detects once per prospect). */
  events?: CommercialEventHypothesis[]
  now?: number
}

function stageFor(family: EventFamily, confidence: number): OpportunityBuyingStage {
  switch (family) {
    case 'ACTIVE_PROCUREMENT': return 'EVALUATING_SOLUTIONS'
    case 'CAPACITY_EXPANSION': return confidence >= 75 ? 'ACTIVE_REQUIREMENT' : 'PROBLEM_LIKELY'
    case 'GROWTH_EVENT':
    case 'ORGANISATIONAL_CHANGE':
    case 'DIGITAL_CHANGE': return 'PROBLEM_LIKELY'
    default: return 'EMERGING_TRIGGER'
  }
}

function contactabilityOf(p: OpportunityProspect): number {
  let c = 0
  if (p.contactEmail) c += 60
  if (p.contactName) c += 20
  if (p.contactTitle) c += 20
  return c
}

/**
 * Value weighting for priority: unknown value is neutral-low (0.75); a known
 * value scales logarithmically from 0.75 at $1k to 1.0 at $1M+, so value matters
 * but can't swamp probability and urgency.
 */
function valueFactor(midCents: number | null): number {
  if (midCents == null || midCents <= 0) return 0.75
  const dollars = midCents / 100
  return Math.max(0.75, Math.min(1, 0.75 + 0.25 * (Math.log10(Math.max(1, dollars / 1000)) / 3)))
}

const URGENCY_FACTOR = { HIGH: 1, MEDIUM: 0.7, LOW: 0.4 } as const

/** How far back company evidence can disqualify an offer ("in liquidation"). */
const DISQUALIFIER_WINDOW_DAYS = 180

/** The event an offer is assessed on: the strongest it's triggered by, else the strongest. */
export function selectEventForOffer(events: CommercialEventHypothesis[], offer: OfferDefinition): CommercialEventHypothesis | null {
  if (events.length === 0) return null
  if (offer.triggeringEvents.length === 0) return events[0]
  return events.find(e => eventMatchesTriggers(e, offer.triggeringEvents)) ?? events[0]
}

export function assessOpportunity(input: AssessOpportunityInput): OpportunityAssessment | null {
  const { prospect, signals, offer } = input
  const now = input.now ?? Date.now()
  const events = input.events ?? detectCommercialEvents(signals, { now })
  const chosen = selectEventForOffer(events, offer)
  if (!chosen) return null

  const ids = new Set(chosen.evidence.map(c => c.signalId))
  const supporting = signals.filter(s => s.id != null && ids.has(s.id))
  const event = toCommercialEvent(chosen)
  const recent = signals.filter(s => now - eventDate(s).getTime() <= DISQUALIFIER_WINDOW_DAYS * 86_400_000)
  const offerEval = evaluateOffer(offer, { event, kind: chosen.kind, signals: supporting, prospect, disqualifierSignals: recent })
  // A disqualified offer has no opportunity here, however strong the event.
  if (offerEval.disqualifiedBy.length > 0) return null

  const reasons: string[] = [chosen.implication, chosen.whyNow]

  // ── Gate 1: intelligence truth (confidence already capped by the event engine) ──
  const terms = offerTerms(offer)
  const qualities = supporting.map(s => assessSignalQuality(s, { all: signals, offerTerms: terms, now }))
  const avgQuality = qualities.reduce((a, q) => a + q.overall, 0) / Math.max(1, qualities.length)
  const corroborationFactor = chosen.independentSources >= 3 ? 1.1 : chosen.independentSources === 2 ? 1 : 0.8
  const evidenceConfidence = Math.round(Math.min(100, avgQuality * corroborationFactor))
  const intelligenceTruth = chosen.corroborated
  const confidence = chosen.confidence
  if (!intelligenceTruth) {
    reasons.push(chosen.trustworthySignals === 0
      ? 'No trustworthy evidence yet — confidence capped until it is corroborated'
      : 'Single-source evidence — confidence capped until an independent source confirms it')
  }
  const others = events.filter(e => e !== chosen).slice(0, 3)
  if (others.length) reasons.push(`Also detected: ${others.map(e => `${e.title.toLowerCase()} (${e.confidence}%)`).join(', ')}`)

  const velocity = signalVelocity(signals, { now })
  for (const v of velocity) if (v.trend === 'ACCELERATING' || v.trend === 'NEW') reasons.push(v.summary)

  reasons.push(...offerEval.reasons)

  const raw = supporting.map(toRawFromCanonical)
  const scores = calculateOpportunityScores(raw, {
    industry: prospect.industry, employeeCount: prospect.employeeCount, contactEmail: prospect.contactEmail,
    contactName: prospect.contactName, domain: prospect.domain, location: prospect.location,
  })

  // ── Gate 2: decision truth ────────────────────────────────────────────────
  const nba = chooseNextBestAction({
    event,
    offerFit: { score: offerEval.score, level: offerEval.level, reasons: offerEval.reasons, matchedTerms: offerEval.matchedTerms },
    signals: raw,
    hasContact: Boolean(prospect.contactName || prospect.contactTitle),
    hasEmail: Boolean(prospect.contactEmail),
    opportunityScore: scores.opportunityScore,
  })
  let action: NextBestAction = nba
  if (nba.action === 'CONTACT_NOW' && !intelligenceTruth) {
    action = {
      action: 'RESEARCH_CONTACT', label: 'Confirm the evidence before outreach', urgency: 'MEDIUM',
      reason: 'The opportunity looks real, but it rests on uncorroborated evidence — confirm it before contacting.',
      blockers: [...nba.blockers, 'Evidence is not yet corroborated by an independent source'],
    }
  }
  const decisionTruth = Boolean(action.reason) && reasons.length > 0

  const timingScore = scores.timingScore
  const urgency: OpportunityAssessment['urgency'] = timingScore >= 80 ? 'HIGH' : timingScore >= 50 ? 'MEDIUM' : 'LOW'
  const probability = Math.round((confidence / 100) * (offerEval.score / 100) * 1000) / 1000
  const minV = offer.dealValueMinCents
  const maxV = offer.dealValueMaxCents ?? offer.dealValueMinCents
  const mid = minV != null && maxV != null ? (minV + maxV) / 2 : maxV ?? minV ?? null
  const priority = Math.round(100 * probability * URGENCY_FACTOR[urgency] * valueFactor(mid))

  return {
    offerKey: offer.key,
    offerId: offer.id,
    missionId: offer.missionId,
    eventType: chosen.kind,
    eventFamily: chosen.family,
    eventTitle: chosen.title,
    implication: chosen.implication,
    whyNow: chosen.whyNow,
    confidence,
    evidenceConfidence,
    independentSources: chosen.independentSources,
    trustworthySignals: chosen.trustworthySignals,
    offerFit: offerEval.score,
    offerFitLevel: offerEval.level,
    intentScore: scores.intentScore,
    timingScore,
    contactability: contactabilityOf(prospect),
    estimatedValueMinCents: minV,
    estimatedValueMaxCents: maxV,
    probability,
    urgency,
    priority,
    buyingStage: stageFor(chosen.family, confidence),
    recommendedBuyer: offer.targetBuyerTitles[0] ?? prospect.contactTitle ?? null,
    recommendedAction: action.action,
    actionLabel: action.label,
    actionReason: action.reason,
    blockers: action.blockers,
    reasons,
    evidence: chosen.evidence,
    velocity,
    gates: { intelligenceTruth, decisionTruth },
  }
}
