// Acquisition Intelligence Engine — Layers 1-8, 13
// Formula: Opportunity Score = (Intent × Timing × ICP Fit × Confidence × Similarity × Channel)^(1/6)

export type SignalType =
  | 'HIRING' | 'FUNDING' | 'EXPANSION' | 'TECH_ADOPTION' | 'LEADERSHIP_CHANGE'
  | 'NEWS_MENTION' | 'PROCUREMENT' | 'BUSINESS_REGISTRATION' | 'WEBSITE_CHANGE'

export type BuyingStage = 'RESEARCHING' | 'EVALUATING' | 'COMPARING' | 'PURCHASING' | 'INACTIVE'
export type OutcomeStage = 'DISCOVERED' | 'VIEWED' | 'CONTACTED' | 'MEETING' | 'PROPOSAL' | 'WON' | 'LOST'

// Layer 4: Exponential decay rates — strength × e^(-rate × ageDays)
const SIGNAL_DECAY_RATES: Record<SignalType, number> = {
  FUNDING:               0.013,
  HIRING:                0.012,
  LEADERSHIP_CHANGE:     0.010,
  EXPANSION:             0.011,
  TECH_ADOPTION:         0.009,
  NEWS_MENTION:          0.020,
  PROCUREMENT:           0.007,
  BUSINESS_REGISTRATION: 0.006,
  WEBSITE_CHANGE:        0.025,
}

// Layer 1: Base signal importance weights (also caps for intent score)
export const EVENT_BASE_WEIGHTS: Record<SignalType, number> = {
  FUNDING:               95,
  HIRING:                85,
  PROCUREMENT:           90,
  EXPANSION:             75,
  TECH_ADOPTION:         70,
  LEADERSHIP_CHANGE:     65,
  BUSINESS_REGISTRATION: 55,
  NEWS_MENTION:          50,
  WEBSITE_CHANGE:        40,
}

// Layer 2: Normalized signal structure
export type RawSignal = {
  type: SignalType
  strength: number        // 0-100
  sourceReliability: number  // 0-100
  industryRelevance: number  // 0-100
  detectedAt: Date
}

// Normalize a Prisma signal row → RawSignal (single source of truth, no duplication in routes)
export function toRawSignal(s: {
  type: string
  strength: number
  sourceReliability: number
  industryRelevance: number
  detectedAt: Date
}): RawSignal {
  return {
    type: s.type as SignalType,
    strength: s.strength,
    sourceReliability: s.sourceReliability,
    industryRelevance: s.industryRelevance,
    detectedAt: s.detectedAt,
  }
}

// Layer 9: Learned signal weights from calibration (per-type multipliers, clamped [0.3, 3.0])
export type SignalWeights = Partial<Record<SignalType, number>>

// Layer 3: Industry-specific signal weights — the spec: construction rates contracts >> funding
const INDUSTRY_SIGNAL_WEIGHTS: Record<string, SignalWeights> = {
  construction:  { PROCUREMENT: 1.4, EXPANSION: 1.3, HIRING: 1.2, FUNDING: 0.6 },
  civil:         { PROCUREMENT: 1.4, EXPANSION: 1.3, HIRING: 1.2, FUNDING: 0.6 },
  electrical:    { PROCUREMENT: 1.3, HIRING: 1.2, EXPANSION: 1.1, FUNDING: 0.7 },
  plumbing:      { PROCUREMENT: 1.3, HIRING: 1.1, EXPANSION: 1.1, FUNDING: 0.7 },
  hvac:          { PROCUREMENT: 1.3, HIRING: 1.2, EXPANSION: 1.1, FUNDING: 0.7 },
  landscaping:   { HIRING: 1.3, EXPANSION: 1.2, PROCUREMENT: 1.1 },
  roofing:       { PROCUREMENT: 1.3, HIRING: 1.1, EXPANSION: 1.0 },
  technology:    { FUNDING: 1.4, HIRING: 1.3, TECH_ADOPTION: 1.2 },
  software:      { FUNDING: 1.4, HIRING: 1.3, TECH_ADOPTION: 1.2 },
  healthcare:    { PROCUREMENT: 1.3, LEADERSHIP_CHANGE: 1.2, EXPANSION: 1.1 },
  finance:       { LEADERSHIP_CHANGE: 1.3, EXPANSION: 1.2, FUNDING: 1.1 },
  manufacturing: { PROCUREMENT: 1.3, EXPANSION: 1.2, HIRING: 1.1 },
}

