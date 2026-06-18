// Signal intelligence engine — decay functions, opportunity scoring, buying stage detection

export type SignalType =
  | 'HIRING' | 'FUNDING' | 'EXPANSION' | 'TECH_ADOPTION' | 'LEADERSHIP_CHANGE'
  | 'NEWS_MENTION' | 'PROCUREMENT' | 'BUSINESS_REGISTRATION' | 'WEBSITE_CHANGE'

export type BuyingStage = 'RESEARCHING' | 'EVALUATING' | 'COMPARING' | 'PURCHASING' | 'INACTIVE'
export type OutcomeStage = 'DISCOVERED' | 'VIEWED' | 'CONTACTED' | 'MEETING' | 'PROPOSAL' | 'WON' | 'LOST'

// Exponential decay rates: strength × e^(-rate × ageDays)
// Derived from spec: FUNDING Day30=70%, Day90=25%
const SIGNAL_DECAY_RATES: Record<SignalType, number> = {
  FUNDING: 0.013,
  HIRING: 0.012,
  LEADERSHIP_CHANGE: 0.010,
  EXPANSION: 0.011,
  TECH_ADOPTION: 0.009,
  NEWS_MENTION: 0.020,
  PROCUREMENT: 0.007,
  BUSINESS_REGISTRATION: 0.006,
  WEBSITE_CHANGE: 0.025,
}

// Base event weights from spec (used as multiplier caps)
export const EVENT_BASE_WEIGHTS: Record<SignalType, number> = {
  FUNDING: 95,
  HIRING: 85,
  PROCUREMENT: 90,
  EXPANSION: 75,
  TECH_ADOPTION: 70,
  LEADERSHIP_CHANGE: 65,
  BUSINESS_REGISTRATION: 55,
  NEWS_MENTION: 50,
  WEBSITE_CHANGE: 40,
}

export type RawSignal = {
  type: SignalType
  strength: number
  sourceReliability: number
  industryRelevance: number
  detectedAt: Date
}

// Decayed signal strength accounting for age
export function decayedStrength(signal: RawSignal): number {
  const ageDays = (Date.now() - signal.detectedAt.getTime()) / 86_400_000
  const rate = SIGNAL_DECAY_RATES[signal.type] ?? 0.01
  return signal.strength * Math.exp(-rate * ageDays)
}

// User-facing freshness state for a signal, derived from the same per-type
// exponential decay used in scoring (so the label always agrees with the score).
// `remaining` is the fraction of original strength still left after age decay.
export type Freshness = 'LIVE' | 'RECENT' | 'STALE' | 'EXPIRED'
export function freshnessState(
  signal: Pick<RawSignal, 'type' | 'detectedAt'>,
  now: number = Date.now()
): Freshness {
  const ageDays = Math.max(0, (now - signal.detectedAt.getTime()) / 86_400_000)
  const rate = SIGNAL_DECAY_RATES[signal.type] ?? 0.01
  const remaining = Math.exp(-rate * ageDays) // 1.0 (just observed) → 0 (ancient)
  if (remaining >= 0.85) return 'LIVE'
  if (remaining >= 0.5) return 'RECENT'
  if (remaining >= 0.2) return 'STALE'
  return 'EXPIRED'
}

export type CorroborationLevel = 'none' | 'single' | 'promising' | 'urgent'

/** Count of DISTINCT signal types on a company (repeats of one type don't corroborate). */
export function distinctSignalTypes(signals: RawSignal[]): number {
  return new Set(signals.map((s) => s.type)).size
}

/**
 * Corroboration: multiple *different* signals pointing at the same company are
 * far stronger evidence than repeats of one. 1 type = interesting, 2 = promising,
 * 3+ = urgent. Used to label opportunities and to boost intent.
 */
export function corroborationLevel(signals: RawSignal[]): { distinctTypes: number; level: CorroborationLevel } {
  const distinctTypes = distinctSignalTypes(signals)
  const level: CorroborationLevel =
    distinctTypes === 0 ? 'none' : distinctTypes === 1 ? 'single' : distinctTypes === 2 ? 'promising' : 'urgent'
  return { distinctTypes, level }
}

