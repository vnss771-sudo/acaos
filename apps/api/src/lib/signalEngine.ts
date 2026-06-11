// Signal intelligence engine — decay functions, opportunity scoring, buying stage detection,
// expected revenue scoring, signal normalization, and Problem-Owner Activation detection

export type SignalType =
  // Broad acquisition signals
  | 'HIRING' | 'FUNDING' | 'EXPANSION' | 'TECH_ADOPTION' | 'LEADERSHIP_CHANGE'
  | 'NEWS_MENTION' | 'PROCUREMENT' | 'BUSINESS_REGISTRATION' | 'WEBSITE_CHANGE'
  // Granular acquisition signals for precision targeting
  | 'JOB_POSTING_SPIKE' | 'CONTRACT_AWARDED' | 'TENDER_PUBLISHED' | 'PERMIT_APPROVED'
  | 'OFFICE_OPENING' | 'PRICING_PAGE_CHANGED' | 'ENTERPRISE_PAGE_LAUNCHED'
  | 'GOV_GRANT_RECEIVED' | 'PROJECT_START_DETECTED' | 'TECH_STACK_CHANGED'
  // Composite activation signal: operational trigger + named ownership + solution-seeking
  | 'PROBLEM_OWNER_ACTIVATION'

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
  // Composite signal — buying windows close fast
  PROBLEM_OWNER_ACTIVATION: 0.018,
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
  // Seal-the-deal composite signal
  PROBLEM_OWNER_ACTIVATION: 100,
}

// Signal normalization: what buying category does each type imply?
export type SignalNormalization = {
  normalizedType: 'growth' | 'efficiency' | 'cost_reduction' | 'risk' | 'market_entry'
  category: 'operational' | 'financial' | 'digital' | 'market'
  buyingImplication: string
  predictedNeeds: string[]
}

