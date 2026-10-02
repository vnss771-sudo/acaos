// Opportunity Scoring 2.0 — one generic 0–100 lead score is replaced by a
// scorecard of independent dimensions, each with its reason:
//
//   value · intent · timing · offer fit · evidence confidence · contactability · competition
//
// and the two numbers that rank the work:
//
//   probability = confidence × offer fit, adjusted by intent, contactability and competition
//   priority    = expected commercial value × probability × urgency   (normalised 0–100)
//
// Deterministic and explainable. Timing is measured from the assessment time,
// not the wall clock, so the same inputs always score the same.
import type { CommercialEventHypothesis, CommercialEventKind } from './commercialEventEngine.js'
import type { SignalVelocity } from './signalIntelligence.js'

const DAY_MS = 86_400_000

export type ValueBasis = 'OFFER_RANGE' | 'OFFER_MINIMUM' | 'UNKNOWN'
export type Urgency = 'HIGH' | 'MEDIUM' | 'LOW'

export type ScoreDimension = { score: number; reason: string }

export type OpportunityScorecard = {
  /** How valuable could this be? (0–100, log-scaled from the deal value.) */
  value: ScoreDimension & { basis: ValueBasis; rangeMinCents: number | null; rangeMaxCents: number | null; midCents: number | null }
  /** How likely are they to need something? */
  intent: ScoreDimension
  /** How soon? */
  timing: ScoreDimension
  /** How strongly does this match what the customer sells? */
  offerFit: ScoreDimension
  /** How certain is it that the underlying event is real? */
  evidenceConfidence: ScoreDimension
  /** Can we reach the right person? */
  contactability: ScoreDimension
  /** How hard is it to win? (0 = uncontested, 100 = fiercely contested.) */
  competition: ScoreDimension
  /** The approved event-kind calibration weight applied to probability (1 = none). */
  calibration: { weight: number; reason: string }
  /** 0..1 */
  probability: number
  urgency: Urgency
  /** Mid deal value × probability; null when the value is unknown. */
  expectedValueCents: number | null
  /** 0..100 */
  priority: number
}

export type ScorecardInput = {
  event: CommercialEventHypothesis
  /** Final confidence the event is real (0..100), after gate 1. */
  confidence: number
  evidenceConfidence: number
  offerFit: { score: number; reason: string }
  /** Signal-engine intent (decayed strength × reliability, corroboration-boosted), 0..100. */
  signalIntent: number
  velocity: SignalVelocity[]
  /** Offer urgency indicators found in the evidence. */
  urgencyMatched: string[]
  contact: { name?: string | null; email?: string | null; title?: string | null; targetTitles: string[] }
  deal: { minCents: number | null; maxCents: number | null; minimumCents: number | null }
  now: number
  /** Approved calibration weight for the event kind (signalCalibration.ts); 1 = neutral. */
  eventKindWeight?: number
}

/** How strongly each event family indicates a need, before evidence strength. */
const FAMILY_INTENT: Record<CommercialEventHypothesis['family'], number> = {
  ACTIVE_PROCUREMENT: 90, CAPACITY_EXPANSION: 80, GROWTH_EVENT: 65, ORGANISATIONAL_CHANGE: 55,
  DIGITAL_CHANGE: 55, MARKET_ATTENTION: 45, EARLY_BUYING_TRIGGER: 35,
}

/**
 * How contested each kind of event usually is. An open tender is a public,
 * competitive bid; a capacity shortage spotted early may have no other bidder.
 */