export function getIndustrySignalWeights(industry?: string | null): SignalWeights {
  if (!industry) return {}
  const lower = industry.toLowerCase()
  for (const [key, weights] of Object.entries(INDUSTRY_SIGNAL_WEIGHTS)) {
    if (lower.includes(key)) return weights
  }
  return {}
}

// Layer 4: Decayed signal strength
export function decayedStrength(signal: RawSignal): number {
  const ageDays = (Date.now() - signal.detectedAt.getTime()) / 86_400_000
  const rate = SIGNAL_DECAY_RATES[signal.type] ?? 0.01
  return signal.strength * Math.exp(-rate * ageDays)
}

// Layer 1+3+9: Intent score — combines decay, industry weights, and learned weights
function calcIntentScore(
  signals: RawSignal[],
  industryWeights: SignalWeights,
  learnedWeights?: SignalWeights
): number {
  if (signals.length === 0) return 0
  const scores = signals.map(sig => {
    const ds = decayedStrength(sig)
    const industry = industryWeights[sig.type] ?? 1.0
    const learned = learnedWeights?.[sig.type] ?? 1.0
    const combinedMultiplier = industry * learned
    const cap = Math.min(100, EVENT_BASE_WEIGHTS[sig.type] * combinedMultiplier)
    return Math.min(ds * (sig.sourceReliability / 100), cap)
  })
  scores.sort((a, b) => b - a)
  const primary = scores[0]
  const bonus = scores.slice(1).reduce((acc, s) => acc + s * 0.25, 0)
  return Math.min(100, primary + bonus)
}

// Layer 4: Timing score from signal freshness
function calcTimingScore(signals: RawSignal[]): number {
  if (signals.length === 0) return 10
  const mostRecentMs = Math.max(...signals.map(s => s.detectedAt.getTime()))
  const ageDays = (Date.now() - mostRecentMs) / 86_400_000
  if (ageDays < 3)  return 100
  if (ageDays < 7)  return 90
  if (ageDays < 14) return 80
  if (ageDays < 30) return 65
  if (ageDays < 60) return 45
  if (ageDays < 90) return 28
  return 12
}

// Signal quality and coverage
function calcConfidenceScore(signals: RawSignal[]): number {
  if (signals.length === 0) return 10
  const avgReliability = signals.reduce((s, sig) => s + sig.sourceReliability, 0) / signals.length
  const avgRelevance   = signals.reduce((s, sig) => s + sig.industryRelevance,  0) / signals.length
  const countBonus     = Math.min(30, signals.length * 8)
  return Math.min(100, avgReliability * 0.4 + avgRelevance * 0.3 + countBonus)
}

// Layer 6: ICP configuration — auto-discovered from WON outcomes via learningLoop
export type ICPConfig = {
  targetIndustries?: string[]
  minEmployees?:     number
  maxEmployees?:     number
  targetGeos?:       string[]
  mustHaveEmail?:    boolean
}

export type ProspectMeta = {
  industry?:     string | null
  employeeCount?: number | null
  contactEmail?: string | null
  contactName?:  string | null
  domain?:       string | null
  location?:     string | null
}

const DEFAULT_ICP_INDUSTRIES = [
  'civil', 'electrical', 'plumbing', 'landscaping', 'facilities', 'hvac',
  'roofing', 'painting', 'flooring', 'mechanical', 'structural', 'construction',
  'environmental', 'infrastructure', 'utility', 'contractor', 'logistics',
  'transport', 'warehouse', 'financial', 'insurance', 'accounting', 'legal',
  'consulting', 'engineering', 'manufacturing', 'retail', 'hospitality',
  'healthcare', 'technology', 'real estate', 'property',
]

export function calcFitScore(meta: ProspectMeta, icp?: ICPConfig): number {
  let score = 40

  if (meta.industry) {
    const lower = meta.industry.toLowerCase()
    const industries = icp?.targetIndustries?.length ? icp.targetIndustries : DEFAULT_ICP_INDUSTRIES
    const matched = industries.some(k => lower.includes(k.toLowerCase()))
    if (matched) {
      score += 30
    } else {
      score += icp?.targetIndustries?.length ? 0 : 5
    }
  }

  const minEmp = icp?.minEmployees ?? 10
  const maxEmp = icp?.maxEmployees ?? 500
  if (meta.employeeCount) {
    if (meta.employeeCount >= minEmp && meta.employeeCount <= maxEmp) score += 20
    else if (meta.employeeCount > maxEmp) score += 5
    else score += 10
  } else {
    score += 10
  }

  // Hard penalty: workspace requires email but prospect has none
  if (icp?.mustHaveEmail && !meta.contactEmail) {
    return Math.min(score, 30)
  }

  if (meta.contactEmail) score += 10
  if (meta.contactName)  score += 5
  if (meta.domain)       score += 5

  // Geo fit (soft bonus/penalty)
  if (icp?.targetGeos?.length && meta.location) {
    const locLower = meta.location.toLowerCase()
    const geoMatch = icp.targetGeos.some(g => locLower.includes(g.toLowerCase()))
    score += geoMatch ? 5 : -5
  }

  return Math.min(100, Math.max(0, score))
}