// Multiplier applied to intent — bounded, and a multiplier (not additive) so a
// zero intent (e.g. sourceReliability 0) stays zero.
function corroborationMultiplier(signals: RawSignal[]): number {
  const n = distinctSignalTypes(signals)
  if (n >= 4) return 1.3
  if (n === 3) return 1.22
  if (n === 2) return 1.12
  return 1.0
}

// Intent score: how strongly this company is showing buying intent
function calcIntentScore(signals: RawSignal[], signalWeights?: SignalWeights): number {
  if (signals.length === 0) return 0
  const scores = signals.map(sig => {
    const ds = decayedStrength(sig)
    const cap = signalWeights?.[sig.type] ?? EVENT_BASE_WEIGHTS[sig.type]
    return Math.min(ds * (sig.sourceReliability / 100), cap)
  })
  scores.sort((a, b) => b - a)
  const primary = scores[0]
  const bonus = scores.slice(1).reduce((acc, s) => acc + s * 0.25, 0)
  return Math.min(100, (primary + bonus) * corroborationMultiplier(signals))
}

// Timing score: freshness of signals
function calcTimingScore(signals: RawSignal[]): number {
  if (signals.length === 0) return 10
  const mostRecentMs = Math.max(...signals.map(s => s.detectedAt.getTime()))
  const ageDays = (Date.now() - mostRecentMs) / 86_400_000
  if (ageDays < 3) return 100
  if (ageDays < 7) return 90
  if (ageDays < 14) return 80
  if (ageDays < 30) return 65
  if (ageDays < 60) return 45
  if (ageDays < 90) return 28
  return 12
}

// Confidence score: quantity and quality of signals
function calcConfidenceScore(signals: RawSignal[]): number {
  if (signals.length === 0) return 10
  const avgReliability = signals.reduce((s, sig) => s + sig.sourceReliability, 0) / signals.length
  const avgRelevance = signals.reduce((s, sig) => s + sig.industryRelevance, 0) / signals.length
  const countBonus = Math.min(30, signals.length * 8) // up to +30 for 4+ signals
  return Math.min(100, avgReliability * 0.4 + avgRelevance * 0.3 + countBonus)
}

// ICP Fit score from prospect metadata
export type ProspectMeta = {
  industry?: string | null
  employeeCount?: number | null
  contactEmail?: string | null
  contactName?: string | null
  domain?: string | null
  location?: string | null
}

export type ICPConfig = {
  targetIndustries: string[]
  minEmployees?: number
  maxEmployees?: number
  targetGeos: string[]
  mustHaveEmail: boolean
}

export type SignalWeights = Partial<Record<SignalType, number>>

const ICP_INDUSTRIES = ['civil', 'electrical', 'plumbing', 'landscaping', 'facilities', 'hvac',
  'roofing', 'painting', 'flooring', 'mechanical', 'structural', 'construction', 'environmental',
  'infrastructure', 'utility', 'contractor', 'logistics', 'transport', 'warehouse', 'financial',
  'insurance', 'accounting', 'legal', 'consulting', 'engineering', 'manufacturing', 'retail',
  'hospitality', 'healthcare', 'technology', 'real estate', 'property']

function calcFitScore(meta: ProspectMeta, icp?: ICPConfig): number {
  let score = 40
  if (meta.industry) {
    const lower = meta.industry.toLowerCase()
    const industryList = icp?.targetIndustries?.length ? icp.targetIndustries : ICP_INDUSTRIES
    if (industryList.some(k => lower.includes(k.toLowerCase()))) score += 30
    else score += 5
  }
  if (meta.employeeCount) {
    const min = icp?.minEmployees ?? 10
    const max = icp?.maxEmployees ?? 500
    if (meta.employeeCount >= min && meta.employeeCount <= max) score += 20
    else if (meta.employeeCount > max) score += 5
    else score += 10
  } else {
    score += 10
  }
  if (meta.contactEmail) {
    score += icp?.mustHaveEmail ? 15 : 10
  } else if (icp?.mustHaveEmail) {
    score -= 20
  }
  if (meta.contactName) score += 5
  if (meta.domain) score += 5
  return Math.min(100, Math.max(0, score))
}

export type OpportunityScores = {
  intentScore: number
  fitScore: number
  timingScore: number
  confidenceScore: number
  opportunityScore: number
}