const SIGNAL_NORMALIZATIONS: Record<SignalType, SignalNormalization> = {
  FUNDING:                   { normalizedType: 'growth',         category: 'financial',   buyingImplication: 'spending_capacity_unlocked',         predictedNeeds: ['scaling_software', 'staffing', 'infrastructure'] },
  CONTRACT_AWARDED:          { normalizedType: 'growth',         category: 'market',      buyingImplication: 'project_delivery_pressure',          predictedNeeds: ['project_management', 'workforce', 'subcontractors'] },
  TENDER_PUBLISHED:          { normalizedType: 'market_entry',   category: 'market',      buyingImplication: 'active_procurement_intent',          predictedNeeds: ['compliance', 'project_management', 'specialist_labour'] },
  HIRING:                    { normalizedType: 'growth',         category: 'operational', buyingImplication: 'team_expansion_operational_need',    predictedNeeds: ['onboarding_software', 'hr_tools', 'workflow_tools'] },
  JOB_POSTING_SPIKE:         { normalizedType: 'growth',         category: 'operational', buyingImplication: 'rapid_team_growth_imminent',         predictedNeeds: ['ats', 'onboarding', 'workforce_management'] },
  PERMIT_APPROVED:           { normalizedType: 'growth',         category: 'market',      buyingImplication: 'project_commencement_confirmed',     predictedNeeds: ['site_management', 'materials', 'labour'] },
  GOV_GRANT_RECEIVED:        { normalizedType: 'growth',         category: 'financial',   buyingImplication: 'funded_project_starting',            predictedNeeds: ['compliance_reporting', 'project_tools', 'specialist_services'] },
  PROJECT_START_DETECTED:    { normalizedType: 'growth',         category: 'operational', buyingImplication: 'new_project_resources_needed',       predictedNeeds: ['project_management', 'labour', 'equipment'] },
  OFFICE_OPENING:            { normalizedType: 'market_entry',   category: 'market',      buyingImplication: 'geographic_expansion_underway',      predictedNeeds: ['local_vendors', 'fitout', 'comms_infrastructure'] },
  EXPANSION:                 { normalizedType: 'growth',         category: 'market',      buyingImplication: 'capacity_or_market_expansion',       predictedNeeds: ['operations_tools', 'staffing', 'logistics'] },
  LEADERSHIP_CHANGE:         { normalizedType: 'market_entry',   category: 'operational', buyingImplication: 'vendor_reset_opportunity',           predictedNeeds: ['strategy_consulting', 'new_tools', 'process_review'] },
  TECH_ADOPTION:             { normalizedType: 'efficiency',     category: 'digital',     buyingImplication: 'digital_transformation_active',      predictedNeeds: ['integrations', 'training', 'support'] },
  TECH_STACK_CHANGED:        { normalizedType: 'efficiency',     category: 'digital',     buyingImplication: 'platform_migration_in_progress',     predictedNeeds: ['migration_services', 'integrations', 'training'] },
  ENTERPRISE_PAGE_LAUNCHED:  { normalizedType: 'market_entry',   category: 'digital',     buyingImplication: 'upmarket_repositioning',             predictedNeeds: ['enterprise_tools', 'compliance', 'sso_security'] },
  PRICING_PAGE_CHANGED:      { normalizedType: 'market_entry',   category: 'digital',     buyingImplication: 'pricing_strategy_shift',             predictedNeeds: ['billing_tools', 'analytics', 'sales_enablement'] },
  PROCUREMENT:               { normalizedType: 'cost_reduction', category: 'operational', buyingImplication: 'active_vendor_evaluation',           predictedNeeds: ['vendor_management', 'procurement_software', 'compliance'] },
  NEWS_MENTION:              { normalizedType: 'growth',         category: 'market',      buyingImplication: 'brand_momentum_visible',             predictedNeeds: ['pr_tools', 'crm', 'outbound_tools'] },
  WEBSITE_CHANGE:            { normalizedType: 'growth',         category: 'digital',     buyingImplication: 'business_evolution_signalled',       predictedNeeds: ['digital_services', 'analytics', 'content'] },
  BUSINESS_REGISTRATION:     { normalizedType: 'market_entry',   category: 'market',      buyingImplication: 'new_entrant_needs_everything',       predictedNeeds: ['accounting', 'banking', 'saas_stack', 'insurance'] },
  PROBLEM_OWNER_ACTIVATION:  { normalizedType: 'growth',         category: 'operational', buyingImplication: 'active_solution_search_confirmed',   predictedNeeds: ['immediate_vendor', 'fast_onboarding', 'proven_solution'] },
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
const INDUSTRY_SIGNAL_BOOST: Partial<Record<string, Partial<Record<SignalType, number>>>> = {
  construction: {
    CONTRACT_AWARDED: 100, TENDER_PUBLISHED: 100, PERMIT_APPROVED: 95,
    JOB_POSTING_SPIKE: 90, GOV_GRANT_RECEIVED: 88, PROJECT_START_DETECTED: 92,
    PROBLEM_OWNER_ACTIVATION: 100,
  },
  logistics: {
    OFFICE_OPENING: 90, HIRING: 88, EXPANSION: 92, CONTRACT_AWARDED: 85,
    PROBLEM_OWNER_ACTIVATION: 100,
  },
  saas: {
    FUNDING: 100, TECH_STACK_CHANGED: 85, ENTERPRISE_PAGE_LAUNCHED: 90, PRICING_PAGE_CHANGED: 80,
    PROBLEM_OWNER_ACTIVATION: 100,
  },
  financial: {
    LEADERSHIP_CHANGE: 85, PROCUREMENT: 88, FUNDING: 90,
    PROBLEM_OWNER_ACTIVATION: 100,
  },
}

export type IndustryBoostConfig = Partial<Record<string, Partial<Record<SignalType, number>>>>

function getIndustryWeight(type: SignalType, industry?: string | null, industryBoosts?: IndustryBoostConfig): number {
  if (!industry) return EVENT_BASE_WEIGHTS[type]
  const lower = industry.toLowerCase()
  const boostMap = industryBoosts ?? INDUSTRY_SIGNAL_BOOST
  for (const [key, boosts] of Object.entries(boostMap)) {
    if (lower.includes(key) && boosts) {
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

export type FullSignal = RawSignal & {
  title?: string | null
  description?: string | null
}

// Decayed signal strength accounting for age — clamps negative/NaN/Infinity inputs to 0
export function decayedStrength(signal: RawSignal): number {
  const strength = Number.isFinite(signal.strength) && signal.strength > 0 ? signal.strength : 0
  const ageDays = Math.max(0, (Date.now() - signal.detectedAt.getTime()) / 86_400_000)
  const rate = SIGNAL_DECAY_RATES[signal.type] ?? 0.01
  return strength * Math.exp(-rate * ageDays)
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
  const countBonus = Math.min(30, signals.length * 8)
  return Math.min(100, avgReliability * 0.4 + avgRelevance * 0.3 + countBonus)
}

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
  signalWeights?: SignalWeights,
  industryBoosts?: IndustryBoostConfig
): OpportunityScores {
  const intentScore     = Math.round(calcIntentScore(signals, signalWeights, meta.industry, industryBoosts))
  const fitScore        = Math.round(calcFitScore(meta, icp))
  const timingScore     = Math.round(calcTimingScore(signals))
  const confidenceScore = Math.round(calcConfidenceScore(signals))

  const product = intentScore * fitScore * timingScore * confidenceScore
  const opportunityScore = Math.round(Math.min(100, Math.max(0, Math.pow(product, 0.25))))

  return { intentScore, fitScore, timingScore, confidenceScore, opportunityScore }
}

// ── Score evidence — per-signal breakdown for Opportunity Brief ───────────────

export type SignalEvidenceItem = {
  type: SignalType
  label: string
  ageDays: number
  rawStrength: number
  decayedStrength: number
  contribution: number
  isLeading: boolean
}

export type ScoreEvidence = {
  intentContributions: SignalEvidenceItem[]
  fitBreakdown: {
    industryMatch: boolean
    sizeInRange: boolean
    hasEmail: boolean
    hasName: boolean
    hasDomain: boolean
    score: number
  }
  timingBreakdown: { mostRecentAgeDays: number; score: number }
  confidenceBreakdown: { avgReliability: number; avgRelevance: number; signalCount: number; score: number }
  rejectionReasons: string[]
}

export function explainOpportunityScores(
  signals: RawSignal[],
  meta: ProspectMeta,
  icp?: ICPConfig,
  signalWeights?: SignalWeights,
  industryBoosts?: IndustryBoostConfig
): OpportunityScores & { evidence: ScoreEvidence } {
  const scores = calculateOpportunityScores(signals, meta, icp, signalWeights, industryBoosts)

  // ── Intent contributions ──────────────────────────────────────────────────
  const rejectionReasons: string[] = []
  const rawContributions = signals.map(sig => {
    const ds = decayedStrength(sig)
    const cap = signalWeights?.[sig.type] ?? getIndustryWeight(sig.type, meta.industry, industryBoosts)
    const contribution = Math.min(ds * (sig.sourceReliability / 100), cap)
    const ageDays = Math.round((Date.now() - sig.detectedAt.getTime()) / 86_400_000)

    if (sig.strength < 5) {
      rejectionReasons.push(`${sig.type.replace(/_/g, ' ')}: very low strength (${sig.strength})`)
    } else if (ageDays > 90) {
      rejectionReasons.push(`${sig.type.replace(/_/g, ' ')}: too old (${ageDays} days)`)
    } else if (sig.sourceReliability < 40) {
      rejectionReasons.push(`${sig.type.replace(/_/g, ' ')}: low source reliability (${sig.sourceReliability})`)
    }

    return { sig, ds, contribution, ageDays }
  })
  rawContributions.sort((a, b) => b.contribution - a.contribution)

  const intentContributions: SignalEvidenceItem[] = rawContributions.map((r, i) => ({
    type: r.sig.type,
    label: normalizeSignal(r.sig.type).buyingImplication,
    ageDays: r.ageDays,
    rawStrength: r.sig.strength,
    decayedStrength: Math.round(r.ds * 10) / 10,
    contribution: Math.round(r.contribution * 10) / 10,
    isLeading: i === 0,
  }))

  // ── Fit breakdown ─────────────────────────────────────────────────────────
  const industryList = icp?.targetIndustries?.length ? icp.targetIndustries : ICP_INDUSTRIES
  const industryMatch = meta.industry
    ? industryList.some(k => meta.industry!.toLowerCase().includes(k.toLowerCase()))
    : false
  const min = icp?.minEmployees ?? 10
  const max = icp?.maxEmployees ?? 500
  const sizeInRange = meta.employeeCount != null
    ? meta.employeeCount >= min && meta.employeeCount <= max
    : false

  const fitBreakdown = {
    industryMatch,
    sizeInRange,
    hasEmail: !!meta.contactEmail,
    hasName: !!meta.contactName,
    hasDomain: !!meta.domain,
    score: scores.fitScore,
  }

  // ── Timing breakdown ──────────────────────────────────────────────────────
  const mostRecentMs = signals.length > 0
    ? Math.max(...signals.map(s => s.detectedAt.getTime()))
    : 0
  const mostRecentAgeDays = mostRecentMs > 0
    ? Math.round((Date.now() - mostRecentMs) / 86_400_000)
    : 999

  const timingBreakdown = { mostRecentAgeDays, score: scores.timingScore }

  // ── Confidence breakdown ──────────────────────────────────────────────────
  const avgReliability = signals.length > 0
    ? Math.round(signals.reduce((s, sig) => s + sig.sourceReliability, 0) / signals.length)
    : 0
  const avgRelevance = signals.length > 0
    ? Math.round(signals.reduce((s, sig) => s + sig.industryRelevance, 0) / signals.length)
    : 0

  const confidenceBreakdown = { avgReliability, avgRelevance, signalCount: signals.length, score: scores.confidenceScore }

  return {
    ...scores,
    evidence: { intentContributions, fitBreakdown, timingBreakdown, confidenceBreakdown, rejectionReasons },
  }
}

// ── Expected Revenue Score ────────────────────────────────────────────────────

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

  // Problem-Owner Activation is the strongest possible signal — immediate PURCHASING
  if (types.has('PROBLEM_OWNER_ACTIVATION')) return 'PURCHASING'

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

const STAGE_BASE_PROBS: Record<BuyingStage, number> = {
  INACTIVE:    0.02,
  RESEARCHING: 0.05,
  EVALUATING:  0.15,
  COMPARING:   0.30,
  PURCHASING:  0.60,
}

export function calcWinProbability(stage: BuyingStage, opportunityScore: number): number {
  const base = STAGE_BASE_PROBS[stage]
  const score = Number.isFinite(opportunityScore) ? opportunityScore : 50
  const adjustment = (score - 50) / 100
  return Math.max(0.01, Math.min(0.95, base * (1 + adjustment)))
}

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
    PROBLEM_OWNER_ACTIVATION: 'EFFICIENCY',
  }
  const messageAngle = dominant ? ANGLE_MAP[dominant.type] : 'GROWTH'

  const ageDays = dominant
    ? (Date.now() - dominant.detectedAt.getTime()) / 86_400_000
    : 999

  const isProblemOwner = dominant?.type === 'PROBLEM_OWNER_ACTIVATION'

  const bestTiming = isProblemOwner ? 'Today — buying window is open NOW'
    : ageDays < 3 ? 'Today — signal is very fresh'
    : ageDays < 7 ? 'This week — signal is still hot'
    : ageDays < 14 ? 'Within 2 weeks — signal is warm'
    : ageDays < 30 ? 'This month — signal is cooling'
    : 'Anytime — prioritize other hot prospects first'

  const urgency  = isProblemOwner ? 'HIGH' : ageDays < 3 ? 'HIGH' : ageDays < 14 ? 'MEDIUM' : 'LOW'
  const priority = isProblemOwner ? 100 : Math.max(10, Math.min(100, Math.round(100 - ageDays * 0.8)))

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
    PROBLEM_OWNER_ACTIVATION: 'Someone has been assigned to solve the exact problem you sell against — buying window is open',
  }
  const reasoning = dominant ? REASON_MAP[dominant.type] : 'Based on company profile and industry fit'

  const ACTION_MAP: Record<string, string> = {
    EMAIL: `Send personalized email${meta.contactEmail ? ` to ${meta.contactEmail}` : ''}`,
    LINKEDIN: 'Connect on LinkedIn with personalized message',
    PHONE: `Call${meta.contactPhone ? ` ${meta.contactPhone}` : ' main number'}`,
  }
  const actionText = isProblemOwner
    ? `${ACTION_MAP[bestChannel]} — reference their specific operational pain directly`
    : ACTION_MAP[bestChannel]

  const norm = dominant ? normalizeSignal(dominant.type) : null
  const predictedNeed = norm?.predictedNeeds.slice(0, 3).join(', ') ?? 'Operational support'

  const freshnessMultiplier = isProblemOwner ? 2.0 : ageDays < 7 ? 1.3 : ageDays < 30 ? 1.0 : 0.7
  // Floor at 0.35 for Problem-Owner Activation: a confirmed activation warrants a meaningful
  // meeting probability even before the first scoring cycle sets winProbability > 0
  const safeWinProb = Number.isFinite(winProbability) ? Math.max(0, winProbability) : 0
  const rawMeetingProb = safeWinProb * freshnessMultiplier * 1.5
  const meetingProbability = Math.min(0.95, isProblemOwner ? Math.max(0.35, rawMeetingProb) : rawMeetingProb)

  return { bestContact, bestTiming, bestChannel, messageAngle, reasoning, actionText, urgency, priority, predictedNeed, meetingProbability }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

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

export function toFullSignal(s: {
  type: SignalType
  strength: number
  sourceReliability: number
  industryRelevance: number
  detectedAt: Date
  title?: string | null
  description?: string | null
}): FullSignal {
  return { ...toRawSignal(s), title: s.title, description: s.description }
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

// ── Problem-Owner Activation Detection ────────────────────────────────────────
// The signal that seals the deal: a company has a real pain, a deadline, and
// someone internally has been assigned to fix it — and they're actively looking.

// Operational triggers: events that create urgency and project/budget pressure
const OPERATIONAL_TRIGGERS = new Set<SignalType>([
  'CONTRACT_AWARDED', 'TENDER_PUBLISHED', 'PERMIT_APPROVED',
  'GOV_GRANT_RECEIVED', 'PROJECT_START_DETECTED', 'EXPANSION', 'OFFICE_OPENING',
])

// Solution-seeking signals: behaviors showing they're actively evaluating
const SOLUTION_SEEKING = new Set<SignalType>([
  'PROCUREMENT', 'PRICING_PAGE_CHANGED', 'ENTERPRISE_PAGE_LAUNCHED',
  'TECH_ADOPTION', 'TECH_STACK_CHANGED', 'WEBSITE_CHANGE',
])

// Keywords in job posting titles/descriptions that confirm operational pain ownership
export const ROLE_KEYWORDS = [
  'coordinator', 'scheduling', 'compliance', 'crew', 'subcontractor', 'subcontract',
  'site management', 'field operation', 'job tracking', 'job update', 'progress report',
  'paperwork', 'documentation', 'multi-site', 'multiple site', 'project coordinator',
  'operations coordinator', 'operations manager', 'office manager', 'workflow',
  'team coordination', 'site supervisor', 'dispatch', 'timesheet', 'rostering',
  'workforce management', 'resource planning', 'site admin', 'onboarding coordinator',
]

export type ProblemOwnerResult = {
  activated: boolean
  confidence: number
  activationTier: 'CONFIRMED' | 'PROBABLE' | 'POSSIBLE' | null
  evidencePieces: string[]
  recommendedStrength: number
}

export function detectProblemOwnerActivation(
  signals: FullSignal[],
  windowDays = 45
): ProblemOwnerResult {
  const NONE: ProblemOwnerResult = {
    activated: false, confidence: 0, activationTier: null,
    evidencePieces: [], recommendedStrength: 0,
  }

  const cutoff = new Date(Date.now() - windowDays * 86_400_000)
  const recent = signals.filter(
    s => s.type !== 'PROBLEM_OWNER_ACTIVATION' && s.detectedAt >= cutoff
  )

  // Requirement: must have at least one operational trigger in window
  const trigger = recent.find(s => OPERATIONAL_TRIGGERS.has(s.type))
  if (!trigger) return NONE

  const evidencePieces: string[] = []
  let score = 0

  // Layer 1: Operational trigger (required, 40 pts base)
  score += 40
  const triggerAge = (Date.now() - trigger.detectedAt.getTime()) / 86_400_000
  evidencePieces.push(`${trigger.type.replace(/_/g, ' ')} detected${triggerAge < 14 ? ' (fresh)' : ''}`)

  // Layer 2: Hiring with named ownership (25 pts)
  const hiringSignal = recent.find(s => s.type === 'HIRING' || s.type === 'JOB_POSTING_SPIKE')
  if (hiringSignal) {
    score += 25
    evidencePieces.push('Active hiring underway')

    // Layer 3: Role-specific keywords in job ad (20 pts) — confirms who is being assigned
    const text = `${hiringSignal.title ?? ''} ${hiringSignal.description ?? ''}`.toLowerCase()
    const matchedKeyword = ROLE_KEYWORDS.find(kw => text.includes(kw))
    if (matchedKeyword) {
      score += 20
      evidencePieces.push(`Job posting mentions "${matchedKeyword}" — operational pain confirmed`)
    }
  }

  // Layer 4: Active solution-seeking (15 pts)
  const solutionSignal = recent.find(s => SOLUTION_SEEKING.has(s.type))
  if (solutionSignal) {
    score += 15
    evidencePieces.push(`${solutionSignal.type.replace(/_/g, ' ')} — actively evaluating solutions`)
  }

  // Recency multiplier: fresh trigger amplifies urgency
  if (triggerAge < 14) {
    score = Math.round(score * 1.15)
    if (!evidencePieces[0].includes('fresh')) {
      evidencePieces[0] += ' (fresh — window is open)'
    }
  }

  const confidence = Math.min(100, score)

  // Tiers: POSSIBLE ≥45, PROBABLE ≥65, CONFIRMED ≥85
  const activationTier: ProblemOwnerResult['activationTier'] =
    confidence >= 85 ? 'CONFIRMED' :
    confidence >= 65 ? 'PROBABLE'  :
    confidence >= 45 ? 'POSSIBLE'  : null

  const recommendedStrength = activationTier === 'CONFIRMED' ? 95
    : activationTier === 'PROBABLE' ? 80
    : activationTier === 'POSSIBLE' ? 65
    : 0

  return {
    activated: activationTier !== null,
    confidence,
    activationTier,
    evidencePieces,
    recommendedStrength,
  }
}

// ── False Positive Filter ─────────────────────────────────────────────────────
// Classifies signals and prospects as IGNORE / WATCH / ACT to prevent noisy
// signals from triggering briefs, outreach, or scoring upgrades.

export type SignalDecision = 'IGNORE' | 'WATCH' | 'ACT'

export type SignalFilterResult = {
  decision:   SignalDecision
  reason:     string
  confidence: number       // 0-100
  riskFlags:  string[]
}

export type ProspectSignalClassification = {
  decision:         SignalDecision
  reason:           string
  confidence:       number
  riskFlags:        string[]
  rejectionReasons: string[]   // why individual signals were ignored
  actSignals:       RawSignal[]
  watchSignals:     RawSignal[]
  ignoredSignals:   RawSignal[]
}

// Signal types that are meaningful when standing alone (no corroboration needed).
// Value = minimum decayed-strength threshold for standalone ACT (0 = any strength).
const STRONG_STANDALONE: Partial<Record<SignalType, number>> = {
  PROBLEM_OWNER_ACTIVATION: 0,
  FUNDING:                  50,
  CONTRACT_AWARDED:         55,
  GOV_GRANT_RECEIVED:       50,
  PERMIT_APPROVED:          55,
  TENDER_PUBLISHED:         55,
}

// Signal type pairs/triples that converge to ACT when both sides are non-IGNORED.
const CONVERGENCE_PATTERNS: Array<{ name: string; requires: SignalType[] }> = [
  { name: 'contract + hiring',            requires: ['CONTRACT_AWARDED',     'HIRING']                },
  { name: 'contract + job postings',      requires: ['CONTRACT_AWARDED',     'JOB_POSTING_SPIKE']     },
  { name: 'tender + job postings',        requires: ['TENDER_PUBLISHED',     'JOB_POSTING_SPIKE']     },
  { name: 'tender + hiring',              requires: ['TENDER_PUBLISHED',     'HIRING']                },
  { name: 'grant + hiring',               requires: ['GOV_GRANT_RECEIVED',   'HIRING']                },
  { name: 'grant + job postings',         requires: ['GOV_GRANT_RECEIVED',   'JOB_POSTING_SPIKE']     },
  { name: 'permit + project start',       requires: ['PERMIT_APPROVED',      'PROJECT_START_DETECTED']},
  { name: 'funding + hiring',             requires: ['FUNDING',              'HIRING']                },
  { name: 'funding + tech adoption',      requires: ['FUNDING',              'TECH_ADOPTION']         },
  { name: 'expansion + hiring',           requires: ['EXPANSION',            'HIRING']                },
  { name: 'expansion + job postings',     requires: ['EXPANSION',            'JOB_POSTING_SPIKE']     },
  { name: 'pricing + enterprise page',    requires: ['PRICING_PAGE_CHANGED', 'ENTERPRISE_PAGE_LAUNCHED']},
  { name: 'office opening + hiring',      requires: ['OFFICE_OPENING',       'HIRING']                },
  { name: 'office opening + job posts',   requires: ['OFFICE_OPENING',       'JOB_POSTING_SPIKE']     },
  { name: 'leadership change + hiring',   requires: ['LEADERSHIP_CHANGE',    'HIRING']                },
  { name: 'tech adoption + hiring',       requires: ['TECH_ADOPTION',        'HIRING']                },
  { name: 'website change + hiring',      requires: ['WEBSITE_CHANGE',       'HIRING']                },
]

// Signal types that are too ambiguous to ACT on without a corroborating signal.
const NOISY_ALONE: Set<SignalType> = new Set([
  'WEBSITE_CHANGE', 'NEWS_MENTION', 'LEADERSHIP_CHANGE',
  'TECH_STACK_CHANGED', 'BUSINESS_REGISTRATION',
])

// Per-type maximum age before a signal is considered expired / too stale.
const SIGNAL_AGE_CUTOFFS: Partial<Record<SignalType, number>> = {
  WEBSITE_CHANGE:           45,
  NEWS_MENTION:             30,
  BUSINESS_REGISTRATION:    90,
  PRICING_PAGE_CHANGED:     45,
  ENTERPRISE_PAGE_LAUNCHED: 60,
}

// Classify a single raw signal in isolation.
export function classifySignal(signal: RawSignal): SignalFilterResult {
  const ds      = decayedStrength(signal)
  const ageDays = Math.max(0, (Date.now() - signal.detectedAt.getTime()) / 86_400_000)
  const flags:  string[] = []

  // Hard IGNORE: decayed strength too weak to matter
  if (ds < 3) {
    return { decision: 'IGNORE', reason: `signal too weak (decayed strength ${ds.toFixed(1)})`, confidence: 95, riskFlags: ['too_weak'] }
  }
  // Hard IGNORE: source too unreliable
  if (signal.sourceReliability < 35) {
    return { decision: 'IGNORE', reason: `low source reliability (${signal.sourceReliability})`, confidence: 90, riskFlags: ['low_reliability'] }
  }
  // Hard IGNORE: type-specific age cutoff exceeded
  const maxAge = SIGNAL_AGE_CUTOFFS[signal.type]
  if (maxAge !== undefined && ageDays > maxAge) {
    return { decision: 'IGNORE', reason: `${signal.type} expired (>${maxAge}d limit, currently ${Math.round(ageDays)}d old)`, confidence: 88, riskFlags: ['expired'] }
  }

  // Soft risk flags (don't disqualify, but caller should note them)
  if (signal.sourceReliability < 55) flags.push('low_reliability')
  if (ageDays > 30) flags.push('stale')

  // Strong standalone types
  const standaloneThreshold = STRONG_STANDALONE[signal.type]
  if (standaloneThreshold !== undefined && ds >= standaloneThreshold) {
    return {
      decision:   'ACT',
      reason:     `strong standalone signal: ${signal.type} (strength ${Math.round(ds)})`,
      confidence: Math.min(92, 60 + Math.round(ds / 4)),
      riskFlags:  flags,
    }
  }

  // Noisy-alone types that require corroboration
  if (NOISY_ALONE.has(signal.type) && ds < 50) {
    return {
      decision:   'WATCH',
      reason:     `${signal.type} alone is ambiguous — needs corroborating signal`,
      confidence: 60,
      riskFlags:  [...flags, 'needs_corroboration'],
    }
  }

  // Default threshold: strong enough to ACT alone, otherwise WATCH
  return {
    decision:   ds >= 40 ? 'ACT' : 'WATCH',
    reason:     ds >= 40
      ? `strong signal (decayed strength ${Math.round(ds)})`
      : `moderate signal (decayed strength ${Math.round(ds)}) — monitoring`,
    confidence: Math.min(85, 45 + Math.round(ds / 3)),
    riskFlags:  flags,
  }
}

// Classify a prospect's full signal set, applying convergence rules.
export function classifyProspectSignals(
  signals: RawSignal[],
  meta: ProspectMeta
): ProspectSignalClassification {
  if (signals.length === 0) {
    return {
      decision: 'IGNORE', reason: 'no signals', confidence: 100,
      riskFlags: ['no_signals'], rejectionReasons: ['no signals detected'],
      actSignals: [], watchSignals: [], ignoredSignals: [],
    }
  }

  const classified   = signals.map(s => ({ signal: s, result: classifySignal(s) }))
  const actSignals   = classified.filter(c => c.result.decision === 'ACT').map(c => c.signal)
  const watchSignals = classified.filter(c => c.result.decision === 'WATCH').map(c => c.signal)
  const ignoredSigs  = classified.filter(c => c.result.decision === 'IGNORE').map(c => c.signal)
  const rejectionReasons = classified
    .filter(c => c.result.decision === 'IGNORE')
    .map(c => `[${c.signal.type}] ${c.result.reason}`)

  // Active types: signal types that are not IGNORE
  const activeTypes = new Set([...actSignals, ...watchSignals].map(s => s.type))

  // Risk flags
  const riskFlags: string[] = []
  if (!meta.contactEmail) riskFlags.push('no_contact_email')
  if (!meta.domain)       riskFlags.push('no_domain')
  if (actSignals.length + watchSignals.length === 1) riskFlags.push('single_signal')
  const avgAge = signals.reduce(
    (sum, s) => sum + Math.max(0, (Date.now() - s.detectedAt.getTime()) / 86_400_000), 0
  ) / signals.length
  if (avgAge > 30) riskFlags.push('stale_signals')
  const avgReliability = signals.reduce((sum, s) => sum + s.sourceReliability, 0) / signals.length
  if (avgReliability < 60) riskFlags.push('low_avg_reliability')

  // Rule 1: any POA signal → immediate ACT (buying window is open by definition)
  const hasPoa = activeTypes.has('PROBLEM_OWNER_ACTIVATION')
  if (hasPoa) {
    return {
      decision: 'ACT', reason: 'Problem-Owner Activation detected — buying window is open',
      confidence: 92, riskFlags, rejectionReasons, actSignals, watchSignals, ignoredSignals: ignoredSigs,
    }
  }

  // Rule 2: convergence pattern match
  for (const pattern of CONVERGENCE_PATTERNS) {
    if (pattern.requires.every(t => activeTypes.has(t))) {
      return {
        decision: 'ACT', reason: `converging signals: ${pattern.name}`,
        confidence: 85, riskFlags, rejectionReasons, actSignals, watchSignals, ignoredSignals: ignoredSigs,
      }
    }
  }

  // Rule 3: 3+ distinct non-ignored signal types = convergence by volume
  if (activeTypes.size >= 3) {
    return {
      decision: 'ACT', reason: `${activeTypes.size} distinct signal types converging`,
      confidence: 80, riskFlags, rejectionReasons, actSignals, watchSignals, ignoredSignals: ignoredSigs,
    }
  }

  // Rule 4: any individually strong ACT signal
  if (actSignals.length > 0) {
    const lead = actSignals[0]
    return {
      decision: 'ACT', reason: `${lead.type} is a strong standalone signal`,
      confidence: 75, riskFlags, rejectionReasons, actSignals, watchSignals, ignoredSignals: ignoredSigs,
    }
  }

  // Rule 5: only WATCH signals — monitor but don't send
  if (watchSignals.length > 0) {
    return {
      decision: 'WATCH', reason: `${watchSignals.length} signal${watchSignals.length > 1 ? 's' : ''} — waiting for corroboration`,
      confidence: 60, riskFlags, rejectionReasons, actSignals: [], watchSignals, ignoredSignals: ignoredSigs,
    }
  }

  return {
    decision: 'IGNORE', reason: 'all signals are too weak, expired, or unreliable',
    confidence: 88, riskFlags: [...riskFlags, 'all_ignored'], rejectionReasons,
    actSignals: [], watchSignals: [], ignoredSignals: ignoredSigs,
  }
}

// Derive the sorted, deduped signal pattern key used for combination performance tracking.
// e.g. ['JOB_POSTING_SPIKE', 'FUNDING', 'HIRING'] → "FUNDING|HIRING|JOB_POSTING_SPIKE"
export function signalPatternKey(signals: RawSignal[]): string {
  const types = [...new Set(signals.map(s => s.type))].sort()
  return types.join('|') || 'NONE'
}
