import type { SignalType } from '@acaos/shared'
import type { CommercialEvent, CommercialEventType } from './commercialEvent.js'
import type { RawSignal } from './signalEngine.js'

export type OfferProfile = {
  offer?: string | null
  targetCustomer?: string | null
  /** Optional explicit trigger phrases supplied by the mission. */
  triggerKeywords?: string[]
}

export type OfferFit = {
  score: number
  level: 'LOW' | 'MEDIUM' | 'HIGH'
  reasons: string[]
  matchedTerms: string[]
}

const EVENT_TERMS: Record<CommercialEventType, string[]> = {
  ACTIVE_PROCUREMENT: ['procurement', 'tender', 'rfp', 'rfq', 'contract', 'supplier', 'purchase', 'buy'],
  CAPACITY_EXPANSION: ['staff', 'workforce', 'capacity', 'labour', 'labor', 'crew', 'operations', 'delivery', 'field'],
  GROWTH_EVENT: ['growth', 'scale', 'expansion', 'funding', 'revenue', 'new location', 'new site'],
  ORGANISATIONAL_CHANGE: ['leadership', 'management', 'director', 'operations', 'restructure', 'supplier'],
  DIGITAL_CHANGE: ['software', 'technology', 'digital', 'automation', 'system', 'integration', 'platform'],
  MARKET_ATTENTION: ['market', 'brand', 'launch', 'announcement', 'growth'],
  EARLY_BUYING_TRIGGER: ['need', 'demand', 'growth', 'change', 'project', 'expansion'],
  NO_CLEAR_EVENT: [],
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'your', 'you', 'our', 'their', 'into',
  'help', 'helps', 'provide', 'provides', 'service', 'services', 'business', 'businesses',
  'company', 'companies', 'solution', 'solutions', 'offer', 'offering', 'customer', 'customers',
  'support', 'using', 'use', 'need', 'needs', 'more', 'than', 'will', 'can', 'are', 'has', 'have',
])

function tokens(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(/\s+/).filter(t => t.length >= 4 && !STOPWORDS.has(t))
}

function unique(values: string[]): string[] { return [...new Set(values)] }

/**
 * Conservative offer-to-evidence fit. It is intentionally lexical rather than
 * semantic/LLM-based: the score must be reproducible and must never invent an
 * offer fit from an opaque model call.
 */
export function scoreOfferFit(profile: OfferProfile, event: CommercialEvent, signals: RawSignal[]): OfferFit {
  const offerText = `${profile.offer ?? ''} ${profile.targetCustomer ?? ''}`.trim()
  if (!offerText) {
    return { score: 40, level: 'MEDIUM', reasons: ['No mission offer is defined yet — fit is intentionally neutral'], matchedTerms: [] }
  }

  const offerTokens = unique(tokens(offerText))
  const evidenceText = `${event.title} ${event.whyNow} ${event.supportingTypes.join(' ')} ${signals.map(s => `${s.title ?? ''} ${s.description ?? ''}`).join(' ')}`.toLowerCase()
  const matchedTerms = offerTokens.filter(t => evidenceText.includes(t))
  const triggerTerms = unique((profile.triggerKeywords ?? []).flatMap(tokens))
  const matchedTriggers = triggerTerms.filter(t => evidenceText.includes(t))
  const eventTerms = EVENT_TERMS[event.type] ?? []
  const eventMatches = eventTerms.filter(t => offerText.toLowerCase().includes(t))

  let score = 35
  score += Math.min(35, matchedTerms.length * 9)
  score += Math.min(20, matchedTriggers.length * 10)
  score += Math.min(10, eventMatches.length * 5)
  if (event.type === 'NO_CLEAR_EVENT') score -= 15
  if (signals.length >= 2) score += 5
  score = Math.max(0, Math.min(100, score))

  const reasons: string[] = []
  if (matchedTerms.length) reasons.push(`Offer language matches evidence: ${matchedTerms.slice(0, 4).join(', ')}`)
  if (matchedTriggers.length) reasons.push(`Mission trigger matched: ${matchedTriggers.slice(0, 4).join(', ')}`)
  if (eventMatches.length) reasons.push(`Offer is relevant to the ${event.title.toLowerCase()} event`)
  if (!reasons.length) reasons.push('No strong offer-to-evidence match was found')

  return { score, level: score >= 75 ? 'HIGH' : score >= 55 ? 'MEDIUM' : 'LOW', reasons, matchedTerms: unique([...matchedTerms, ...matchedTriggers]) }
}

/** Stronger than generic activity, but still deterministic and auditable. */
export function offerSignalAffinity(offer: OfferProfile, signals: RawSignal[]): number {
  if (!offer.offer || signals.length === 0) return 0
  const offerWords = new Set(tokens(offer.offer))
  const signalWords = unique(signals.flatMap(s => tokens(`${s.title ?? ''} ${s.description ?? ''}`)))
  return signalWords.filter(w => offerWords.has(w)).length
}

export const SIGNAL_TYPE_LABEL: Record<SignalType, string> = {
  FUNDING: 'funding', HIRING: 'hiring', EXPANSION: 'expansion', PROCUREMENT: 'procurement',
  TECH_ADOPTION: 'technology adoption', LEADERSHIP_CHANGE: 'leadership change', NEWS_MENTION: 'news',
  BUSINESS_REGISTRATION: 'business registration', WEBSITE_CHANGE: 'website change',
}
