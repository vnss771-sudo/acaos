import type { CommercialEvent } from './commercialEvent.js'
import type { OfferFit } from './offerIntelligence.js'
import type { RawSignal } from './signalEngine.js'

export type NextBestAction = {
  action: 'CONTACT_NOW' | 'RESEARCH_CONTACT' | 'MONITOR' | 'ENRICH' | 'HOLD'
  label: string
  urgency: 'HIGH' | 'MEDIUM' | 'LOW'
  reason: string
  blockers: string[]
}

function ageDays(signals: RawSignal[], now: number): number {
  if (!signals.length) return Infinity
  return Math.max(0, (now - Math.max(...signals.map(s => s.detectedAt.getTime()))) / 86_400_000)
}

/**
 * Next-best-action policy. Conservative by design: weak offer fit or weak
 * evidence never turns into an aggressive outreach recommendation.
 */
export function chooseNextBestAction(args: {
  event: CommercialEvent
  offerFit: OfferFit
  signals: RawSignal[]
  hasContact: boolean
  hasEmail: boolean
  opportunityScore: number
  /** Assessment time; defaults to the clock for callers outside the engine. */
  now?: number
}): NextBestAction {
  const { event, offerFit, signals, hasContact, hasEmail, opportunityScore } = args
  const age = ageDays(signals, args.now ?? Date.now())
  const blockers: string[] = []

  if (event.type === 'NO_CLEAR_EVENT') blockers.push('No clear commercial event')
  if (event.confidence < 55) blockers.push('Commercial-event confidence is below 55%')
  if (offerFit.score < 55) blockers.push('Offer fit is below 55%')
  if (!hasContact) blockers.push('Decision-maker contact is unknown')
  if (!hasEmail) blockers.push('No email address is available')

  if (blockers.includes('No clear commercial event') || offerFit.score < 40) {
    return { action: 'MONITOR', label: 'Monitor for stronger evidence', urgency: 'LOW', reason: 'The evidence does not yet justify active pursuit.', blockers }
  }
  if (!hasContact || !hasEmail) {
    return { action: 'ENRICH', label: 'Find the right decision maker', urgency: 'MEDIUM', reason: 'The commercial case is plausible, but execution should wait for a reachable buyer.', blockers }
  }
  if (offerFit.score < 65 || event.confidence < 65) {
    return { action: 'RESEARCH_CONTACT', label: 'Research before outreach', urgency: 'MEDIUM', reason: 'There is a plausible opportunity, but the evidence is not strong enough for immediate contact.', blockers }
  }
  if (age <= 7 && offerFit.score >= 75 && event.confidence >= 75 && opportunityScore >= 70) {
    return { action: 'CONTACT_NOW', label: 'Contact now', urgency: 'HIGH', reason: 'Fresh, corroborated evidence strongly matches the mission offer.', blockers }
  }
  // Fit and confidence are both >= 65 here (the research gate above), so this
  // tier only checks timing; HOLD is reserved for evidence that has gone stale.
  if (age <= 30) {
    return { action: 'CONTACT_NOW', label: 'Contact this week', urgency: 'MEDIUM', reason: 'The opportunity is still timely and the evidence fits the offer.', blockers }
  }
  return { action: 'HOLD', label: 'Hold and watch for movement', urgency: 'LOW', reason: 'The opportunity may be real, but timing has cooled.', blockers }
}