// Layer 7: Prospect Similarity Engine — vector profiles of winning customers
export type ProspectVector = {
  industry?:       string | null
  employeeCount?:  number | null
  signalTypes:     string[]
  opportunityScore: number
}

export function buildProspectVector(meta: ProspectMeta, signals: RawSignal[]): number[] {
  const industryMatch = meta.industry
    ? (DEFAULT_ICP_INDUSTRIES.some(k => meta.industry!.toLowerCase().includes(k)) ? 1 : 0.2)
    : 0.5
  const sizeNorm = meta.employeeCount
    ? Math.min(1, Math.log10(meta.employeeCount + 1) / Math.log10(1001))
    : 0.5
  const hasEmail     = meta.contactEmail ? 1 : 0
  const hasDomain    = meta.domain       ? 1 : 0
  const signalCount  = Math.min(1, signals.length / 5)
  const types = new Set(signals.map(s => s.type))
  const hasFunding    = types.has('FUNDING')     ? 1 : 0
  const hasHiring     = types.has('HIRING')      ? 1 : 0
  const hasProcure    = types.has('PROCUREMENT') ? 1 : 0
  const topWeight     = signals.length > 0
    ? Math.max(...signals.map(s => EVENT_BASE_WEIGHTS[s.type])) / 100
    : 0
  return [industryMatch, sizeNorm, hasEmail, hasDomain, signalCount, topWeight, hasFunding, hasHiring, hasProcure]
}

function cosineSimilarity(a: number[], b: number[]): number {
  const dot  = a.reduce((s, v, i) => s + v * (b[i] ?? 0), 0)
  const magA = Math.sqrt(a.reduce((s, v) => s + v * v, 0))
  const magB = Math.sqrt(b.reduce((s, v) => s + v * v, 0))
  return magA === 0 || magB === 0 ? 0 : dot / (magA * magB)
}

export function calcSimilarityScore(
  meta: ProspectMeta,
  signals: RawSignal[],
  winnerProfiles?: ProspectVector[]
): number {
  if (!winnerProfiles?.length) return 50 // neutral — no comparison data yet
  const targetVec = buildProspectVector(meta, signals)
  let weightedSum = 0
  let totalWeight = 0
  for (const winner of winnerProfiles) {
    const winnerMeta: ProspectMeta = { industry: winner.industry, employeeCount: winner.employeeCount }
    const winnerSignals: RawSignal[] = winner.signalTypes.map(t => ({
      type: t as SignalType,
      strength: 75,
      sourceReliability: 70,
      industryRelevance: 60,
      detectedAt: new Date(Date.now() - 7 * 86_400_000),
    }))
    const winnerVec = buildProspectVector(winnerMeta, winnerSignals)
    const sim = cosineSimilarity(targetVec, winnerVec)
    const weight = winner.opportunityScore / 100
    weightedSum += sim * weight
    totalWeight += weight
  }
  const avgSimilarity = totalWeight > 0 ? (weightedSum / totalWeight) * 100 : 50
  return Math.round(Math.min(100, Math.max(0, avgSimilarity)))
}

// Layer 8: Channel effectiveness — can we actually reach this prospect?
export function calcChannelScore(meta: ProspectMeta): number {
  let score = 15
  if (meta.contactEmail) score += 50
  if (meta.contactName)  score += 15
  if (meta.domain)       score += 12
  return Math.min(100, score)
}

// Layer 13: Full composite scores
export type OpportunityScores = {
  intentScore:     number
  fitScore:        number
  timingScore:     number
  confidenceScore: number
  similarityScore: number
  channelScore:    number
  opportunityScore: number
}

