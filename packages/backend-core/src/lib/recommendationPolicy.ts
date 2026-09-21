// Policy for when/whether to surface a recommendation. Pure + testable so the
// worker, routes, and tests share one definition of "good enough to recommend".
import { freshnessState, type RawSignal } from './signalEngine.js'

// Opportunity score at/above which a scored prospect warrants an auto-generated
// recommendation (WARM+). Below this we monitor rather than create radar noise.
export const AUTO_RECOMMEND_THRESHOLD = 70

// The priority line above which a recommendation claims "high confidence /
// contact now". Reaching it requires provable, fresh evidence (see below).
export const HIGH_CONFIDENCE_PRIORITY = 70

// The priority line above which a recommendation is WARM+ and already worth
// surfacing (mirrors the Lead-scoring WARM boundary — scoring.ts's
// getScoreTier — so both scoring tracks agree on where "warm" evidence
// requirements start). Below HIGH_CONFIDENCE_PRIORITY a WARM claim is softer
// than "contact now", but it still asserts a real "why now" and must be
// backed by the same provable, fresh evidence — not just HOT claims.
export const WARM_CONFIDENCE_PRIORITY = 48

export type EvidenceCheckSignal = {
  type: RawSignal['type']
  detectedAt: Date
  evidenceSourceId?: string | null
}

/**
 * Evidence-first gate: a prospect has "valid evidence" when at least one signal
 * is both backed by an EvidenceSource AND not EXPIRED. This is what lets a
 * recommendation be high-confidence — the "why now" must be provable and fresh.
 */
export function hasValidEvidence(signals: EvidenceCheckSignal[]): boolean {
  return signals.some(
    (s) => !!s.evidenceSourceId && freshnessState({ type: s.type, detectedAt: s.detectedAt }) !== 'EXPIRED',
  )
}

/**
 * Cap a recommendation's priority below the WARM line unless there's provable,
 * fresh evidence. Prevents surfacing a confident "contact now" (or even a softer
 * WARM "worth a look") the system can't actually back up — the core trust
 * promise. A single check covers both tiers: since HIGH_CONFIDENCE_PRIORITY >=
 * WARM_CONFIDENCE_PRIORITY, an unbacked HOT-range priority is also unbacked at
 * WARM and falls all the way to COLD rather than merely landing at "high
 * WARM" (69) as before.
 */
export function evidenceGatedPriority(priority: number, signals: EvidenceCheckSignal[]): number {
  if (priority >= WARM_CONFIDENCE_PRIORITY && !hasValidEvidence(signals)) {
    return WARM_CONFIDENCE_PRIORITY - 1 // 47 — "enrich before treating as warm+"
  }
  return priority
}
