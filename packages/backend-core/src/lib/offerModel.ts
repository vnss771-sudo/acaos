// Offer Intelligence — an explicit model of what the customer sells, so the same
// company can be a strong opportunity for one offer and none for another.
//
// A structured Offer (the Offer table) is evaluated against a commercial event
// and its evidence: does the event trigger this offer, does the evidence carry
// the offer's qualifying language, does anything disqualify it, is it in the
// offer's geography. A mission with only free-text offer fields falls back to the
// phase-3 lexical fit (offerIntelligence.ts), so existing missions behave as before.
// Deterministic: no model call participates.
import type { CommercialEvent, CommercialEventType } from './commercialEvent.js'
import { scoreOfferFit } from './offerIntelligence.js'
import { textTerms, toRawFromCanonical, type CanonicalSignal } from './signalIntelligence.js'

export const COMMERCIAL_EVENT_TYPES: readonly CommercialEventType[] = [
  'ACTIVE_PROCUREMENT', 'CAPACITY_EXPANSION', 'GROWTH_EVENT', 'ORGANISATIONAL_CHANGE',
  'DIGITAL_CHANGE', 'MARKET_ATTENTION', 'EARLY_BUYING_TRIGGER',
] as const

export type OfferDefinition = {
  /** Stable key an opportunity is filed under: `offer:<id>` or `mission:<id>`. */
  key: string
  /** Offer row id; null for an offer synthesised from a mission's free text. */
  id: string | null
  missionId: string | null
  /** False for a mission's free-text offer: evaluated by the phase-3 lexical fit. */
  structured: boolean
  name: string
  problemSolved: string | null
  /** Who the offer is for, in words (e.g. "electrical contractors"). */
  targetCustomer: string | null
  targetBuyerTitles: string[]
  /** Events that create demand for this offer. Empty = any clear event. */
  triggeringEvents: CommercialEventType[]
  qualifyingKeywords: string[]
  disqualifyingKeywords: string[]
  /** Where the offer is sold (state codes, cities, regions). Empty = anywhere. */
  geographies: string[]
  minOpportunityValueCents: number | null
  dealValueMinCents: number | null
  dealValueMaxCents: number | null
  urgencyIndicators: string[]
  proofPoints: string[]
  recommendedActions: string[]
}

export type OfferRow = {
  id: string
  missionId: string | null
  name: string
  problemSolved: string | null
  targetCustomer: string | null
  targetBuyerTitles: string[]
  triggeringEvents: string[]
  qualifyingKeywords: string[]
  disqualifyingKeywords: string[]
  geographies: string[]
  minOpportunityValueCents: number | null
  dealValueMinCents: number | null
  dealValueMaxCents: number | null
  urgencyIndicators: string[]
  proofPoints: string[]
  recommendedActions: string[]
}

export function offerFromRow(row: OfferRow): OfferDefinition {
  const events = new Set<string>(COMMERCIAL_EVENT_TYPES)
  return {
    key: `offer:${row.id}`,
    id: row.id,
    missionId: row.missionId,
    structured: true,
    name: row.name,
    problemSolved: row.problemSolved,
    targetCustomer: row.targetCustomer,
    targetBuyerTitles: row.targetBuyerTitles,
    triggeringEvents: row.triggeringEvents.filter((e): e is CommercialEventType => events.has(e)),
    qualifyingKeywords: row.qualifyingKeywords,
    disqualifyingKeywords: row.disqualifyingKeywords,
    geographies: row.geographies,
    minOpportunityValueCents: row.minOpportunityValueCents,
    dealValueMinCents: row.dealValueMinCents,
    dealValueMaxCents: row.dealValueMaxCents,
    urgencyIndicators: row.urgencyIndicators,
    proofPoints: row.proofPoints,
    recommendedActions: row.recommendedActions,
  }
}

/** A mission's free-text offer as an (unstructured) OfferDefinition. */
export function offerFromMission(m: { id: string; name: string; offer: string | null; targetCustomer: string | null }): OfferDefinition {
  return {
    key: `mission:${m.id}`,
    id: null,
    missionId: m.id,
    structured: false,
    name: m.offer?.trim() || m.name,
    problemSolved: m.offer,
    targetCustomer: m.targetCustomer,
    targetBuyerTitles: [],
    triggeringEvents: [],
    qualifyingKeywords: [],
    disqualifyingKeywords: [],
    geographies: [],
    minOpportunityValueCents: null,
    dealValueMinCents: null,
    dealValueMaxCents: null,
    urgencyIndicators: [],
    proofPoints: [],
    recommendedActions: [],
  }
}

/** Terms describing what the offer sells — what signal-level offer fit matches on. */
export function offerTerms(offer: OfferDefinition): string[] {
  return textTerms([offer.name, offer.problemSolved ?? '', offer.targetCustomer ?? '', ...offer.qualifyingKeywords].join(' '))
}

