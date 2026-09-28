import { EVENT_BASE_WEIGHTS } from './signalEngine.js'
import type { SignalType } from './signalEngine.js'

type Outcome = {
  stage: 'WON' | 'LOST'
  // Optional: when present, the outcome's contribution to the baseline win
  // rate and per-signal-type win rates is recency-weighted (see
  // outcomeRecencyWeight below). Absent (e.g. existing callers/tests) is
  // treated as "as of `now`" — full weight, matching the old unweighted
  // behavior exactly.
  recordedAt?: Date | string
  prospect: {
    industry: string | null
    employeeCount: number | null
    signals: Array<{ type: string }>
  }
}

type CalibrateStats = {
  calibrated: boolean
  reason?: string
  totalOutcomes: number
  baselineWinRate: number
}

export type SegmentInsight = {
  segment: string
  won: number
  total: number
  observedWinRate: number
  adjustedWinRate: number // shrunk toward baseline (SHRINKAGE_PRIOR)
  lift: number // adjustedWinRate / baselineWinRate
}

export type CalibrateResult = {
  stats: CalibrateStats
  industryInsights: SegmentInsight[]
  signalWeights: Record<string, number>
  icpUpdate: {
    targetIndustries?: string[]
    minEmployees?: number
    maxEmployees?: number
  }
}

// Cold-start gate: minimum outcome sample size before calibrate() will trust
// the data enough to recompute anything. 10 is a conservative default, not a
// tightly derived optimum: it bounds the standard error of the baseline win
// rate — SE = sqrt(p(1-p)/n), worst case ~0.158 (≈16 points) at n=10, p=0.5 —
// which every per-signal lift multiplier below is computed against, and it
// gives at least a couple of signal types a realistic shot at clearing the
// MIN_TYPE_SAMPLES floor. Below this, the baseline itself is too noisy to use
// as a pivot, and per-type shrinkage (SHRINKAGE_PRIOR below) cannot fix a bad
// reference point — it only protects individual *types* from overfitting, not
// the shared baseline they're all measured against. A workspace that wants
// faster feedback (and will accept noisier early weights) can lower this via
// LEARNING_LOOP_MIN_OUTCOMES; there's no evidence a single "better" default
// suits every workspace, so it's configurable rather than hardcoded lower.
export function learningLoopMinOutcomes(): number {
  const n = Number(process.env.LEARNING_LOOP_MIN_OUTCOMES)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 10
}

// Per-signal-type minimum sample size before its win rate is trusted at all.
const MIN_TYPE_SAMPLES = 3
// Pseudocount strength for shrinking a per-type win rate toward the baseline.
// A tiny sample (e.g. 3/3 wins) is pulled most of the way back to baseline, so it
// can't swing the weight to the 2x cap off a lucky streak; large samples are
// barely affected. This is Laplace/Bayesian shrinkage with a baseline prior.
const SHRINKAGE_PRIOR = 5

// Recency half-life (days) for weighting outcomes in the baseline and
// per-signal-type win-rate calculations: an outcome this many days old
// contributes half the weight of one recorded "now", decaying exponentially
// beyond that. Default 180 days (~1 quarter) — long enough that a normal
// sales-cycle-length gap between recording outcomes doesn't discount a deal
// that's still representative of the current market, short enough that a
// reply from a year ago (product/ICP/market likely shifted) counts for a
// quarter of a fresh one rather than being weighted equally forever. Tunable
// via LEARNING_LOOP_RECENCY_HALF_LIFE_DAYS for workspaces whose market moves
// faster or slower than that.
export function learningLoopRecencyHalfLifeDays(): number {
  const n = Number(process.env.LEARNING_LOOP_RECENCY_HALF_LIFE_DAYS)
  return Number.isFinite(n) && n > 0 ? n : 180
}

/**
 * Exponential-decay recency weight for one outcome: 1.0 when recorded at
 * `now`, halving every `halfLifeDays`. Pure — given the same three inputs it
 * always returns the same weight. A future-dated `recordedAt` (clock skew /
 * bad data) is clamped to age 0 rather than boosted above full weight.
 */
export function outcomeRecencyWeight(recordedAt: Date, now: Date, halfLifeDays: number): number {
  if (!(halfLifeDays > 0) || !Number.isFinite(recordedAt.getTime()) || !Number.isFinite(now.getTime())) return 1
  const ageDays = Math.max(0, (now.getTime() - recordedAt.getTime()) / 86_400_000)
  return Math.pow(0.5, ageDays / halfLifeDays)
}

