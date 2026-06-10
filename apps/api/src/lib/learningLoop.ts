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

type MessageOutcomeData = {
  event: string  // SENT | OPENED | CLICKED | REPLIED | MEETING_BOOKED | WON | LOST
  channel: string
  industry: string | null
  sentAtHour?: number   // 0-23
  sentAtDow?: number    // 0=Sun … 6=Sat
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
  channelWeights: Record<string, number>  // channel → 0-100 effectiveness score
  timingWeights: Record<string, number>   // "dow:hour" → 0-100 effectiveness score
  icpUpdate: {
    targetIndustries?: string[]
    minEmployees?: number
    maxEmployees?: number
  }
}

const MIN_OUTCOMES = 10

export function calibrate(outcomes: Outcome[], messageOutcomes: MessageOutcomeData[] = []): CalibrateResult {
  const total = outcomes.length
  const won   = outcomes.filter(o => o.stage === 'WON')

  if (total < MIN_OUTCOMES) {
    return {
      stats: { calibrated: false, reason: 'insufficient data', totalOutcomes: total, baselineWinRate: 0 },
      signalWeights: {},
      channelWeights: {},
      timingWeights: {},
      icpUpdate: {},
    }
  }

  const baselineWinRate = won.length / total

  // ── Signal type win rates → adjusted weights ──────────────────────────────
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
    const typeWinRate  = counts.won / counts.total
    const lift         = typeWinRate / (baselineWinRate || 0.01)
    const multiplier   = Math.max(0.5, Math.min(2.0, lift))
    const base         = EVENT_BASE_WEIGHTS[type as SignalType] ?? 50
    signalWeights[type] = Math.round(base * multiplier)
  }

  // ── Channel effectiveness from message outcomes ───────────────────────────
  const channelMet: Record<string, { meetings: number; sent: number }> = {}
  for (const mo of messageOutcomes) {
    if (!channelMet[mo.channel]) channelMet[mo.channel] = { meetings: 0, sent: 0 }
    if (mo.event === 'SENT') channelMet[mo.channel].sent++
    if (mo.event === 'MEETING_BOOKED' || mo.event === 'WON') channelMet[mo.channel].meetings++
  }

  const channelWeights: Record<string, number> = {}
  for (const [channel, counts] of Object.entries(channelMet)) {
    if (counts.sent < 5) continue
    const meetingRate = counts.meetings / counts.sent
    // Normalise: assume 10% meeting rate = score 50; clamp 0-100
    channelWeights[channel] = Math.round(Math.min(100, Math.max(0, meetingRate * 500)))
  }

  // ── Timing effectiveness (day-of-week + hour) ─────────────────────────────
  const timingMet: Record<string, { meetings: number; sent: number }> = {}
  for (const mo of messageOutcomes) {
    if (mo.sentAtDow === undefined || mo.sentAtHour === undefined) continue
    const key = `${mo.sentAtDow}:${mo.sentAtHour}`
    if (!timingMet[key]) timingMet[key] = { meetings: 0, sent: 0 }
    if (mo.event === 'SENT') timingMet[key].sent++
    if (mo.event === 'MEETING_BOOKED' || mo.event === 'WON') timingMet[key].meetings++
  }

  const timingWeights: Record<string, number> = {}
  for (const [key, counts] of Object.entries(timingMet)) {
    if (counts.sent < 3) continue
    const meetingRate = counts.meetings / counts.sent
    timingWeights[key] = Math.round(Math.min(100, Math.max(0, meetingRate * 500)))
  }

  // ── ICP update from WON prospect characteristics ──────────────────────────
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
    icpUpdate.minEmployees = wonCounts[Math.floor((wonCounts.length - 1) * 0.1)]
    icpUpdate.maxEmployees = wonCounts[Math.floor((wonCounts.length - 1) * 0.9)]
  }

  return {
    stats: { calibrated: true, totalOutcomes: total, baselineWinRate },
    signalWeights,
    channelWeights,
    timingWeights,
    icpUpdate,
  }
}