export type OfferEvaluation = {
  score: number
  level: 'LOW' | 'MEDIUM' | 'HIGH'
  /** null when the offer names no triggering events. */
  eventTriggered: boolean | null
  matchedQualifying: string[]
  matchedTerms: string[]
  disqualifiedBy: string[]
  /** null when the offer has no geography or the prospect's location is unknown. */
  geoMatch: boolean | null
  urgencyMatched: string[]
  reasons: string[]
}

export type OfferProspect = {
  industry?: string | null
  location?: string | null
  description?: string | null
}

/** Whole-phrase, case-insensitive match (so "pool" doesn't match "liverpool"). */
export function containsPhrase(text: string, phrase: string): boolean {
  const p = phrase.trim().toLowerCase()
  if (!p) return false
  const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`).test(text)
}

function level(score: number): OfferEvaluation['level'] {
  return score >= 75 ? 'HIGH' : score >= 55 ? 'MEDIUM' : 'LOW'
}

export function evaluateOffer(
  offer: OfferDefinition,
  input: { event: CommercialEvent; signals: CanonicalSignal[]; prospect: OfferProspect },
): OfferEvaluation {
  const { event, signals, prospect } = input
  const evidenceText = [
    ...signals.map(s => `${s.title ?? ''} ${s.description ?? ''}`),
    prospect.description ?? '', prospect.industry ?? '',
  ].join(' ').toLowerCase()

  // Disqualifiers and geography apply to both kinds of offer.
  const disqualifiedBy = offer.disqualifyingKeywords.filter(k => containsPhrase(evidenceText, k))
  const location = (prospect.location ?? '').toLowerCase()
  const geoMatch = offer.geographies.length === 0 || !location.trim()
    ? null
    : offer.geographies.some(g => containsPhrase(location, g))

  if (!offer.structured) {
    const fit = scoreOfferFit({ offer: offer.problemSolved, targetCustomer: offer.targetCustomer }, event, signals.map(toRawFromCanonical))
    return { score: fit.score, level: fit.level, eventTriggered: null, matchedQualifying: [], matchedTerms: fit.matchedTerms, disqualifiedBy, geoMatch, urgencyMatched: [], reasons: fit.reasons }
  }

  const reasons: string[] = []
  let score = 30

  let eventTriggered: boolean | null = null
  if (event.type === 'NO_CLEAR_EVENT') {
    score -= 15
    reasons.push('No clear commercial event to trigger this offer')
  } else if (offer.triggeringEvents.length > 0) {
    eventTriggered = offer.triggeringEvents.includes(event.type)
    if (eventTriggered) {
      score += 25
      reasons.push(`${event.title} is a triggering event for ${offer.name}`)
    } else {
      score -= 10
      reasons.push(`${event.title} is not one of this offer's triggering events`)
    }
  }

  const matchedQualifying = offer.qualifyingKeywords.filter(k => containsPhrase(evidenceText, k))
  score += Math.min(30, matchedQualifying.length * 10)
  if (matchedQualifying.length) reasons.push(`Qualifying evidence: ${matchedQualifying.slice(0, 4).join(', ')}`)

  const words = new Set(textTerms(evidenceText))
  const matchedTerms = textTerms(`${offer.name} ${offer.problemSolved ?? ''}`).filter(t => words.has(t))
  score += Math.min(15, matchedTerms.length * 5)
  if (matchedTerms.length) reasons.push(`Evidence mentions the problem this offer solves: ${matchedTerms.slice(0, 4).join(', ')}`)

  const urgencyMatched = offer.urgencyIndicators.filter(k => containsPhrase(evidenceText, k))
  score += Math.min(10, urgencyMatched.length * 5)
  if (urgencyMatched.length) reasons.push(`Urgency indicators present: ${urgencyMatched.slice(0, 3).join(', ')}`)

  if (geoMatch === true) {
    score += 5
    reasons.push('Within the offer\'s geography')
  }
  score = Math.max(0, Math.min(100, score))

  // Hard outs: a disqualifier or a location outside the offer's geography caps
  // the fit — no amount of matching language turns those into a good fit.
  if (geoMatch === false) {
    score = Math.min(score, 20)
    reasons.push(`Outside the offer's geography (${offer.geographies.join(', ')})`)
  }
  if (disqualifiedBy.length) {
    score = Math.min(score, 10)
    reasons.push(`Disqualified: ${disqualifiedBy.slice(0, 3).join(', ')}`)
  }
  if (!reasons.length) reasons.push('No strong offer-to-evidence match was found')

  return { score, level: level(score), eventTriggered, matchedQualifying, matchedTerms, disqualifiedBy, geoMatch, urgencyMatched, reasons }
}