const KIND_COMPETITION: Record<CommercialEventKind, [number, string]> = {
  TENDER_OPPORTUNITY: [80, 'Open tender — a public, competitive bid'],
  CONTRACT_OPPORTUNITY: [60, 'Active procurement — other suppliers are likely being asked'],
  PROCUREMENT_CHANGE: [50, 'Supplier change — the incumbent and other challengers are in play'],
  NEW_PROJECT: [45, 'New project — subcontract work attracts several suppliers'],
  FUNDING_DEPLOYMENT: [45, 'Funding is public news — expect other vendors to approach'],
  GEOGRAPHIC_EXPANSION: [40, 'New location — local suppliers will compete'],
  TECHNOLOGY_REPLACEMENT: [40, 'System change — vendors are likely being compared'],
  REGULATORY_CHANGE: [40, 'Regulatory deadline — advisers across the market will pitch'],
  CAPACITY_EXPANSION: [35, 'Capacity need — often filled by whoever responds first'],
  HIRING_SURGE: [35, 'Hiring surge — support needs are rarely tendered'],
  CAPACITY_SHORTAGE: [30, 'Capacity shortage — urgent, little time to run a competitive process'],
  OPERATIONAL_DISRUPTION: [30, 'Disruption — speed beats process'],
  LEADERSHIP_RESET: [35, 'New leadership — relationships are being re-formed'],
  EARLY_TRIGGER: [25, 'Early signal — few competitors will have noticed yet'],
}

const URGENCY_FACTOR: Record<Urgency, number> = { HIGH: 1, MEDIUM: 0.7, LOW: 0.4 }
const PRIORITY_SCALE = 0.6

function clamp(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)))
}

function dollars(cents: number): string {
  const d = cents / 100
  return d >= 1_000_000 ? `$${(d / 1_000_000).toFixed(1).replace(/\.0$/, '')}M` : d >= 1000 ? `$${Math.round(d / 1000)}k` : `$${Math.round(d)}`
}

/** Log-scaled value score: $1k → 25, $10k → 50, $100k → 75, $1M+ → 100. */
export function valueScore(midCents: number | null): number {
  if (midCents == null || midCents <= 0) return 0
  return clamp(25 * Math.log10(Math.max(1, midCents / 100 / 100)))
}

/**
 * Priority weight for value: unknown value is neutral-low (0.75); known value
 * scales from 0.75 at $1k to 1.0 at $1M+, so value matters but can't swamp
 * probability and urgency.
 */
function valueFactor(midCents: number | null): number {
  if (midCents == null || midCents <= 0) return 0.75
  return Math.max(0.75, Math.min(1, 0.75 + 0.25 * (Math.log10(Math.max(1, midCents / 100 / 1000)) / 3)))
}

