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

/**
 * A workspace's configured target industries, driving the industry sub-score. Empty
 * when the workspace hasn't set an ICP — in which case the scorer falls back to the
 * built-in field-service default. Pass the result as the 3rd arg to
 * explainLeadScore / computeLeadScore so scores are calibrated to the workspace's
 * actual ICP rather than the default vertical.
 */
export async function getWorkspaceIcpTargets(workspaceId: string): Promise<string[]> {
  const icp = await prisma.workspaceICP.findUnique({ where: { workspaceId }, select: { targetIndustries: true } })
  return icp?.targetIndustries ?? []
}

// Built-in DEFAULT ICP: field-service companies (civil, electrical, plumbing,
// landscaping, etc.). Used only when a workspace has NOT configured its own
// `WorkspaceICP.targetIndustries` — see scoreIndustry. This is the product's
// default vertical, not a hard limit: a workspace targeting any other industry
// scores against its own configured targets instead.
const ICP_PRIMARY = ['civil', 'electrical', 'plumbing', 'landscaping', 'facilities', 'hvac',
  'roofing', 'painting', 'flooring', 'mechanical', 'structural', 'construction',
  'environmental', 'infrastructure', 'utility', 'utilities', 'contractor', 'contracting']

const ICP_ADJACENT = ['maintenance', 'repair', 'service', 'installation', 'inspection',
  'cleaning', 'pest', 'security', 'fire', 'elevator', 'telecom']

