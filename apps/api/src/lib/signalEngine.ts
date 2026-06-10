// Signal intelligence engine — decay functions, opportunity scoring, buying stage detection,
// expected revenue scoring, and signal normalization

export type SignalType =
  // Broad acquisition signals
  | 'HIRING' | 'FUNDING' | 'EXPANSION' | 'TECH_ADOPTION' | 'LEADERSHIP_CHANGE'
  | 'NEWS_MENTION' | 'PROCUREMENT' | 'BUSINESS_REGISTRATION' | 'WEBSITE_CHANGE'
  // Granular acquisition signals for precision targeting
  | 'JOB_POSTING_SPIKE' | 'CONTRACT_AWARDED' | 'TENDER_PUBLISHED' | 'PERMIT_APPROVED'
  | 'OFFICE_OPENING' | 'PRICING_PAGE_CHANGED' | 'ENTERPRISE_PAGE_LAUNCHED'
  | 'GOV_GRANT_RECEIVED' | 'PROJECT_START_DETECTED' | 'TECH_STACK_CHANGED'

export type BuyingStage = 'RESEARCHING' | 'EVALUATING' | 'COMPARING' | 'PURCHASING' | 'INACTIVE'
export type OutcomeStage = 'DISCOVERED' | 'VIEWED' | 'CONTACTED' | 'MEETING' | 'PROPOSAL' | 'WON' | 'LOST'

// Exponential decay rates: strength × e^(-rate × ageDays)
const SIGNAL_DECAY_RATES: Record<SignalType, number> = {
  // Broad signals
  FUNDING: 0.013,
  HIRING: 0.012,
  LEADERSHIP_CHANGE: 0.010,
  EXPANSION: 0.011,
  TECH_ADOPTION: 0.009,
  NEWS_MENTION: 0.020,
  PROCUREMENT: 0.007,
  BUSINESS_REGISTRATION: 0.006,
  WEBSITE_CHANGE: 0.025,
  // Granular signals — higher urgency = faster decay
  JOB_POSTING_SPIKE: 0.015,
  CONTRACT_AWARDED: 0.008,
  TENDER_PUBLISHED: 0.010,
  PERMIT_APPROVED: 0.007,
  OFFICE_OPENING: 0.006,
  PRICING_PAGE_CHANGED: 0.020,
  ENTERPRISE_PAGE_LAUNCHED: 0.018,
  GOV_GRANT_RECEIVED: 0.007,
  PROJECT_START_DETECTED: 0.009,
  TECH_STACK_CHANGED: 0.014,
}

// Base event weights (0-100): higher = stronger buying signal
export const EVENT_BASE_WEIGHTS: Record<SignalType, number> = {
  // Broad signals
  FUNDING: 95,
  HIRING: 85,
  PROCUREMENT: 90,
  EXPANSION: 75,
  TECH_ADOPTION: 70,
  LEADERSHIP_CHANGE: 65,
  BUSINESS_REGISTRATION: 55,
  NEWS_MENTION: 50,
  WEBSITE_CHANGE: 40,
  // Granular signals — calibrated by specificity
  CONTRACT_AWARDED: 98,
  TENDER_PUBLISHED: 95,
  GOV_GRANT_RECEIVED: 88,
  JOB_POSTING_SPIKE: 82,
  PERMIT_APPROVED: 80,
  PROJECT_START_DETECTED: 78,
  OFFICE_OPENING: 72,
  ENTERPRISE_PAGE_LAUNCHED: 68,
  TECH_STACK_CHANGED: 65,
  PRICING_PAGE_CHANGED: 60,
}

// Signal normalization: what buying category does each type imply?
export type SignalNormalization = {
  normalizedType: 'growth' | 'efficiency' | 'cost_reduction' | 'risk' | 'market_entry'
  category: 'operational' | 'financial' | 'digital' | 'market'
  buyingImplication: string
  predictedNeeds: string[]
}

