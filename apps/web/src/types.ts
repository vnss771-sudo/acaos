export type User = {
  id: string
  email: string
  name?: string | null
}

export type Workspace = {
  id: string
  name: string
  slug: string
  plan: string
  subscriptionStatus?: string | null
  createdAt?: string
  _count?: { leads: number; campaigns: number }
}

export type Campaign = {
  id: string
  name: string
  goalType: string
  description?: string | null
  createdAt: string
  _count?: { leads: number }
}

export type Lead = {
  id: string
  businessName: string
  contactName?: string | null
  email?: string | null
  phone?: string | null
  website?: string | null
  city?: string | null
  category?: string | null
  notes?: string | null
  aiSummary?: string | null
  outreachAngle?: string | null
  score: number
  stage: string
  campaignId?: string | null
  lastContactedAt?: string | null
  createdAt?: string
}

export type OutreachDraft = {
  id: string
  subject: string
  emailBody: string
  followup?: string | null
  createdAt: string
}

export type ScoringModel = {
  weights: Record<string, number>
  metrics: {
    totalScored: number
    totalReplied: number
    replyRate: number
    avgScoreOfReplied: number
    avgScoreOfNotReplied: number
    correlationScore: number
  }
  updateCount: number
  lastWeightUpdate: string | null
}

export type UsageData = {
  month: string
  totals: { AI_RESEARCH: number; AI_OUTREACH: number; AI_REPLY: number }
  total: number
  limit: number   // -1 = unlimited
  plan: string
  maxLeads: number  // -1 = unlimited
}

export type StatsData = {
  totalLeads: number
  campaignCount: number
  funnel: Record<string, number>
  metrics: {
    replyRate: number
    bookingRate: number
    closeRate: number
    contacted: number
    replied: number
    booked: number
    closed: number
  }
  recentLeads: Array<{ id: string; businessName: string; stage: string; score: number; category?: string | null; createdAt: string }>
  topLeads: Array<{ id: string; businessName: string; stage: string; score: number; category?: string | null }>
  scoreDistribution: { HOT: number; WARM: number; COLD: number }
  scoringModel: ScoringModel | null
  usage: UsageData
}

export type View = 'dashboard' | 'intelligence' | 'prospects' | 'campaigns' | 'leads' | 'ai' | 'billing' | 'settings'

export const STAGES = ['NEW', 'RESEARCHED', 'OUTREACH_SENT', 'REPLIED', 'BOOKED', 'CLOSED', 'DEAD'] as const
export type Stage = typeof STAGES[number]

export const STAGE_COLOR: Record<string, string> = {
  NEW: '#475569',
  RESEARCHED: '#3b82f6',
  OUTREACH_SENT: '#8b5cf6',
  REPLIED: '#f59e0b',
  BOOKED: '#10b981',
  CLOSED: '#22c55e',
  DEAD: '#ef4444'
}

export const TIER_COLOR: Record<string, string> = {
  HOT: '#ef4444',
  WARM: '#f59e0b',
  COLD: '#475569'
}

export function getScoreTier(score: number): 'HOT' | 'WARM' | 'COLD' {
  if (score >= 72) return 'HOT'
  if (score >= 48) return 'WARM'
  return 'COLD'
}

export const GOAL_TYPES = ['BOOK_CALL', 'GET_REPLY', 'DRIVE_TRAFFIC', 'OTHER'] as const

export const PLAN_LABELS: Record<string, string> = {
  free: 'Free',
  starter: 'Starter',
  growth: 'Growth'
}

export type SignalType =
  | 'HIRING' | 'FUNDING' | 'EXPANSION' | 'TECH_ADOPTION' | 'LEADERSHIP_CHANGE'
  | 'NEWS_MENTION' | 'PROCUREMENT' | 'BUSINESS_REGISTRATION' | 'WEBSITE_CHANGE'

export type BuyingStage = 'RESEARCHING' | 'EVALUATING' | 'COMPARING' | 'PURCHASING' | 'INACTIVE'
export type OutcomeStage = 'DISCOVERED' | 'VIEWED' | 'CONTACTED' | 'MEETING' | 'PROPOSAL' | 'WON' | 'LOST'