export function calibrate(outcomes: Outcome[], now: Date = new Date()): CalibrateResult {
  const total = outcomes.length
  const won = outcomes.filter(o => o.stage === 'WON')

  const minOutcomes = learningLoopMinOutcomes()
  if (total < minOutcomes) {
    return {
      stats: { calibrated: false, reason: 'insufficient data', totalOutcomes: total, baselineWinRate: 0 },
      signalWeights: {},
      industryInsights: [],
      icpUpdate: {},
    }
  }

  const halfLifeDays = learningLoopRecencyHalfLifeDays()
  const weightOf = (o: Outcome) =>
    outcomeRecencyWeight(o.recordedAt ? new Date(o.recordedAt) : now, now, halfLifeDays)

  // Recency-weighted baseline win rate. When every outcome is "as of now" (the
  // old callers/tests, which never set recordedAt), every weight is 1 and this
  // reduces exactly to won.length / total — no behavior change for them.
  let weightedTotal = 0
  let weightedWon = 0
  for (const o of outcomes) {
    const w = weightOf(o)
    weightedTotal += w
    if (o.stage === 'WON') weightedWon += w
  }
  const baselineWinRate = weightedWon / weightedTotal

  // With zero wins there is no signal lift to learn — calibrating now would just
  // floor every weight uniformly off an unlucky early loss streak, throwing away
  // the existing (possibly hand-tuned) weights. Report the baseline but leave
  // weights untouched until at least one win exists to learn from.
  if (won.length === 0) {
    return {
      stats: { calibrated: false, reason: 'insufficient wins', totalOutcomes: total, baselineWinRate },
      signalWeights: {},
      industryInsights: [],
      icpUpdate: {},
    }
  }

  // Per-signal-type win rates → adjusted weights. Raw (unweighted) counts
  // gate whether a type is trusted at all (MIN_TYPE_SAMPLES); the win-rate
  // math itself runs on recency-weighted sums so a type's *recent* outcomes
  // drive its multiplier more than old ones, without a stale outcome ever
  // being able to unlock a type that hasn't really been seen enough.
  const typeCount: Record<string, { won: number; total: number }> = {}
  const typeWeight: Record<string, { won: number; total: number }> = {}
  for (const o of outcomes) {
    const w = weightOf(o)
    for (const sig of o.prospect.signals) {
      if (!typeCount[sig.type]) typeCount[sig.type] = { won: 0, total: 0 }
      if (!typeWeight[sig.type]) typeWeight[sig.type] = { won: 0, total: 0 }
      typeCount[sig.type].total++
      typeWeight[sig.type].total += w
      if (o.stage === 'WON') {
        typeCount[sig.type].won++
        typeWeight[sig.type].won += w
      }
    }
  }

  const signalWeights: Record<string, number> = {}
  for (const [type, counts] of Object.entries(typeCount)) {
    if (counts.total < MIN_TYPE_SAMPLES) continue
    const weighted = typeWeight[type]
    // Shrink the observed per-type win rate toward the baseline by a pseudocount
    // prior, so small samples don't overfit. baselineWinRate > 0 is guaranteed
    // by the no-wins guard above, so the division is always safe.
    const smoothedWinRate =
      (weighted.won + SHRINKAGE_PRIOR * baselineWinRate) / (weighted.total + SHRINKAGE_PRIOR)
    const lift = smoothedWinRate / baselineWinRate
    const multiplier = Math.max(0.5, Math.min(2.0, lift))
    const base = EVENT_BASE_WEIGHTS[type as SignalType] ?? 50
    signalWeights[type] = Math.round(base * multiplier)
  }

  // Industry performance: win RATE per industry, shrunk toward the baseline
  // and compared against it (lift) — never raw win counts. Ranking by counts
  // just rediscovers whatever was contacted most (HVAC with 10/200 would beat
  // Electrical with 5/30). Industries below MIN_TYPE_SAMPLES are withheld.
  const industryStats: Record<string, { won: number; total: number }> = {}
  for (const o of outcomes) {
    if (!o.prospect.industry) continue
    const ind = o.prospect.industry.toLowerCase()
    industryStats[ind] ??= { won: 0, total: 0 }
    industryStats[ind].total++
    if (o.stage === 'WON') industryStats[ind].won++
  }
  const industryInsights: SegmentInsight[] = Object.entries(industryStats)
    .filter(([, c]) => c.total >= MIN_TYPE_SAMPLES)
    .map(([segment, c]) => {
      const adjustedWinRate = (c.won + SHRINKAGE_PRIOR * baselineWinRate) / (c.total + SHRINKAGE_PRIOR)
      return {
        segment, won: c.won, total: c.total,
        observedWinRate: c.won / c.total,
        adjustedWinRate,
        lift: adjustedWinRate / baselineWinRate,
      }
    })
    .sort((a, b) => b.lift - a.lift)
  const topIndustries = industryInsights.filter(i => i.lift > 1).slice(0, 5).map(i => i.segment)

  const wonCounts = won
    .map(o => o.prospect.employeeCount)
    .filter((c): c is number => c !== null && c > 0)
    .sort((a, b) => a - b)

  const icpUpdate: CalibrateResult['icpUpdate'] = {}
  if (topIndustries.length > 0) icpUpdate.targetIndustries = topIndustries
  if (wonCounts.length >= 3) {
    icpUpdate.minEmployees = wonCounts[Math.floor(wonCounts.length * 0.1)]
    icpUpdate.maxEmployees = wonCounts[Math.floor(wonCounts.length * 0.9)]
  }

  return {
    stats: { calibrated: true, totalOutcomes: total, baselineWinRate },
    signalWeights,
    industryInsights,
    icpUpdate,
  }
}