const SIGNAL_NORMALIZATIONS: Record<SignalType, SignalNormalization> = {
  FUNDING:                 { normalizedType: 'growth',       category: 'financial',    buyingImplication: 'spending_capacity_unlocked',     predictedNeeds: ['scaling_software', 'staffing', 'infrastructure'] },
  CONTRACT_AWARDED:        { normalizedType: 'growth',       category: 'market',       buyingImplication: 'project_delivery_pressure',       predictedNeeds: ['project_management', 'workforce', 'subcontractors'] },
  TENDER_PUBLISHED:        { normalizedType: 'market_entry', category: 'market',       buyingImplication: 'active_procurement_intent',        predictedNeeds: ['compliance', 'project_management', 'specialist_labour'] },
  HIRING:                  { normalizedType: 'growth',       category: 'operational',  buyingImplication: 'team_expansion_operational_need', predictedNeeds: ['onboarding_software', 'hr_tools', 'workflow_tools'] },
  JOB_POSTING_SPIKE:       { normalizedType: 'growth',       category: 'operational',  buyingImplication: 'rapid_team_growth_imminent',       predictedNeeds: ['ats', 'onboarding', 'workforce_management'] },
  PERMIT_APPROVED:         { normalizedType: 'growth',       category: 'market',       buyingImplication: 'project_commencement_confirmed',   predictedNeeds: ['site_management', 'materials', 'labour'] },
  GOV_GRANT_RECEIVED:      { normalizedType: 'growth',       category: 'financial',    buyingImplication: 'funded_project_starting',          predictedNeeds: ['compliance_reporting', 'project_tools', 'specialist_services'] },
  PROJECT_START_DETECTED:  { normalizedType: 'growth',       category: 'operational',  buyingImplication: 'new_project_resources_needed',     predictedNeeds: ['project_management', 'labour', 'equipment'] },
  OFFICE_OPENING:          { normalizedType: 'market_entry', category: 'market',       buyingImplication: 'geographic_expansion_underway',    predictedNeeds: ['local_vendors', 'fitout', 'comms_infrastructure'] },
  EXPANSION:               { normalizedType: 'growth',       category: 'market',       buyingImplication: 'capacity_or_market_expansion',     predictedNeeds: ['operations_tools', 'staffing', 'logistics'] },
  LEADERSHIP_CHANGE:       { normalizedType: 'market_entry', category: 'operational',  buyingImplication: 'vendor_reset_opportunity',         predictedNeeds: ['strategy_consulting', 'new_tools', 'process_review'] },
  TECH_ADOPTION:           { normalizedType: 'efficiency',   category: 'digital',      buyingImplication: 'digital_transformation_active',    predictedNeeds: ['integrations', 'training', 'support'] },
  TECH_STACK_CHANGED:      { normalizedType: 'efficiency',   category: 'digital',      buyingImplication: 'platform_migration_in_progress',   predictedNeeds: ['migration_services', 'integrations', 'training'] },
  ENTERPRISE_PAGE_LAUNCHED:{ normalizedType: 'market_entry', category: 'digital',      buyingImplication: 'upmarket_repositioning',           predictedNeeds: ['enterprise_tools', 'compliance', 'sso_security'] },
  PRICING_PAGE_CHANGED:    { normalizedType: 'market_entry', category: 'digital',      buyingImplication: 'pricing_strategy_shift',           predictedNeeds: ['billing_tools', 'analytics', 'sales_enablement'] },
  PROCUREMENT:             { normalizedType: 'cost_reduction', category: 'operational', buyingImplication: 'active_vendor_evaluation',         predictedNeeds: ['vendor_management', 'procurement_software', 'compliance'] },
  NEWS_MENTION:            { normalizedType: 'growth',       category: 'market',       buyingImplication: 'brand_momentum_visible',           predictedNeeds: ['pr_tools', 'crm', 'outbound_tools'] },
  WEBSITE_CHANGE:          { normalizedType: 'growth',       category: 'digital',      buyingImplication: 'business_evolution_signalled',     predictedNeeds: ['digital_services', 'analytics', 'content'] },
  BUSINESS_REGISTRATION:   { normalizedType: 'market_entry', category: 'market',       buyingImplication: 'new_entrant_needs_everything',      predictedNeeds: ['accounting', 'banking', 'saas_stack', 'insurance'] },
}

export function normalizeSignal(type: SignalType): SignalNormalization {
  return SIGNAL_NORMALIZATIONS[type] ?? {
    normalizedType: 'growth',
    category: 'market',
    buyingImplication: 'general_buying_signal',
    predictedNeeds: [],
  }
}

// Industry-specific signal priority matrix — construction/civil example
// These override EVENT_BASE_WEIGHTS for ICP-matched industries
const INDUSTRY_SIGNAL_BOOST: Partial<Record<string, Partial<Record<SignalType, number>>>> = {
  construction: {
    CONTRACT_AWARDED: 100, TENDER_PUBLISHED: 100, PERMIT_APPROVED: 95,
    JOB_POSTING_SPIKE: 90, GOV_GRANT_RECEIVED: 88, PROJECT_START_DETECTED: 92,
  },
  logistics: {
    OFFICE_OPENING: 90, HIRING: 88, EXPANSION: 92, CONTRACT_AWARDED: 85,
  },
  saas: {
    FUNDING: 100, TECH_STACK_CHANGED: 85, ENTERPRISE_PAGE_LAUNCHED: 90, PRICING_PAGE_CHANGED: 80,
  },
  financial: {
    LEADERSHIP_CHANGE: 85, PROCUREMENT: 88, FUNDING: 90,
  },
}