export function scoreOpportunity(input: ScorecardInput): OpportunityScorecard {
  const { event, deal, contact, now } = input

  // ── Value ────────────────────────────────────────────────────────────────
  const minV = deal.minCents
  const maxV = deal.maxCents ?? deal.minCents
  let basis: ValueBasis = 'UNKNOWN'
  let mid: number | null = null
  if (minV != null && maxV != null) {
    basis = 'OFFER_RANGE'
    mid = (minV + maxV) / 2
  } else if (deal.minimumCents != null) {
    basis = 'OFFER_MINIMUM'
    mid = deal.minimumCents
  }
  const value = {
    score: valueScore(mid), basis, rangeMinCents: minV, rangeMaxCents: maxV, midCents: mid,
    reason: basis === 'OFFER_RANGE' ? `Typical deal ${dollars(minV!)}–${dollars(maxV!)}`
      : basis === 'OFFER_MINIMUM' ? `At least ${dollars(mid!)} (the offer's minimum)`
      : 'Deal value unknown — set a typical deal value on the offer',
  }

  // ── Intent ───────────────────────────────────────────────────────────────
  const familyIntent = FAMILY_INTENT[event.family]
  const accelerating = input.velocity.filter(v => v.trend === 'ACCELERATING' || v.trend === 'NEW')
  const intentScore = clamp(familyIntent * 0.6 + input.signalIntent * 0.4 + Math.min(10, accelerating.length * 5))
  const intent = {
    score: intentScore,
    reason: `${event.title} indicates ${familyIntent >= 80 ? 'a strong' : familyIntent >= 55 ? 'a likely' : 'an early'} need`
      + (accelerating.length ? `; ${accelerating[0].summary.toLowerCase()}` : ''),
  }

  // ── Timing ───────────────────────────────────────────────────────────────
  const newest = Math.max(...event.evidence.map(c => Date.parse(c.eventDate)).filter(Number.isFinite), 0)
  const ageDays = newest > 0 ? Math.max(0, (now - newest) / DAY_MS) : Infinity
  let timingScore = ageDays < 3 ? 100 : ageDays < 7 ? 90 : ageDays < 14 ? 80 : ageDays < 30 ? 65 : ageDays < 60 ? 45 : ageDays < 90 ? 28 : 12
  if (input.urgencyMatched.length) timingScore = Math.min(100, timingScore + 10)
  const timing = {
    score: timingScore,
    reason: (Number.isFinite(ageDays) ? `Newest evidence ${Math.round(ageDays)} day${Math.round(ageDays) === 1 ? '' : 's'} old` : 'No dated evidence')
      + (input.urgencyMatched.length ? `; urgency: ${input.urgencyMatched.slice(0, 2).join(', ')}` : ''),
  }
  const urgency: Urgency = timingScore >= 80 ? 'HIGH' : timingScore >= 50 ? 'MEDIUM' : 'LOW'

  // ── Contactability ───────────────────────────────────────────────────────
  const titleMatch = Boolean(contact.title && contact.targetTitles.some(t => contact.title!.toLowerCase().includes(t.toLowerCase())))
  const contactScore = clamp((contact.email ? 55 : 0) + (contact.name ? 15 : 0) + (contact.title ? 10 : 0) + (titleMatch ? 20 : 0))
  const contactability = {
    score: contactScore,
    reason: !contact.email && !contact.name ? 'No contact yet — find the decision maker'
      : titleMatch ? `${contact.name ?? 'Contact'} (${contact.title}) is the target buyer`
      : contact.email ? `Reachable${contact.title ? ` via ${contact.title}` : ''}${contact.targetTitles.length ? `, but not yet the target buyer (${contact.targetTitles[0]})` : ''}`
      : 'Contact known but no email address',
  }

  // ── Competition ──────────────────────────────────────────────────────────
  const [competitionScore, competitionReason] = KIND_COMPETITION[event.kind]
  const competition = { score: competitionScore, reason: competitionReason }

  // ── Probability, expected value, priority ────────────────────────────────
  // Confidence × fit is the core; intent, contactability and competition
  // adjust it within bounded ranges so no single dimension dominates.
  const intentAdj = 0.7 + 0.3 * (intentScore / 100)           // 0.70 – 1.00
  const contactAdj = 0.8 + 0.2 * (contactScore / 100)         // 0.80 – 1.00
  const competitionAdj = 1 - 0.4 * (competitionScore / 100)   // 0.60 – 1.00
  // Calibration (phase 12): a human-approved, bounded weight for how often this
  // event kind has actually turned into wins in this workspace.
  const calibrationWeight = input.eventKindWeight ?? 1
  const probability = Math.min(1, Math.round((input.confidence / 100) * (input.offerFit.score / 100) * intentAdj * contactAdj * competitionAdj * calibrationWeight * 1000) / 1000)
  const expectedValueCents = mid != null ? Math.round(mid * probability) : null
  // Scaled so a 0.6 probability, high urgency, $1M+ opportunity is priority 100
  // (realistic probabilities top out around 0.8 after the competition adjustment).
  const priority = clamp(100 * probability * URGENCY_FACTOR[urgency] * valueFactor(mid) / PRIORITY_SCALE)

  return {
    value, intent, timing,
    offerFit: { score: clamp(input.offerFit.score), reason: input.offerFit.reason },
    evidenceConfidence: {
      score: clamp(input.evidenceConfidence),
      reason: event.corroborated
        ? `${event.independentSources} independent sources, ${event.trustworthySignals} trustworthy`
        : 'Not yet corroborated by an independent source',
    },
    contactability, competition, probability, urgency, expectedValueCents, priority,
    calibration: {
      weight: calibrationWeight,
      reason: calibrationWeight === 1
        ? 'No calibrated weight for this event kind'
        : `${event.kind.toLowerCase().replace(/_/g, ' ')} has ${calibrationWeight > 1 ? 'out' : 'under'}performed in this workspace (×${calibrationWeight})`,
    },
  }
}
