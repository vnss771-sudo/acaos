// Lead ICP scoring — maps available lead fields to signal vectors
// Uses the same weight schema as ScorerV2 / outcomes.ts

import { prisma } from './prisma.js'

export type ScoringWeights = {
  industry: number
  size: number
  hiring: number
  tech: number
  growth: number
  contact: number
  messageRelevance: number
  channelFit: number
  timingFit: number
  dataFreshness: number
}

export const DEFAULT_SCORING_WEIGHTS: ScoringWeights = {
  industry: 0.20,
  size: 0.18,
  hiring: 0.15,
  tech: 0.12,
  growth: 0.12,
  contact: 0.08,
  messageRelevance: 0.08,
  channelFit: 0.05,
  timingFit: 0.02,
  dataFreshness: 0.00
}

/**
 * A workspace's configured scoring weights, falling back to the defaults when none
 * are set. Single source of truth shared by the API (lead create/update rescoring)
 * and the worker (research-lead scoring) so the schema-handling cast lives in one
 * place. Imported lazily — `prisma` is the shared lazy singleton, so this adds no
 * cost to callers that never invoke it.
 */
export async function getWorkspaceWeights(workspaceId: string): Promise<ScoringWeights> {
  const model = await prisma.scoringModel.findUnique({ where: { workspaceId }, select: { weights: true } })
  return (model?.weights as ScoringWeights | null) ?? DEFAULT_SCORING_WEIGHTS
}

// Target ICP: field-service companies (civil, electrical, plumbing, landscaping, etc.)
const ICP_PRIMARY = ['civil', 'electrical', 'plumbing', 'landscaping', 'facilities', 'hvac',
  'roofing', 'painting', 'flooring', 'mechanical', 'structural', 'construction',
  'environmental', 'infrastructure', 'utility', 'utilities', 'contractor', 'contracting']

const ICP_ADJACENT = ['maintenance', 'repair', 'service', 'installation', 'inspection',
  'cleaning', 'pest', 'security', 'fire', 'elevator', 'telecom']

function scoreIndustry(category: string | null | undefined): number {
  if (!category) return 0.30
  const lower = category.toLowerCase()
  if (ICP_PRIMARY.some(k => lower.includes(k))) return 1.00
  if (ICP_ADJACENT.some(k => lower.includes(k))) return 0.70
  return 0.25
}

const HIRING_KEYWORDS = ['hiring', 'now hiring', 'job opening', 'job posting', 'recruiting',
  'looking for', 'position available', 'we are growing', 'join our team', 'career opportunity']

function scoreHiring(combined: string): number {
  return HIRING_KEYWORDS.some(k => combined.includes(k)) ? 1.00 : 0.10
}

const GROWTH_KEYWORDS = ['expanding', 'new contract', 'new project', 'new office', 'acquisition',
  'series a', 'series b', 'funded', 'raised', 'opening', 'growth', 'scale', 'scaling',
  'increased revenue', 'record', 'won contract', 'awarded']

function scoreGrowth(combined: string): number {
  const found = GROWTH_KEYWORDS.filter(k => combined.includes(k)).length
  return Math.min(1.0, found * 0.30)
}

const HIGH_TECH_KEYWORDS = ['salesforce', 'hubspot', 'microsoft dynamics', 'sap', 'oracle',
  'servicenow', 'workday', 'zendesk', 'marketo', 'enterprise software', 'erp system']

function scoreTech(combined: string): number {
  // Inverse: low tech adoption = better fit for field ops software
  const isHighTech = HIGH_TECH_KEYWORDS.some(k => combined.includes(k))
  return isHighTech ? 0.25 : 1.00
}

function scoreContact(email: string | null | undefined, contactName: string | null | undefined): number {
  let score = 0
  if (email) score += 0.65
  if (contactName) score += 0.35
  return Math.min(1.0, score)
}

function scoreChannelFit(email: string | null | undefined, website: string | null | undefined): number {
  if (email) return 0.90
  if (website) return 0.60
  return 0.30
}

function scoreDataFreshness(aiSummary: string | null | undefined): number {
  return aiSummary ? 0.85 : 0.50
}

type LeadInput = {
  category?: string | null
  businessName: string
  contactName?: string | null
  email?: string | null
  website?: string | null
  notes?: string | null
  aiSummary?: string | null
  outreachAngle?: string | null
}

export type ScoreSignals = Record<keyof ScoringWeights, number>

// One signal's contribution to the final score: its raw strength (0..1), the
// configured weight, and weight×strength (its share of the 0..1 pre-scaled total).
export type ScoreReason = {
  signal: keyof ScoringWeights
  value: number
  weight: number
  contribution: number
}