function getIndustryWeight(type: SignalType, industry?: string | null, industryBoosts?: IndustryBoostConfig): number {
  if (!industry) return EVENT_BASE_WEIGHTS[type]
  const lower = industry.toLowerCase()
  const boostMap = industryBoosts ?? INDUSTRY_SIGNAL_BOOST
  for (const [key, boosts] of Object.entries(boostMap)) {
    if (lower.includes(key)) {
      return boosts[type] ?? EVENT_BASE_WEIGHTS[type]
    }
  }
  return EVENT_BASE_WEIGHTS[type]
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

// Intent score: how strongly this company is showing buying intent
function calcIntentScore(signals: RawSignal[], signalWeights?: SignalWeights, industry?: string | null, industryBoosts?: IndustryBoostConfig): number {
  if (signals.length === 0) return 0
  const scores = signals.map(sig => {
    const ds = decayedStrength(sig)
    const cap = signalWeights?.[sig.type] ?? getIndustryWeight(sig.type, industry, industryBoosts)
    return Math.min(ds * (sig.sourceReliability / 100), cap)
  })
  scores.sort((a, b) => b - a)
  const primary = scores[0]
  const bonus = scores.slice(1).reduce((acc, s) => acc + s * 0.25, 0)
  return Math.min(100, primary + bonus)
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
export type IndustryBoostConfig = Partial<Record<string, Partial<Record<SignalType, number>>>>

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
  signalWeights?: SignalWeights,
  industryBoosts?: IndustryBoostConfig
): OpportunityScores {
  const intentScore    = Math.round(calcIntentScore(signals, signalWeights, meta.industry, industryBoosts))
  const fitScore       = Math.round(calcFitScore(meta, icp))
  const timingScore    = Math.round(calcTimingScore(signals))
  const confidenceScore = Math.round(calcConfidenceScore(signals))

  const product = intentScore * fitScore * timingScore * confidenceScore
  const opportunityScore = Math.round(Math.min(100, Math.max(0, Math.pow(product, 0.25))))

  return { intentScore, fitScore, timingScore, confidenceScore, opportunityScore }
}

// ── Expected Revenue Score ────────────────────────────────────────────────────
// Dollar-weighted ranking: P(Convert) × DealValue × Retention × (1 + Expansion)
// Answers: "Is this opportunity worth pursuing right now?"

export function calculateExpectedRevenue(
  winProbability: number | null | undefined,
  expectedDealValue: number | null | undefined,
  retentionProbability = 0.8,
  expansionProbability = 0.2
): number {
  if (!expectedDealValue || expectedDealValue <= 0) return 0
  const pConvert = Math.max(0, Math.min(1, winProbability ?? 0))
  const pRetain  = Math.max(0, Math.min(1, retentionProbability))
  const pExpand  = Math.max(0, Math.min(1, expansionProbability))
  return Math.round(expectedDealValue * pConvert * pRetain * (1 + pExpand * 0.5))
}

// Compute decay deadline for a signal (when decayed strength < 5% of original)
export function computeSignalExpiry(type: SignalType, detectedAt: Date): Date {
  const rate = SIGNAL_DECAY_RATES[type] ?? 0.01
  // decay < 5%: e^(-rate × days) < 0.05 → days > -ln(0.05)/rate
  const daysToExpiry = Math.ceil(-Math.log(0.05) / rate)
  return new Date(detectedAt.getTime() + daysToExpiry * 86_400_000)
}

// ── Buying stage detection ────────────────────────────────────────────────────

export function detectBuyingStage(signals: RawSignal[], opportunityScore: number): BuyingStage {
  if (signals.length === 0) return 'INACTIVE'

  const mostRecentMs = Math.max(...signals.map(s => s.detectedAt.getTime()))
  const ageDays = (Date.now() - mostRecentMs) / 86_400_000
  if (ageDays > 90) return 'INACTIVE'

  const types = new Set(signals.map(s => s.type))
  const hasFunding     = types.has('FUNDING')
  const hasHiring      = types.has('HIRING') || types.has('JOB_POSTING_SPIKE')
  const hasProcurement = types.has('PROCUREMENT') || types.has('TENDER_PUBLISHED') || types.has('CONTRACT_AWARDED')
  const hasExpansion   = types.has('EXPANSION') || types.has('PERMIT_APPROVED') || types.has('PROJECT_START_DETECTED')
  const hasLeadership  = types.has('LEADERSHIP_CHANGE')

  if (hasProcurement || (opportunityScore >= 75 && (hasFunding || hasHiring))) return 'PURCHASING'
  if ((hasFunding && (hasHiring || hasExpansion)) || opportunityScore >= 65) return 'COMPARING'
  if (hasFunding || hasHiring || hasLeadership || opportunityScore >= 45) return 'EVALUATING'
  return 'RESEARCHING'
}

// Win probability by buying stage, adjusted by opportunity score
const STAGE_BASE_PROBS: Record<BuyingStage, number> = {
  INACTIVE:    0.02,
  RESEARCHING: 0.05,
  EVALUATING:  0.15,
  COMPARING:   0.30,
  PURCHASING:  0.60,
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

// ── Strategy card generation ──────────────────────────────────────────────────

export type RecommendationInput = {
  bestContact: string
  bestTiming: string
  bestChannel: string
  messageAngle: string
  reasoning: string
  actionText: string
  urgency: string
  priority: number
  predictedNeed: string
  meetingProbability: number
}

export function generateRuleBasedRecommendation(
  meta: ProspectMeta & { contactPhone?: string | null; linkedinUrl?: string | null },
  signals: RawSignal[],
  winProbability = 0
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
    FUNDING: 'GROWTH', HIRING: 'EFFICIENCY', EXPANSION: 'GROWTH',
    TECH_ADOPTION: 'EFFICIENCY', LEADERSHIP_CHANGE: 'GROWTH',
    PROCUREMENT: 'COST_SAVINGS', NEWS_MENTION: 'GROWTH',
    BUSINESS_REGISTRATION: 'GROWTH', WEBSITE_CHANGE: 'GROWTH',
    JOB_POSTING_SPIKE: 'EFFICIENCY', CONTRACT_AWARDED: 'GROWTH',
    TENDER_PUBLISHED: 'COST_SAVINGS', PERMIT_APPROVED: 'GROWTH',
    OFFICE_OPENING: 'GROWTH', PRICING_PAGE_CHANGED: 'COST_SAVINGS',
    ENTERPRISE_PAGE_LAUNCHED: 'GROWTH', GOV_GRANT_RECEIVED: 'GROWTH',
    PROJECT_START_DETECTED: 'EFFICIENCY', TECH_STACK_CHANGED: 'EFFICIENCY',
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

  const urgency  = ageDays < 3 ? 'HIGH' : ageDays < 14 ? 'MEDIUM' : 'LOW'
  const priority = Math.max(10, Math.min(100, Math.round(100 - ageDays * 0.8)))

  const bestContact = meta.contactName ?? 'Decision maker / owner'

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
    JOB_POSTING_SPIKE: 'Rapid hiring signals team growth and new operational needs',
    CONTRACT_AWARDED: 'Awarded contract signals project delivery pressure and resource needs',
    TENDER_PUBLISHED: 'Published tender signals active procurement cycle underway',
    PERMIT_APPROVED: 'Approved permit confirms project commencement is imminent',
    OFFICE_OPENING: 'New office signals geographic expansion requiring local vendors',
    PRICING_PAGE_CHANGED: 'Pricing change signals repositioning and new budget cycles',
    ENTERPRISE_PAGE_LAUNCHED: 'Enterprise page launch signals upmarket move and new requirements',
    GOV_GRANT_RECEIVED: 'Government grant confirms funded project with procurement needs',
    PROJECT_START_DETECTED: 'Project start signals immediate resource and vendor requirements',
    TECH_STACK_CHANGED: 'Technology stack change signals platform migration and integration needs',
  }
  const reasoning = dominant ? REASON_MAP[dominant.type] : 'Based on company profile and industry fit'

  const ACTION_MAP: Record<string, string> = {
    EMAIL: `Send personalized email${meta.contactEmail ? ` to ${meta.contactEmail}` : ''}`,
    LINKEDIN: 'Connect on LinkedIn with personalized message',
    PHONE: `Call${meta.contactPhone ? ` ${meta.contactPhone}` : ' main number'}`,
  }
  const actionText = ACTION_MAP[bestChannel]

  // Predicted need from the dominant signal's normalization
  const norm = dominant ? normalizeSignal(dominant.type) : null
  const predictedNeed = norm?.predictedNeeds.slice(0, 3).join(', ') ?? 'Operational support'

  // Meeting probability: win probability boosted by signal freshness
  const freshnessMultiplier = ageDays < 7 ? 1.3 : ageDays < 30 ? 1.0 : 0.7
  const meetingProbability = Math.min(0.95, winProbability * freshnessMultiplier * 1.5)

  return { bestContact, bestTiming, bestChannel, messageAngle, reasoning, actionText, urgency, priority, predictedNeed, meetingProbability }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

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
  const currentOrder   = STAGE_ORDER[currentStage as BuyingStage] ?? 1
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