// Score how well a lead's industry matches the workspace's ICP.
//   • If the workspace configured `targetIndustries`, match against those (a hit is
//     a strong fit, anything else is out-of-ICP) — so scores are meaningful for ANY
//     vertical, not just field service.
//   • Otherwise fall back to the built-in field-service taxonomy (with its primary
//     / adjacent tiers), preserving the default behavior for field-service workspaces.
function scoreIndustry(category: string | null | undefined, icpTargets?: string[]): number {
  if (!category) return 0.30
  const lower = category.toLowerCase()

  const targets = (icpTargets ?? []).map(t => t.toLowerCase().trim()).filter(Boolean)
  if (targets.length > 0) {
    return targets.some(t => lower.includes(t) || t.includes(lower)) ? 1.00 : 0.25
  }

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

// Bucketed company-size fit, normalized 0..1. FieldOps's ICP targets roughly
// 5-200 employees (see packs/fieldops.ts), so the 10-50 sweet spot scores
// highest, 50-200 is still solid, and both very small and enterprise-scale
// buckets score lower. Falls back to the prior neutral placeholder (0.65) when
// no estimate is available — a lead should never be penalized just for lacking
// this enrichment.
const TEAM_SIZE_FIT: Record<string, number> = {
  '1-10': 0.55,
  '10-50': 1.00,
  '50-200': 0.85,
  '200-500': 0.35,
  '500+': 0.15,
}
const DEFAULT_SIZE_FIT = 0.65

function scoreSize(estimatedTeamSize: string | null | undefined): number {
  if (!estimatedTeamSize) return DEFAULT_SIZE_FIT
  return TEAM_SIZE_FIT[estimatedTeamSize] ?? DEFAULT_SIZE_FIT
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
  estimatedTeamSize?: string | null
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
  industry: (v) => (v >= 0.9 ? 'Core ICP industry match' : v >= 0.6 ? 'Adjacent service industry' : 'Industry outside the core ICP'),
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

function computeSignals(lead: LeadInput, icpTargets?: string[]): ScoreSignals {
  const combined = [lead.notes, lead.aiSummary, lead.outreachAngle, lead.businessName]
    .filter(Boolean).join(' ').toLowerCase()

  return {
    industry: scoreIndustry(lead.category, icpTargets),
    size: scoreSize(lead.estimatedTeamSize),
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
export function explainLeadScore(lead: LeadInput, weights: ScoringWeights = DEFAULT_SCORING_WEIGHTS, icpTargets?: string[]): LeadScoreExplanation {
  const signals = computeSignals(lead, icpTargets)
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

export function computeLeadScore(lead: LeadInput, weights: ScoringWeights = DEFAULT_SCORING_WEIGHTS, icpTargets?: string[]): number {
  return explainLeadScore(lead, weights, icpTargets).score
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

// ---------------------------------------------------------------------------
// Outcome-driven weight retuning — the "learning loop". Single source of truth
// so every path that records a ScoringOutcome (the external FieldOps ingest
// endpoint AND the product's own analyze-reply -> applyReplyAnalysis pipeline)
// retunes the SAME workspace weights the SAME way, instead of two independent
// implementations drifting apart. Ported from the former outcomes.ts-local
// ScorerV2.updateWeights() logic.
// ---------------------------------------------------------------------------

export type ScoringPerformanceMetrics = {
  totalScored: number
  totalReplied: number
  replyRate: number
  avgScoreOfReplied: number
  avgScoreOfNotReplied: number
  correlationScore: number
}

export const DEFAULT_SCORING_METRICS: ScoringPerformanceMetrics = {
  totalScored: 0,
  totalReplied: 0,
  replyRate: 0,
  avgScoreOfReplied: 0,
  avgScoreOfNotReplied: 0,
  correlationScore: 0,
}

export type ScoringOutcomeSample = { score: number; replied: boolean; messageRelevance: number; channelUsed: string }

export function calculateOutcomeCorrelation(outcomes: ScoringOutcomeSample[]): number {
  const replied = outcomes.filter((o) => o.replied)
  const notReplied = outcomes.filter((o) => !o.replied)
  if (replied.length === 0 || notReplied.length === 0) return 0

  const meanScore = outcomes.reduce((s, o) => s + o.score, 0) / outcomes.length
  const meanReply = replied.length / outcomes.length

  let numerator = 0, denomScore = 0, denomReply = 0
  for (const o of outcomes) {
    const sd = o.score - meanScore
    const rd = (o.replied ? 1 : 0) - meanReply
    numerator += sd * rd
    denomScore += sd * sd
    denomReply += rd * rd
  }
  if (denomScore === 0 || denomReply === 0) return 0
  return numerator / Math.sqrt(denomScore * denomReply)
}

/**
 * Pure weight-retuning step: given a workspace's recorded outcomes and its
 * current weights, nudge weights toward whatever actually correlates with
 * replies, clamp to >= 0, and renormalize to sum to 1. Also returns the
 * performance metrics snapshot (reply rate, correlation, etc.) for the caller
 * to persist alongside the retuned weights.
 */
export function recomputeScoringWeights(
  outcomes: ScoringOutcomeSample[],
  current: ScoringWeights,
): { weights: ScoringWeights; metrics: ScoringPerformanceMetrics } {
  const replied = outcomes.filter((o) => o.replied)
  const notReplied = outcomes.filter((o) => !o.replied)

  const avgReplied = replied.length > 0
    ? replied.reduce((s, o) => s + o.score, 0) / replied.length : 0
  const avgNotReplied = notReplied.length > 0
    ? notReplied.reduce((s, o) => s + o.score, 0) / notReplied.length : 0

  const correlation = calculateOutcomeCorrelation(outcomes)
  const replyRate = outcomes.length > 0 ? replied.length / outcomes.length : 0

  const w = { ...current }
  const lr = 0.1

  // Weak correlation -> shift weight from ICP to message/channel fit
  if (correlation < 0.3) {
    w.messageRelevance += lr * 0.02
    w.channelFit += lr * 0.02
    w.industry -= lr * 0.01
  }

  // Message relevance impact
  const msgImpact = replied.length > 0
    ? replied.reduce((s, o) => s + o.messageRelevance, 0) / replied.length : 0
  if (msgImpact > 0.7) w.messageRelevance += lr * 0.01

  // Channel impact — if LinkedIn replies outpace email, boost channelFit
  const emailReplies = replied.filter((o) => o.channelUsed === 'EMAIL').length
  const linkedinReplies = replied.filter((o) => o.channelUsed === 'LINKEDIN').length
  if (linkedinReplies > emailReplies * 1.5) w.channelFit += lr * 0.01

  // Clamp all weights to >= 0, then normalize to sum = 1
  const weightKeys = Object.keys(DEFAULT_SCORING_WEIGHTS) as (keyof ScoringWeights)[]
  for (const k of weightKeys) {
    w[k] = Math.max(0, w[k])
  }
  const total = weightKeys.reduce((s, k) => s + w[k], 0)
  if (total > 0) {
    for (const k of weightKeys) {
      w[k] = w[k] / total
    }
  }

  return {
    weights: w,
    metrics: {
      totalScored: outcomes.length,
      totalReplied: replied.length,
      replyRate,
      avgScoreOfReplied: avgReplied,
      avgScoreOfNotReplied: avgNotReplied,
      correlationScore: correlation,
    },
  }
}

// Retune every Nth recorded outcome (rather than on every single one) so a
// lone reply/non-reply can't swing weights on noise.
const RECOMPUTE_EVERY_N_OUTCOMES = 7

/**
 * After a ScoringOutcome row has been recorded for a scoring model, check
 * whether it's time to retune weights (every Nth outcome) and do so if it is.
 * Shared by every path that records outcomes — the external FieldOps ingest
 * endpoint (POST /api/outcomes) and the product's own reply-analysis pipeline
 * (applyReplyAnalysis) — so a customer's own reply data improves their own
 * scoring weights the same way FieldOps's does. Returns true when weights were
 * actually updated (so the caller can invalidate any cached stats), alongside
 * the total outcome count so callers don't need a second count query.
 */
export async function maybeRecomputeScoringWeights(
  scoringModelId: string,
  currentWeights: ScoringWeights,
): Promise<{ updated: boolean; totalOutcomes: number }> {
  const totalOutcomes = await prisma.scoringOutcome.count({ where: { scoringModelId } })
  if (totalOutcomes < RECOMPUTE_EVERY_N_OUTCOMES || totalOutcomes % RECOMPUTE_EVERY_N_OUTCOMES !== 0) {
    return { updated: false, totalOutcomes }
  }

  const all = await prisma.scoringOutcome.findMany({
    where: { scoringModelId },
    select: { score: true, replied: true, messageRelevance: true, channelUsed: true },
  })

  const { weights, metrics } = recomputeScoringWeights(all, currentWeights)

  await prisma.scoringModel.update({
    where: { id: scoringModelId },
    data: { weights, performanceMetrics: metrics, updateCount: { increment: 1 }, lastWeightUpdate: new Date() },
  })
  return { updated: true, totalOutcomes }
}
