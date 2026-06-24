import { EVENT_BASE_WEIGHTS } from './signalEngine.js'
import type { SignalType } from './signalEngine.js'

type Outcome = {
  stage: 'WON' | 'LOST'
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

const MIN_OUTCOMES = 10
// Per-signal-type minimum sample size before its win rate is trusted at all.
const MIN_TYPE_SAMPLES = 3
// Pseudocount strength for shrinking a per-type win rate toward the baseline.
// A tiny sample (e.g. 3/3 wins) is pulled most of the way back to baseline, so it
// can't swing the weight to the 2x cap off a lucky streak; large samples are
// barely affected. This is Laplace/Bayesian shrinkage with a baseline prior.
const SHRINKAGE_PRIOR = 5

export function calibrate(outcomes: Outcome[]): CalibrateResult {
  const total = outcomes.length
  const won = outcomes.filter(o => o.stage === 'WON')

  if (total < MIN_OUTCOMES) {
    return {
      stats: { calibrated: false, reason: 'insufficient data', totalOutcomes: total, baselineWinRate: 0 },
      signalWeights: {},
      icpUpdate: {},
    }
  }

  const baselineWinRate = won.length / total

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

  // Per-signal-type win rates → adjusted weights
  const typeCount: Record<string, { won: number; total: number }> = {}
  for (const o of outcomes) {
    for (const sig of o.prospect.signals) {
      if (!typeCount[sig.type]) typeCount[sig.type] = { won: 0, total: 0 }
      typeCount[sig.type].total++
      if (o.stage === 'WON') typeCount[sig.type].won++
    }
  }

  const signalWeights: Record<string, number> = {}
  for (const [type, counts] of Object.entries(typeCount)) {
    if (counts.total < MIN_TYPE_SAMPLES) continue
    // Shrink the observed per-type win rate toward the baseline by a pseudocount
    // prior, so small samples don't overfit. baselineWinRate > 0 is guaranteed
    // by the no-wins guard above, so the division is always safe.
    const smoothedWinRate =
      (counts.won + SHRINKAGE_PRIOR * baselineWinRate) / (counts.total + SHRINKAGE_PRIOR)
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
