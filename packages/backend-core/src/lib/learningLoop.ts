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

export type CalibrateResult = {
  stats: CalibrateStats
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

  // ICP update from WON prospect characteristics
  const industryFreq: Record<string, number> = {}
  for (const o of won) {
    if (o.prospect.industry) {
      const ind = o.prospect.industry.toLowerCase()
      industryFreq[ind] = (industryFreq[ind] ?? 0) + 1
    }
  }
  const topIndustries = Object.entries(industryFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([ind]) => ind)

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
    icpUpdate,
  }
}

// ── Calibration "why" trace ─────────────────────────────────────────────────
// calibrate() answers "what are the new weights?". diffCalibration() answers
// "what changed and did it help?" — the self-auditing layer. Pure + testable so
// the worker can persist a trace into ScoringModel.performanceMetrics and tests
// can assert the maths without a database.

export type WeightChange = {
  type: string
  from: number | null // null = newly weighted this run
  to: number | null   // null = no longer weighted this run
  delta: number       // to - from (absent side treated as 0)
}

export type CalibrationDiff = {
  previousWinRate: number | null
  newWinRate: number
  winRateDelta: number | null   // null on the first calibration (no prior)
  improved: boolean | null      // null on the first calibration
  weightChanges: WeightChange[] // only the types whose weight actually moved
  changedCount: number
}

export type PriorCalibration = {
  signalWeights?: Record<string, number> | null
  winRate?: number | null
}

/**
 * Compare the previously-persisted calibration against a fresh result: which
 * signal weights moved (and by how much), and whether the baseline win rate
 * improved. `previous` is null/empty on the very first calibration, in which
 * case win-rate deltas are null and every weight is reported as a `from: null`
 * introduction.
 */
export function diffCalibration(previous: PriorCalibration | null, next: CalibrateResult): CalibrationDiff {
  const prevWeights = previous?.signalWeights ?? {}
  const nextWeights = next.signalWeights ?? {}

  const types = new Set<string>([...Object.keys(prevWeights), ...Object.keys(nextWeights)])
  const weightChanges: WeightChange[] = []
  for (const type of types) {
    const from = type in prevWeights ? prevWeights[type] : null
    const to = type in nextWeights ? nextWeights[type] : null
    if (from === to) continue // unchanged (covers equal numbers)
    weightChanges.push({ type, from, to, delta: (to ?? 0) - (from ?? 0) })
  }
  weightChanges.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))

  const previousWinRate = previous?.winRate ?? null
  const newWinRate = next.stats.baselineWinRate
  const winRateDelta = previousWinRate === null ? null : newWinRate - previousWinRate
  const improved = winRateDelta === null ? null : winRateDelta >= 0

  return { previousWinRate, newWinRate, winRateDelta, improved, weightChanges, changedCount: weightChanges.length }
}
