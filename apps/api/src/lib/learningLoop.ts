// Layer 9: Autonomous learning loop
// calibrate() updates signal weights and ICP from WON/LOST outcomes

import type { SignalType, SignalWeights } from './signalEngine.js'

export type OutcomeRecord = {
  stage: 'WON' | 'LOST'
  prospect: {
    industry?:     string | null
    employeeCount?: number | null
    signals: Array<{ type: string }>
  }
}

export type CalibrationResult = {
  signalWeights: SignalWeights
  icpUpdate: {
    targetIndustries?: string[]
    minEmployees?:     number
    maxEmployees?:     number
  }
  stats: {
    totalOutcomes:    number
    wonCount:         number
    baselineWinRate:  number
    calibrated:       boolean
    reason?:          string
  }
}

const MIN_SAMPLES      = 5
const MIN_TYPE_SAMPLES = 3
const WEIGHT_CLAMP_MIN = 0.3
const WEIGHT_CLAMP_MAX = 3.0

export function calibrate(outcomes: OutcomeRecord[]): CalibrationResult {
  const totalOutcomes = outcomes.length
  const wonOutcomes   = outcomes.filter(o => o.stage === 'WON')
  const wonCount      = wonOutcomes.length
  const baselineWinRate = totalOutcomes > 0 ? wonCount / totalOutcomes : 0

  if (totalOutcomes < MIN_SAMPLES) {
    return {
      signalWeights: {},
      icpUpdate: {},
      stats: { totalOutcomes, wonCount, baselineWinRate, calibrated: false, reason: 'insufficient_data' },
    }
  }

  // --- Signal weight calibration ---
  const signalTypes = [
    'HIRING', 'FUNDING', 'EXPANSION', 'TECH_ADOPTION', 'LEADERSHIP_CHANGE',
    'NEWS_MENTION', 'PROCUREMENT', 'BUSINESS_REGISTRATION', 'WEBSITE_CHANGE',
  ] as SignalType[]

  const signalWeights: SignalWeights = {}

  for (const type of signalTypes) {
    const withType    = outcomes.filter(o => o.prospect.signals.some(s => s.type === type))
    const withTypeWon = withType.filter(o => o.stage === 'WON')

    if (withType.length < MIN_TYPE_SAMPLES) continue

    const pWonGivenType = withTypeWon.length / withType.length
    const rawMultiplier = baselineWinRate > 0 ? pWonGivenType / baselineWinRate : 1.0
    signalWeights[type] = Math.min(WEIGHT_CLAMP_MAX, Math.max(WEIGHT_CLAMP_MIN, rawMultiplier))
  }

  // --- ICP auto-discovery from WON deals ---
  const icpUpdate: CalibrationResult['icpUpdate'] = {}

  if (wonCount >= MIN_SAMPLES) {
    // Top industries from WON deals (≥ 2 occurrences)
    const industryCounts = new Map<string, number>()
    for (const o of wonOutcomes) {
      if (o.prospect.industry) {
        const normalized = o.prospect.industry.toLowerCase().trim()
        industryCounts.set(normalized, (industryCounts.get(normalized) ?? 0) + 1)
      }
    }
    const topIndustries = [...industryCounts.entries()]
      .filter(([, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([industry]) => industry)
    if (topIndustries.length > 0) {
      icpUpdate.targetIndustries = topIndustries
    }

    // 10th–90th percentile employee count from WON deals
    const empCounts = wonOutcomes
      .map(o => o.prospect.employeeCount)
      .filter((n): n is number => typeof n === 'number')
      .sort((a, b) => a - b)
    if (empCounts.length >= 3) {
      const p10 = empCounts[Math.floor(empCounts.length * 0.10)]
      const p90 = empCounts[Math.floor(empCounts.length * 0.90)]
      icpUpdate.minEmployees = p10
      icpUpdate.maxEmployees = p90
    }
  }

  return {
    signalWeights,
    icpUpdate,
    stats: { totalOutcomes, wonCount, baselineWinRate, calibrated: true },
  }
}
