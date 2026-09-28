// Timing fit — "why now?". Deterministic, versioned, explainable score (0–1)
// of how well-timed contacting a prospect is, from DATED buying-trigger
// evidence only (never from any reply or outcome):
//
//   recency      0.50  freshest trigger, halving every TIMING_HALF_LIFE_DAYS
//   buying stage 0.30  strongest recent trigger (tender > expansion/funding > hiring > launch/leadership)
//   momentum     0.20  distinct recent triggers (1 → half, 2+ → full)
//
// No dated trigger at all → a neutral 0.5 ("timing unknown"), never a
// fabricated value. Unlike message relevance (about a specific message), this
// is a property of the prospect at a moment in time, so it is used both in the
// lead score and, frozen at send time, as a learning feature.

import { classifySignals, type BuyingSignal } from './buyingSignals.js'

export const TIMING_FIT_VERSION = 1
export const DEFAULT_TIMING_FIT = 0.5
export const TIMING_HALF_LIFE_DAYS = 30
const RECENT_DAYS = 90
const WEIGHTS = { recency: 0.5, stage: 0.3, momentum: 0.2 } as const

const STAGE_STRENGTH: Record<BuyingSignal, number> = {
  tender: 1, expansion: 0.8, funding: 0.8, hiring: 0.7, launch: 0.6, leadership: 0.6,
}

export type TimingEvidence = { text: string; observedAt: Date }

export type TimingFitResult = {
  score: number
  components: { recency: number; stage: number; momentum: number } | null
  reasons: string[]
  version: number
}

export function computeTimingFit(evidence: TimingEvidence[], now: Date): TimingFitResult {
  const triggers = evidence
    .filter(e => e.observedAt instanceof Date && Number.isFinite(e.observedAt.getTime()))
    .flatMap(e => classifySignals(e.text).map(signal => ({
      signal,
      // Clamp future-dated evidence (clock skew / bad data) to age 0.
      ageDays: Math.max(0, (now.getTime() - e.observedAt.getTime()) / 86_400_000),
    })))

  if (triggers.length === 0) {
    return { score: DEFAULT_TIMING_FIT, components: null, reasons: ['Timing unknown — no dated buying trigger'], version: TIMING_FIT_VERSION }
  }

  const freshest = triggers.reduce((a, b) => (b.ageDays < a.ageDays ? b : a))
  const recent = triggers.filter(t => t.ageDays <= RECENT_DAYS)
  const recency = Math.pow(0.5, freshest.ageDays / TIMING_HALF_LIFE_DAYS)
  const strongest = recent.reduce<{ signal: BuyingSignal; s: number } | null>(
    (best, t) => (STAGE_STRENGTH[t.signal] > (best?.s ?? -1) ? { signal: t.signal, s: STAGE_STRENGTH[t.signal] } : best), null)
  const stage = strongest?.s ?? 0
  const distinct = new Set(recent.map(t => t.signal)).size
  const momentum = distinct >= 2 ? 1 : distinct === 1 ? 0.5 : 0

  const pts = (w: number, v: number) => `+${Math.round(w * v * 100)}`
  const days = Math.round(freshest.ageDays)
  const reasons = [
    `${pts(WEIGHTS.recency, recency)} Freshest trigger (${freshest.signal}) observed ${days === 0 ? 'today' : `${days} day${days === 1 ? '' : 's'} ago`}`,
    strongest ? `${pts(WEIGHTS.stage, stage)} Strongest recent trigger: ${strongest.signal}` : `+0 No trigger in the last ${RECENT_DAYS} days`,
    `${pts(WEIGHTS.momentum, momentum)} ${distinct} distinct recent trigger${distinct === 1 ? '' : 's'}`,
  ]
  const score = WEIGHTS.recency * recency + WEIGHTS.stage * stage + WEIGHTS.momentum * momentum
  return { score: Math.round(score * 1000) / 1000, components: { recency, stage, momentum }, reasons, version: TIMING_FIT_VERSION }
}