// The score plus *why* it is what it is. Surfacing this turns an opaque "75" into
// a defensible, auditable assessment — and, unlike the model's self-reported
// icpScore, it is deterministic and fully testable (no LLM trust required).
export type LeadScoreExplanation = {
  score: number
  tier: 'HOT' | 'WARM' | 'COLD'
  signals: ScoreSignals
  reasons: ScoreReason[] // every signal, sorted by contribution (desc)
  topReasons: string[] // human-readable headline drivers, highest-impact first
}

// Constant placeholder signals carry no evidence (they are fixed defaults until a
// richer enrichment fills them in), so they are excluded from the human-readable
// topReasons — they would otherwise crowd out the signals that actually differ.
const CONSTANT_SIGNALS = new Set<keyof ScoringWeights>(['size', 'messageRelevance', 'timingFit'])

// Maps a signal's strength to a short, human phrase. Deterministic and band-based
// so the same inputs always produce the same rationale.
const SIGNAL_LABELS: Record<keyof ScoringWeights, (v: number) => string> = {
  industry: (v) => (v >= 0.9 ? 'Core ICP industry match (field service)' : v >= 0.6 ? 'Adjacent service industry' : 'Industry outside the core ICP'),
  size: (v) => (v >= 0.6 ? 'Team size in the target range' : 'Team size likely too small or unknown'),
  hiring: (v) => (v >= 0.9 ? 'Active hiring / expansion signal' : 'No hiring signal found'),
  tech: (v) => (v >= 0.9 ? 'Low existing software footprint (good fit)' : 'Already runs enterprise software (saturated)'),
  growth: (v) => (v >= 0.6 ? 'Multiple growth signals' : v > 0 ? 'Some growth signal' : 'No growth signal found'),
  contact: (v) => (v >= 0.9 ? 'Direct contact (name + email) available' : v >= 0.5 ? 'Partial contact details' : 'No contact details'),
  messageRelevance: () => 'Message relevance (default — needs enrichment)',
  channelFit: (v) => (v >= 0.9 ? 'Reachable by email' : v >= 0.6 ? 'Website-only channel' : 'Weak channel fit'),
  timingFit: () => 'Timing fit (default — needs signal data)',
  dataFreshness: (v) => (v >= 0.8 ? 'Enriched with current research' : 'Limited research data'),
}

function computeSignals(lead: LeadInput): ScoreSignals {
  const combined = [lead.notes, lead.aiSummary, lead.outreachAngle, lead.businessName]
    .filter(Boolean).join(' ').toLowerCase()

  return {
    industry: scoreIndustry(lead.category),
    size: 0.65, // default medium — unknown without enrichment
    hiring: scoreHiring(combined),
    tech: scoreTech(combined),
    growth: scoreGrowth(combined),
    contact: scoreContact(lead.email, lead.contactName),
    messageRelevance: 0.50,
    channelFit: scoreChannelFit(lead.email, lead.website),
    timingFit: 0.50,
    dataFreshness: scoreDataFreshness(lead.aiSummary),
  }
}

/**
 * Score a lead AND explain the result: the per-signal breakdown, every signal's
 * weighted contribution (sorted), and a few human-readable headline drivers.
 * `computeLeadScore` delegates here, so the number is guaranteed identical to the
 * explained score.
 */
export function explainLeadScore(lead: LeadInput, weights: ScoringWeights = DEFAULT_SCORING_WEIGHTS): LeadScoreExplanation {
  const signals = computeSignals(lead)
  const keys = Object.keys(weights) as (keyof ScoringWeights)[]

  const raw = keys.reduce((sum, k) => sum + signals[k] * weights[k], 0)
  const score = Math.round(Math.min(100, Math.max(0, raw * 100)))

  const reasons: ScoreReason[] = keys
    .map((k) => ({ signal: k, value: signals[k], weight: weights[k], contribution: signals[k] * weights[k] }))
    .sort((a, b) => b.contribution - a.contribution)

  const topReasons = reasons
    // A workspace may carry custom/legacy weights whose keys are outside the
    // canonical signal set; those have no label and no computed signal, so skip
    // them rather than throwing — the weighted score above is unaffected.
    .filter((r) => r.weight > 0 && !CONSTANT_SIGNALS.has(r.signal) && typeof SIGNAL_LABELS[r.signal] === 'function')
    .slice(0, 3)
    .map((r) => SIGNAL_LABELS[r.signal](r.value))

  return { score, tier: getScoreTier(score), signals, reasons, topReasons }
}

export function computeLeadScore(lead: LeadInput, weights: ScoringWeights = DEFAULT_SCORING_WEIGHTS): number {
  return explainLeadScore(lead, weights).score
}

export function getScoreTier(score: number): 'HOT' | 'WARM' | 'COLD' {
  if (score >= 72) return 'HOT'
  if (score >= 48) return 'WARM'
  return 'COLD'
}

export const TIER_COLOR: Record<string, string> = {
  HOT: '#ef4444',
  WARM: '#f59e0b',
  COLD: '#475569'
}
