// Opportunity Engine — the commercial opportunity, not the lead, is the unit.
//
// assessOpportunity() turns one prospect's signals + one offer into either an
// explainable opportunity ("capacity expansion at ABC Electrical, 87% confident,
// 4 independent sources, 94% offer fit — contact the operations manager this
// week") or null when the evidence doesn't support one for that offer.
//
// Two gates are enforced here, not left to callers:
//   Gate 1 — intelligence truth: no corroborated, trustworthy evidence → no
//            high-confidence opportunity (confidence is capped).
//   Gate 2 — decision truth: every recommendation carries its reasons, and a
//            "contact now" can't stand on evidence that failed gate 1.
// Deterministic: the same inputs always produce the same assessment.
import { inferCommercialEvent, type CommercialEventType } from './commercialEvent.js'
import { chooseNextBestAction, type NextBestAction } from './nextBestAction.js'
import { evaluateOffer, offerTerms, type OfferDefinition } from './offerModel.js'
import { calculateOpportunityScores } from './signalEngine.js'
import {
  assessSignalQuality, eventDate, signalVelocity, sourceKey, toRawFromCanonical,
  type CanonicalSignal, type SignalQualityGrade, type SignalVelocity,
} from './signalIntelligence.js'

/** Mirrors commercialEvent.ts: only evidence from the last 30 days supports an event. */
const EVENT_WINDOW_DAYS = 30
const DAY_MS = 86_400_000

/** Gate 1: below this, an opportunity can't be reported as high-confidence. */
export const MIN_INDEPENDENT_SOURCES_FOR_HIGH_CONFIDENCE = 2
export const UNCORROBORATED_CONFIDENCE_CAP = 60
const MAX_EVIDENCE_CLAIMS = 10

/**
 * Where the buyer is in the buying process, inferred from the event. Provisional
 * (a rules mapping) until outcome data can calibrate it.
 */
export type OpportunityBuyingStage =
  | 'EMERGING_TRIGGER' | 'PROBLEM_LIKELY' | 'ACTIVE_REQUIREMENT' | 'EVALUATING_SOLUTIONS'

export type EvidenceClaim = {
  signalId: string | null
  type: CanonicalSignal['type']
  title: string | null
  source: string
  sourceUrl: string | null
  eventDate: string
  quality: number
  grade: SignalQualityGrade
  trustworthy: boolean
}

export type OpportunityAssessment = {
  offerKey: string
  offerId: string | null
  missionId: string | null
  eventType: Exclude<CommercialEventType, 'NO_CLEAR_EVENT'>
  eventTitle: string
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
  now?: number
}

function stageFor(eventType: CommercialEventType, confidence: number): OpportunityBuyingStage {
  switch (eventType) {
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

export function assessOpportunity(input: AssessOpportunityInput): OpportunityAssessment | null {
  const { prospect, signals, offer } = input
  const now = input.now ?? Date.now()
  const terms = offerTerms(offer)

  const qualities = new Map(signals.map(s => [s, assessSignalQuality(s, { all: signals, offerTerms: terms, now })]))
  const usable = signals.filter(s => qualities.get(s)!.grade !== 'UNUSABLE')
  const event = inferCommercialEvent(usable.map(toRawFromCanonical), now)
  if (event.type === 'NO_CLEAR_EVENT') return null

  const supporting = usable.filter(s =>
    event.supportingTypes.includes(s.type) && now - eventDate(s).getTime() <= EVENT_WINDOW_DAYS * DAY_MS,
  )
  const offerEval = evaluateOffer(offer, { event, signals: supporting, prospect })
  // A disqualified offer has no opportunity here, however strong the event.
  if (offerEval.disqualifiedBy.length > 0) return null

  const reasons: string[] = [event.whyNow]

  // ── Gate 1: intelligence truth ────────────────────────────────────────────
  const independentSources = new Set(supporting.map(sourceKey)).size
  const trustworthySignals = supporting.filter(s => qualities.get(s)!.trustworthy).length
  const avgQuality = supporting.reduce((a, s) => a + qualities.get(s)!.overall, 0) / Math.max(1, supporting.length)
  const corroborationFactor = independentSources >= 3 ? 1.1 : independentSources === 2 ? 1 : 0.8
  const evidenceConfidence = Math.round(Math.min(100, avgQuality * corroborationFactor))
  const intelligenceTruth = independentSources >= MIN_INDEPENDENT_SOURCES_FOR_HIGH_CONFIDENCE && trustworthySignals >= 1
  let confidence = Math.round(Math.sqrt(event.confidence * evidenceConfidence))
  if (!intelligenceTruth) {
    confidence = Math.min(confidence, UNCORROBORATED_CONFIDENCE_CAP)
    reasons.push(trustworthySignals === 0
      ? 'No trustworthy evidence yet — confidence capped until it is corroborated'
      : 'Single-source evidence — confidence capped until an independent source confirms it')
  } else {
    reasons.push(`${independentSources} independent sources, ${trustworthySignals} trustworthy signal${trustworthySignals === 1 ? '' : 's'}`)
  }

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
    event: { ...event, confidence },
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

  const evidence: EvidenceClaim[] = [...supporting]
    .sort((a, b) => qualities.get(b)!.overall - qualities.get(a)!.overall)
    .slice(0, MAX_EVIDENCE_CLAIMS)
    .map(s => {
      const q = qualities.get(s)!
      return {
        signalId: s.id, type: s.type, title: s.title, source: s.source,
        sourceUrl: s.evidence?.sourceUrl ?? s.sourceUrl, eventDate: eventDate(s).toISOString(),
        quality: q.overall, grade: q.grade, trustworthy: q.trustworthy,
      }
    })

  return {
    offerKey: offer.key,
    offerId: offer.id,
    missionId: offer.missionId,
    eventType: event.type as OpportunityAssessment['eventType'],
    eventTitle: event.title,
    whyNow: event.whyNow,
    confidence,
    evidenceConfidence,
    independentSources,
    trustworthySignals,
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
    buyingStage: stageFor(event.type, confidence),
    recommendedBuyer: offer.targetBuyerTitles[0] ?? prospect.contactTitle ?? null,
    recommendedAction: action.action,
    actionLabel: action.label,
    actionReason: action.reason,
    blockers: action.blockers,
    reasons,
    evidence,
    velocity,
    gates: { intelligenceTruth, decisionTruth },
  }
}