// Main scoring formula: geometric mean of 4 dimensions
export function calculateOpportunityScores(
  signals: RawSignal[],
  meta: ProspectMeta,
  icp?: ICPConfig,
  signalWeights?: SignalWeights
): OpportunityScores {
  const intentScore = Math.round(calcIntentScore(signals, signalWeights))
  const fitScore = Math.round(calcFitScore(meta, icp))
  const timingScore = Math.round(calcTimingScore(signals))
  const confidenceScore = Math.round(calcConfidenceScore(signals))

  const product = intentScore * fitScore * timingScore * confidenceScore
  const opportunityScore = Math.round(Math.min(100, Math.max(0, Math.pow(product, 0.25))))

  return { intentScore, fitScore, timingScore, confidenceScore, opportunityScore }
}

// Buying stage detection from signal patterns
export function detectBuyingStage(signals: RawSignal[], opportunityScore: number): BuyingStage {
  if (signals.length === 0) return 'INACTIVE'

  const mostRecentMs = Math.max(...signals.map(s => s.detectedAt.getTime()))
  const ageDays = (Date.now() - mostRecentMs) / 86_400_000
  if (ageDays > 90) return 'INACTIVE'

  const types = new Set(signals.map(s => s.type))
  const hasFunding = types.has('FUNDING')
  const hasHiring = types.has('HIRING')
  const hasProcurement = types.has('PROCUREMENT')
  const hasExpansion = types.has('EXPANSION')
  const hasLeadership = types.has('LEADERSHIP_CHANGE')

  if (hasProcurement || (opportunityScore >= 75 && (hasFunding || hasHiring))) return 'PURCHASING'
  if ((hasFunding && (hasHiring || hasExpansion)) || opportunityScore >= 65) return 'COMPARING'
  if (hasFunding || hasHiring || hasLeadership || opportunityScore >= 45) return 'EVALUATING'
  return 'RESEARCHING'
}

// Win probability by buying stage, adjusted by opportunity score
const STAGE_BASE_PROBS: Record<BuyingStage, number> = {
  INACTIVE: 0.02,
  RESEARCHING: 0.05,
  EVALUATING: 0.15,
  COMPARING: 0.30,
  PURCHASING: 0.60,
}

export function calcWinProbability(stage: BuyingStage, opportunityScore: number): number {
  const base = STAGE_BASE_PROBS[stage]
  const adjustment = (opportunityScore - 50) / 100
  return Math.max(0.01, Math.min(0.95, base * (1 + adjustment)))
}

// Human-readable tier
export function getOpportunityTier(score: number): 'HOT' | 'WARM' | 'COLD' {
  if (score >= 72) return 'HOT'
  if (score >= 45) return 'WARM'
  return 'COLD'
}

// Rule-based recommendation generation
export type RecommendationInput = {
  bestContact: string
  bestTiming: string
  bestChannel: string
  messageAngle: string
  reasoning: string
  actionText: string
  urgency: string
  priority: number
}