export function calculateOpportunityScores(
  signals: RawSignal[],
  meta: ProspectMeta,
  icp?: ICPConfig,
  learnedWeights?: SignalWeights,
  winnerProfiles?: ProspectVector[]
): OpportunityScores {
  const industryWeights = getIndustrySignalWeights(meta.industry)
  const intentScore     = Math.round(calcIntentScore(signals, industryWeights, learnedWeights))
  const fitScore        = Math.round(calcFitScore(meta, icp))
  const timingScore     = Math.round(calcTimingScore(signals))
  const confidenceScore = Math.round(calcConfidenceScore(signals))
  const similarityScore = Math.round(calcSimilarityScore(meta, signals, winnerProfiles))
  const channelScore    = Math.round(calcChannelScore(meta))

  // 6-dimension geometric mean — all dimensions must be present for a high score
  const product = intentScore * fitScore * timingScore * confidenceScore * similarityScore * channelScore
  const opportunityScore = Math.round(
    Math.min(100, Math.max(0, Math.pow(Math.max(0, product), 1 / 6)))
  )

  return { intentScore, fitScore, timingScore, confidenceScore, similarityScore, channelScore, opportunityScore }
}

// Buying stage detection
export function detectBuyingStage(signals: RawSignal[], opportunityScore: number): BuyingStage {
  if (signals.length === 0) return 'INACTIVE'

  const mostRecentMs = Math.max(...signals.map(s => s.detectedAt.getTime()))
  const ageDays = (Date.now() - mostRecentMs) / 86_400_000
  if (ageDays > 90) return 'INACTIVE'

  const types = new Set(signals.map(s => s.type))
  const hasFunding    = types.has('FUNDING')
  const hasHiring     = types.has('HIRING')
  const hasProcure    = types.has('PROCUREMENT')
  const hasExpansion  = types.has('EXPANSION')
  const hasLeadership = types.has('LEADERSHIP_CHANGE')

  if (hasProcure || (opportunityScore >= 75 && (hasFunding || hasHiring))) return 'PURCHASING'
  if ((hasFunding && (hasHiring || hasExpansion)) || opportunityScore >= 65) return 'COMPARING'
  if (hasFunding || hasHiring || hasLeadership || opportunityScore >= 45)    return 'EVALUATING'
  return 'RESEARCHING'
}

const STAGE_BASE_PROBS: Record<BuyingStage, number> = {
  INACTIVE:    0.02,
  RESEARCHING: 0.05,
  EVALUATING:  0.15,
  COMPARING:   0.30,
  PURCHASING:  0.60,
}

export function calcWinProbability(stage: BuyingStage, opportunityScore: number): number {
  const base       = STAGE_BASE_PROBS[stage]
  const adjustment = (opportunityScore - 50) / 100
  return Math.max(0.01, Math.min(0.95, base * (1 + adjustment)))
}

export function getOpportunityTier(score: number): 'HOT' | 'WARM' | 'COLD' {
  if (score >= 72) return 'HOT'
  if (score >= 45) return 'WARM'
  return 'COLD'
}

// Layer 5: Intent Prediction — what will this company do next and when?
export type IntentPrediction = {
  nextStage:        BuyingStage
  probability:      number   // 0-1
  daysToConversion: number   // estimated days
  triggers:         string[] // signals that would accelerate conversion
  confidence:       'HIGH' | 'MEDIUM' | 'LOW'
}

