// Calibration algorithm: Outcome → SignalWeights + ICP update
// Pure functions — no DB calls, fully unit-testable

import type { SignalType, SignalWeights } from './signalEngine.js'

const ALL_SIGNAL_TYPES: SignalType[] = [
  'HIRING', 'FUNDING', 'EXPANSION', 'TECH_ADOPTION', 'LEADERSHIP_CHANGE',
  'NEWS_MENTION', 'PROCUREMENT', 'BUSINESS_REGISTRATION', 'WEBSITE_CHANGE'
]

export type OutcomeRecord = {
  stage: 'WON' | 'LOST'
  prospect: {
    industry?: string | null
    employeeCount?: number | null
    signals: Array<{ type: string }>
  }
}

export type CalibrationResult = {
  signalWeights: SignalWeights
  icpUpdate: {
    targetIndustries?: string[]
    minEmployees?: number
    maxEmployees?: number
  }
  stats: {
    totalOutcomes: number
    wonCount: number
    baselineWinRate: number
    calibrated: boolean
    reason?: string
  }
}

const MIN_SAMPLES = 5       // minimum outcomes before calibrating
const MIN_TYPE_SAMPLES = 3  // minimum per signal type before adjusting its weight
const MIN_MULTIPLIER = 0.3  // floor: even terrible signals keep some weight
const MAX_MULTIPLIER = 3.0  // ceiling: no signal gets unbounded boost

export function calibrate(outcomes: OutcomeRecord[]): CalibrationResult {
  const wonCount = outcomes.filter(o => o.stage === 'WON').length
  const totalOutcomes = outcomes.length
  const baselineWinRate = totalOutcomes > 0 ? wonCount / totalOutcomes : 0

  const empty: CalibrationResult = {
    signalWeights: {},
    icpUpdate: {},
    stats: { totalOutcomes, wonCount, baselineWinRate, calibrated: false }
  }

  if (totalOutcomes < MIN_SAMPLES) {
    return { ...empty, stats: { ...empty.stats, reason: 'insufficient_data' } }
  }

  // ── Signal weight calibration ────────────────────────────────────────────────

  const signalWeights: SignalWeights = {}

  for (const type of ALL_SIGNAL_TYPES) {
    const withType = outcomes.filter(o => o.prospect.signals.some(s => s.type === type))
    if (withType.length < MIN_TYPE_SAMPLES) continue

    const wonWithType = withType.filter(o => o.stage === 'WON').length
    const winRateWithType = wonWithType / withType.length

    // How much more (or less) likely to win when this signal is present
    const effectiveness = baselineWinRate > 0 ? winRateWithType / baselineWinRate : 1.0
    signalWeights[type] = Math.max(MIN_MULTIPLIER, Math.min(MAX_MULTIPLIER, effectiveness))
  }

  // ── ICP auto-update from WON prospects ───────────────────────────────────────

  const wonProspects = outcomes
    .filter(o => o.stage === 'WON')
    .map(o => o.prospect)

  const icpUpdate: CalibrationResult['icpUpdate'] = {}

  if (wonProspects.length >= MIN_SAMPLES) {
    // Top industries from WON deals (must appear in at least 2 WON deals)
    const industryCounts: Record<string, number> = {}
    for (const p of wonProspects) {
      if (p.industry) industryCounts[p.industry] = (industryCounts[p.industry] ?? 0) + 1
    }
    const topIndustries = Object.entries(industryCounts)
      .filter(([, n]) => n >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([ind]) => ind)

    if (topIndustries.length > 0) icpUpdate.targetIndustries = topIndustries

    // Employee count range: 10th–90th percentile of WON prospects
    const empCounts = wonProspects
      .map(p => p.employeeCount)
      .filter((n): n is number => n !== null && n !== undefined)
      .sort((a, b) => a - b)

    if (empCounts.length >= MIN_SAMPLES) {
      icpUpdate.minEmployees = empCounts[Math.floor(empCounts.length * 0.10)]
      icpUpdate.maxEmployees = empCounts[Math.floor(empCounts.length * 0.90)]
    }
  }

  return {
    signalWeights,
    icpUpdate,
    stats: { totalOutcomes, wonCount, baselineWinRate, calibrated: true }
  }
}
