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
import { scoreOpportunity, type OpportunityScorecard } from './opportunityScoring.js'
import { inferBuyingStage, type BuyingStageAssessment, type BuyingStageV2, type EngagementStage } from './buyingStage.js'
import { recommendForOpportunity, type OpportunityRecommendation } from './recommendationEngine.js'
import { eventKindWeight } from './signalCalibration.js'
import {
  assessSignalQuality, eventDate, signalVelocity, toRawFromCanonical,
  type CanonicalSignal, type SignalVelocity,
} from './signalIntelligence.js'

export type { EvidenceClaim } from './commercialEventEngine.js'
export { SINGLE_SOURCE_CONFIDENCE_CAP as UNCORROBORATED_CONFIDENCE_CAP } from './commercialEventEngine.js'

/** Where the buyer is in the buying process (buyingStage.ts). */
export type OpportunityBuyingStage = BuyingStageV2

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
  /** How hard the deal is to win, 0..100 (opportunityScoring.ts). */
  competition: number
  /** 0..100, log-scaled from the deal value. */
  valueScore: number
  estimatedValueMinCents: number | null
  estimatedValueMaxCents: number | null
  /** Mid deal value × probability; null when the value is unknown. */
  expectedValueCents: number | null
  /** 0..1 — confidence × offer fit, adjusted by intent, contactability and competition. */
  probability: number
  urgency: 'HIGH' | 'MEDIUM' | 'LOW'
  /** 0..100 — expected value × probability × urgency, normalised. */
  priority: number
  /** Every dimension with its reason. */
  scorecard: OpportunityScorecard
  buyingStage: OpportunityBuyingStage
  /** Stage confidence, reasons and the move that fits the stage. */
  buyingStageDetail: BuyingStageAssessment
  recommendedBuyer: string | null
  recommendedAction: NextBestAction['action']
  actionLabel: string
  actionReason: string
  blockers: string[]
  reasons: string[]
  evidence: EvidenceClaim[]
  velocity: SignalVelocity[]
  gates: { intelligenceTruth: boolean; decisionTruth: boolean }
  /** The explained move for this opportunity (recommendationEngine.ts); null when it can't be explained. */
  recommendation: OpportunityRecommendation | null
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
  /** Recorded engagement (Prospect.outcomeStage) — moves the buying stage on. */
  outcomeStage?: EngagementStage | null
}

export type AssessOpportunityInput = {
  prospect: OpportunityProspect
  signals: CanonicalSignal[]
  offer: OfferDefinition
  /** Pre-computed events for these signals (the store detects once per prospect). */
  events?: CommercialEventHypothesis[]
  /** Approved event-kind calibration weights (ScoringModel.eventKindWeights). */
  eventKindWeights?: Record<string, number> | null
  now?: number
}

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
    now,
  })
  let action: NextBestAction = nba
  const stage = inferBuyingStage({ events, engagement: prospect.outcomeStage })
  if (nba.action === 'CONTACT_NOW' && intelligenceTruth && !stage.outreachAppropriate) {
    // Stage gate: real evidence, but the buyer isn't at a stage where asking for
    // business fits — make the stage's move instead.
    action = {
      action: 'RESEARCH_CONTACT', label: stage.play.move, urgency: 'MEDIUM',
      reason: `The buyer looks to be at "${stage.stage.toLowerCase().replace(/_/g, ' ')}" — ${stage.play.messageGoal.toLowerCase()} before selling.`,
      blockers: [...nba.blockers, 'Buying stage is before an active requirement'],
    }
  }
  if (nba.action === 'CONTACT_NOW' && !intelligenceTruth) {
    action = {
      action: 'RESEARCH_CONTACT', label: 'Confirm the evidence before outreach', urgency: 'MEDIUM',
      reason: 'The opportunity looks real, but it rests on uncorroborated evidence — confirm it before contacting.',
      blockers: [...nba.blockers, 'Evidence is not yet corroborated by an independent source'],
    }
  }
  const decisionTruth = Boolean(action.reason) && reasons.length > 0

  const scorecard = scoreOpportunity({
    event: chosen,
    confidence,
    evidenceConfidence,
    offerFit: { score: offerEval.score, reason: offerEval.reasons[0] ?? 'No offer-fit evidence' },
    signalIntent: scores.intentScore,
    velocity,
    urgencyMatched: offerEval.urgencyMatched,
    contact: { name: prospect.contactName, email: prospect.contactEmail, title: prospect.contactTitle, targetTitles: offer.targetBuyerTitles },
    deal: { minCents: offer.dealValueMinCents, maxCents: offer.dealValueMaxCents, minimumCents: offer.minOpportunityValueCents },
    now,
    eventKindWeight: eventKindWeight(input.eventKindWeights, chosen.kind),
  })

  const assessment: Omit<OpportunityAssessment, 'recommendation'> = {
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
    intentScore: scorecard.intent.score,
    timingScore: scorecard.timing.score,
    contactability: scorecard.contactability.score,
    competition: scorecard.competition.score,
    valueScore: scorecard.value.score,
    estimatedValueMinCents: scorecard.value.rangeMinCents,
    estimatedValueMaxCents: scorecard.value.rangeMaxCents,
    expectedValueCents: scorecard.expectedValueCents,
    probability: scorecard.probability,
    urgency: scorecard.urgency,
    priority: scorecard.priority,
    scorecard,
    buyingStage: stage.stage,
    buyingStageDetail: stage,
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
  const recommendation = recommendForOpportunity({ assessment, offer, engagement: prospect.outcomeStage, now })
  return { ...assessment, recommendation }
}
