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
    if (counts.total < 3) continue
    const typeWinRate = counts.won / counts.total
    const lift = typeWinRate / (baselineWinRate || 0.01)
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
