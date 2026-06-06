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

export type View = 'dashboard' | 'campaigns' | 'leads' | 'ai' | 'billing' | 'settings'

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