/**
 * Key-order-independent JSON equality. Needed because Postgres jsonb does not
 * preserve object key order, so a stored value and a freshly computed one can
 * be equal yet stringify differently.
 */
export function sameJson(a: unknown, b: unknown): boolean {
  const canon = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(canon)
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.keys(v as object).sort().map(k => [k, canon((v as Record<string, unknown>)[k])]))
        : v
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b))
}

/** Version of the calibration method; bump when calibrate()'s maths changes. */
export const CALIBRATION_VERSION = 1

/** Sample-size confidence label for customer-facing evidence. */
export function confidenceLabel(sampleSize: number): 'Low' | 'Medium' | 'High' {
  return sampleSize >= 100 ? 'High' : sampleSize >= 30 ? 'Medium' : 'Low'
}

export type RecommendationDraft = {
  type: 'ICP_INDUSTRY' | 'ICP_SIZE' | 'SIGNAL_WEIGHT'
  currentValue: unknown
  proposedValue: unknown
  evidence: Record<string, unknown>
  sampleSize: number
}

/**
 * Turn a calibration result into reviewable recommendation drafts. Pure. A
 * draft is only produced when the proposal differs from what's configured, so
 * re-running calibration on unchanged data doesn't spam the review queue.
 */
export function buildRecommendationDrafts(
  result: CalibrateResult,
  current: {
    targetIndustries: string[]
    minEmployees: number | null
    maxEmployees: number | null
    signalWeights: Record<string, number>
  },
): RecommendationDraft[] {
  if (!result.stats.calibrated) return []
  const { totalOutcomes, baselineWinRate } = result.stats
  // Stored with the proposal, so the evidence a customer sees is exactly the
  // data and method that generated it.
  const base = {
    totalOutcomes, baselineWinRate,
    confidence: confidenceLabel(totalOutcomes),
    recencyHalfLifeDays: learningLoopRecencyHalfLifeDays(),
    calibrationVersion: CALIBRATION_VERSION,
  }
  const drafts: RecommendationDraft[] = []
  const same = sameJson

  const proposedIndustries = result.icpUpdate.targetIndustries
  const currentIndustries = current.targetIndustries.map(i => i.toLowerCase()).sort()
  if (proposedIndustries?.length && !same([...proposedIndustries].sort(), currentIndustries)) {
    drafts.push({
      type: 'ICP_INDUSTRY',
      currentValue: current.targetIndustries,
      proposedValue: proposedIndustries,
      evidence: { ...base, industries: result.industryInsights },
      sampleSize: totalOutcomes,
    })
  }

  const { minEmployees, maxEmployees } = result.icpUpdate
  if (minEmployees !== undefined && maxEmployees !== undefined &&
      (minEmployees !== current.minEmployees || maxEmployees !== current.maxEmployees)) {
    drafts.push({
      type: 'ICP_SIZE',
      currentValue: { minEmployees: current.minEmployees, maxEmployees: current.maxEmployees },
      proposedValue: { minEmployees, maxEmployees },
      evidence: { ...base, basis: '10th–90th percentile of employee counts among WON prospects' },
      sampleSize: totalOutcomes,
    })
  }

  if (Object.keys(result.signalWeights).length > 0 && !same(result.signalWeights, current.signalWeights)) {
    drafts.push({
      type: 'SIGNAL_WEIGHT',
      currentValue: current.signalWeights,
      proposedValue: result.signalWeights,
      evidence: { ...base, method: 'per-signal win rate, shrunk toward baseline, lift capped 0.5×–2×' },
      sampleSize: totalOutcomes,
    })
  }
  return drafts
}