export type Signal = {
  id: string
  type: SignalType
  strength: number
  sourceReliability: number
  industryRelevance: number
  title?: string | null
  description?: string | null
  source?: string | null
  sourceUrl?: string | null
  detectedAt: string
  createdAt: string
}

export type Recommendation = {
  id: string
  bestContact?: string | null
  bestTiming?: string | null
  bestChannel?: string | null
  messageAngle?: string | null
  reasoning?: string | null
  actionText?: string | null
  urgency: string
  priority: number
  expiresAt?: string | null
  actedAt?: string | null
  createdAt: string
}

export type Prospect = {
  id: string
  workspaceId: string
  companyName: string
  domain?: string | null
  industry?: string | null
  employeeCount?: number | null
  estimatedRevenue?: number | null
  location?: string | null
  description?: string | null
  contactName?: string | null
  contactEmail?: string | null
  contactPhone?: string | null
  contactTitle?: string | null
  linkedinUrl?: string | null
  opportunityScore: number
  intentScore: number
  fitScore: number
  timingScore: number
  confidenceScore: number
  tier: 'HOT' | 'WARM' | 'COLD'
  buyingStage: BuyingStage
  outcomeStage: OutcomeStage
  expectedDealValue?: number | null
  winProbability?: number | null
  lastSignalAt?: string | null
  lastContactedAt?: string | null
  aiSummary?: string | null
  signalCount?: number
  latestSignal?: Signal | null
  topRecommendation?: Recommendation | null
  signals?: Signal[]
  recommendations?: Recommendation[]
  createdAt: string
}

export type OpportunitiesData = {
  hot: Prospect[]
  warm: Prospect[]
  cold: Prospect[]
  totals: { hot: number; warm: number; cold: number; total: number }
}

export type ForecastData = {
  summary: {
    totalProspects: number
    totalPipelineValue: number
    weightedForecast: number
    wonRevenue: number
    wonCount: number
    avgDealValue: number
    avgWinRate: number
  }
  stageBreakdown: Record<string, { count: number; forecast: number }>
  pipeline: Array<{
    id: string
    companyName: string
    buyingStage: BuyingStage
    opportunityScore: number
    dealValue: number
    winProbability: number
    expectedRevenue: number
    tier: 'HOT' | 'WARM' | 'COLD'
  }>
}

export const BUYING_STAGE_LABELS: Record<BuyingStage, string> = {
  INACTIVE: 'Inactive',
  RESEARCHING: 'Researching',
  EVALUATING: 'Evaluating',
  COMPARING: 'Comparing',
  PURCHASING: 'Purchasing'
}

export const BUYING_STAGE_COLOR: Record<BuyingStage, string> = {
  INACTIVE: '#475569',
  RESEARCHING: '#64748b',
  EVALUATING: '#3b82f6',
  COMPARING: '#8b5cf6',
  PURCHASING: '#22c55e'
}

export const OUTCOME_STAGE_COLOR: Record<OutcomeStage, string> = {
  DISCOVERED: '#475569',
  VIEWED: '#64748b',
  CONTACTED: '#3b82f6',
  MEETING: '#f59e0b',
  PROPOSAL: '#8b5cf6',
  WON: '#22c55e',
  LOST: '#ef4444'
}

export const SIGNAL_TYPE_ICONS: Record<SignalType, string> = {
  FUNDING: '💰',
  HIRING: '👥',
  EXPANSION: '📈',
  TECH_ADOPTION: '⚙️',
  LEADERSHIP_CHANGE: '👤',
  NEWS_MENTION: '📰',
  PROCUREMENT: '🛒',
  BUSINESS_REGISTRATION: '📋',
  WEBSITE_CHANGE: '🌐'
}

export const SIGNAL_TYPE_LABELS: Record<SignalType, string> = {
  FUNDING: 'Funding',
  HIRING: 'Hiring',
  EXPANSION: 'Expansion',
  TECH_ADOPTION: 'Tech Adoption',
  LEADERSHIP_CHANGE: 'Leadership Change',
  NEWS_MENTION: 'News Mention',
  PROCUREMENT: 'Procurement',
  BUSINESS_REGISTRATION: 'Business Registration',
  WEBSITE_CHANGE: 'Website Change'
}