export function generateRuleBasedRecommendation(
  meta: ProspectMeta & { contactPhone?: string | null; linkedinUrl?: string | null },
  signals: RawSignal[]
): RecommendationInput {
  const sortedByStrength = [...signals].sort(
    (a, b) => EVENT_BASE_WEIGHTS[b.type] - EVENT_BASE_WEIGHTS[a.type]
  )
  const dominant = sortedByStrength[0]

  const bestChannel = meta.contactEmail ? 'EMAIL'
    : meta.linkedinUrl ? 'LINKEDIN'
    : meta.contactPhone ? 'PHONE'
    : 'EMAIL'

  const ANGLE_MAP: Record<SignalType, string> = {
    FUNDING: 'GROWTH',
    HIRING: 'EFFICIENCY',
    EXPANSION: 'GROWTH',
    TECH_ADOPTION: 'EFFICIENCY',
    LEADERSHIP_CHANGE: 'GROWTH',
    PROCUREMENT: 'COST_SAVINGS',
    NEWS_MENTION: 'GROWTH',
    BUSINESS_REGISTRATION: 'GROWTH',
    WEBSITE_CHANGE: 'GROWTH',
  }
  const messageAngle = dominant ? ANGLE_MAP[dominant.type] : 'GROWTH'

  const ageDays = dominant
    ? (Date.now() - dominant.detectedAt.getTime()) / 86_400_000
    : 999
  const bestTiming = ageDays < 3 ? 'Today — signal is very fresh'
    : ageDays < 7 ? 'This week — signal is still hot'
    : ageDays < 14 ? 'Within 2 weeks — signal is warm'
    : ageDays < 30 ? 'This month — signal is cooling'
    : 'Anytime — prioritize other hot prospects first'

  const urgency = ageDays < 3 ? 'HIGH' : ageDays < 14 ? 'MEDIUM' : 'LOW'
  const priority = Math.max(10, Math.min(100, Math.round(100 - ageDays * 0.8)))

  const bestContact = meta.contactName
    ? meta.contactName
    : 'Decision maker / owner'

  const REASON_MAP: Record<SignalType, string> = {
    FUNDING: 'Recent funding signals spending capacity and growth intent',
    HIRING: 'Active hiring signals team expansion and process needs',
    EXPANSION: 'Expansion activity signals need for new suppliers',
    TECH_ADOPTION: 'Technology change signals operational transformation',
    LEADERSHIP_CHANGE: 'New leadership signals budget resets and new vendor opportunities',
    PROCUREMENT: 'Active procurement signals immediate buying intent',
    NEWS_MENTION: 'News coverage signals company momentum and visibility',
    BUSINESS_REGISTRATION: 'New business registration signals fresh buyer entering market',
    WEBSITE_CHANGE: 'Website updates signal business evolution',
  }
  const reasoning = dominant ? REASON_MAP[dominant.type] : 'Based on company profile and industry fit'

  const ACTION_MAP: Record<string, string> = {
    EMAIL: `Send personalized email${meta.contactEmail ? ` to ${meta.contactEmail}` : ''}`,
    LINKEDIN: 'Connect on LinkedIn with personalized message',
    PHONE: `Call${meta.contactPhone ? ` ${meta.contactPhone}` : ' main number'}`,
  }
  const actionText = ACTION_MAP[bestChannel]

  return { bestContact, bestTiming, bestChannel, messageAngle, reasoning, actionText, urgency, priority }
}

// Convert a DB Signal row to RawSignal for scoring functions
export function toRawSignal(s: {
  type: SignalType
  strength: number
  sourceReliability: number
  industryRelevance: number
  detectedAt: Date
}): RawSignal {
  return {
    type: s.type,
    strength: s.strength,
    sourceReliability: s.sourceReliability,
    industryRelevance: s.industryRelevance,
    detectedAt: s.detectedAt,
  }
}

const STAGE_ORDER: Record<BuyingStage, number> = {
  INACTIVE: 0, RESEARCHING: 1, EVALUATING: 2, COMPARING: 3, PURCHASING: 4,
}

const NEXT_ACTION_MAP: Record<BuyingStage, string> = {
  INACTIVE:    'Monitor for new signals before outreach',
  RESEARCHING: 'Send awareness content — company is in early research mode',
  EVALUATING:  'Schedule discovery call — company is actively evaluating options',
  COMPARING:   'Present ROI case — company is comparing vendors now',
  PURCHASING:  'Fast-track to proposal — company is ready to buy',
}

export function predictBuyingIntent(
  signals: RawSignal[],
  currentStage: BuyingStage | string,
  opportunityScore: number
): {
  predictedStage: BuyingStage
  confidence: number
  trajectory: 'ACCELERATING' | 'STABLE' | 'DECELERATING'
  nextAction: string
} {
  const predictedStage = detectBuyingStage(signals, opportunityScore)
  const currentOrder = STAGE_ORDER[currentStage as BuyingStage] ?? 1
  const predictedOrder = STAGE_ORDER[predictedStage]

  const trajectory: 'ACCELERATING' | 'STABLE' | 'DECELERATING' =
    predictedOrder > currentOrder ? 'ACCELERATING' :
    predictedOrder < currentOrder ? 'DECELERATING' :
    'STABLE'

  const recentCount = signals.filter(
    s => (Date.now() - s.detectedAt.getTime()) / 86_400_000 < 30
  ).length
  const confidence = Math.min(95, 40 + recentCount * 10 + Math.round(opportunityScore * 0.3))

  return { predictedStage, confidence, trajectory, nextAction: NEXT_ACTION_MAP[predictedStage] }
}