export function predictBuyingIntent(
  signals: RawSignal[],
  currentStage: BuyingStage,
  opportunityScore: number
): IntentPrediction {
  const STAGE_PROGRESSION: Record<BuyingStage, BuyingStage> = {
    INACTIVE:    'RESEARCHING',
    RESEARCHING: 'EVALUATING',
    EVALUATING:  'COMPARING',
    COMPARING:   'PURCHASING',
    PURCHASING:  'PURCHASING',
  }
  const nextStage = STAGE_PROGRESSION[currentStage]

  // Base probability of advancing to next stage within 30 days
  const ADVANCE_PROBS: Record<BuyingStage, number> = {
    INACTIVE:    0.10,
    RESEARCHING: 0.25,
    EVALUATING:  0.35,
    COMPARING:   0.50,
    PURCHASING:  0.70,
  }

  const scoreBoost = (opportunityScore - 50) / 200
  const probability = Math.max(0.02, Math.min(0.95, ADVANCE_PROBS[currentStage] + scoreBoost))

  // Days to conversion based on stage and score
  const BASE_DAYS: Record<BuyingStage, number> = {
    INACTIVE:    90,
    RESEARCHING: 60,
    EVALUATING:  45,
    COMPARING:   21,
    PURCHASING:  7,
  }
  const daysFactor = 1 - (opportunityScore - 50) / 200
  const daysToConversion = Math.max(3, Math.round(BASE_DAYS[currentStage] * daysFactor))

  // What signals would accelerate the deal
  const types = new Set(signals.map(s => s.type))
  const triggers: string[] = []
  if (!types.has('PROCUREMENT'))       triggers.push('Procurement signal would confirm purchase intent')
  if (!types.has('HIRING'))            triggers.push('Hiring signal would confirm growth trajectory')
  if (!types.has('LEADERSHIP_CHANGE')) triggers.push('Leadership change creates new-vendor opportunity')
  if (signals.length < 3)             triggers.push('Additional corroborating signals boost confidence')

  const confidence: IntentPrediction['confidence'] =
    signals.length >= 3 && opportunityScore >= 60 ? 'HIGH' :
    signals.length >= 1 && opportunityScore >= 40 ? 'MEDIUM' : 'LOW'

  return { nextStage, probability, daysToConversion, triggers: triggers.slice(0, 3), confidence }
}

// Rule-based recommendation
export type RecommendationInput = {
  bestContact:  string
  bestTiming:   string
  bestChannel:  string
  messageAngle: string
  reasoning:    string
  actionText:   string
  urgency:      string
  priority:     number
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
    : (meta as { linkedinUrl?: string | null }).linkedinUrl ? 'LINKEDIN'
    : meta.contactPhone ? 'PHONE'
    : 'EMAIL'

  const ANGLE_MAP: Record<SignalType, string> = {
    FUNDING:               'GROWTH',
    HIRING:                'EFFICIENCY',
    EXPANSION:             'GROWTH',
    TECH_ADOPTION:         'EFFICIENCY',
    LEADERSHIP_CHANGE:     'GROWTH',
    PROCUREMENT:           'COST_SAVINGS',
    NEWS_MENTION:          'GROWTH',
    BUSINESS_REGISTRATION: 'GROWTH',
    WEBSITE_CHANGE:        'GROWTH',
  }
  const messageAngle = dominant ? ANGLE_MAP[dominant.type] : 'GROWTH'

  const ageDays = dominant
    ? (Date.now() - dominant.detectedAt.getTime()) / 86_400_000
    : 999

  const bestTiming =
    ageDays < 3  ? 'Today — signal is very fresh' :
    ageDays < 7  ? 'This week — signal is still hot' :
    ageDays < 14 ? 'Within 2 weeks — signal is warm' :
    ageDays < 30 ? 'This month — signal is cooling' :
    'Anytime — prioritize other hot prospects first'

  const urgency  = ageDays < 3 ? 'HIGH' : ageDays < 14 ? 'MEDIUM' : 'LOW'
  const priority = Math.max(10, Math.min(100, Math.round(100 - ageDays * 0.8)))

  const bestContact = meta.contactName ?? 'Decision maker / owner'

  const REASON_MAP: Record<SignalType, string> = {
    FUNDING:               'Recent funding signals spending capacity and growth intent',
    HIRING:                'Active hiring signals team expansion and process needs',
    EXPANSION:             'Expansion activity signals need for new suppliers',
    TECH_ADOPTION:         'Technology change signals operational transformation',
    LEADERSHIP_CHANGE:     'New leadership signals budget resets and new vendor opportunities',
    PROCUREMENT:           'Active procurement signals immediate buying intent',
    NEWS_MENTION:          'News coverage signals company momentum and visibility',
    BUSINESS_REGISTRATION: 'New business registration signals fresh buyer entering market',
    WEBSITE_CHANGE:        'Website updates signal business evolution',
  }
  const reasoning = dominant ? REASON_MAP[dominant.type] : 'Based on company profile and industry fit'

  const ACTION_MAP: Record<string, string> = {
    EMAIL:    `Send personalized email${meta.contactEmail ? ` to ${meta.contactEmail}` : ''}`,
    LINKEDIN: 'Connect on LinkedIn with personalized message',
    PHONE:    `Call${(meta as { contactPhone?: string | null }).contactPhone ? ` ${(meta as { contactPhone?: string | null }).contactPhone}` : ' main number'}`,
  }
  const actionText = ACTION_MAP[bestChannel]

  return { bestContact, bestTiming, bestChannel, messageAngle, reasoning, actionText, urgency, priority }
}
