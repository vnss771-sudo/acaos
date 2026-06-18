// Policy for when/whether to surface a recommendation. Pure + testable so the
// worker, routes, and tests share one definition of "good enough to recommend".
import { freshnessState } from './signalEngine.js';
// Opportunity score at/above which a scored prospect warrants an auto-generated
// recommendation (WARM+). Below this we monitor rather than create radar noise.
export const AUTO_RECOMMEND_THRESHOLD = 70;
// The priority line above which a recommendation claims "high confidence /
// contact now". Reaching it requires provable, fresh evidence (see below).
export const HIGH_CONFIDENCE_PRIORITY = 70;
/**
 * Evidence-first gate: a prospect has "valid evidence" when at least one signal
 * is both backed by an EvidenceSource AND not EXPIRED. This is what lets a
 * recommendation be high-confidence — the "why now" must be provable and fresh.
 */
export function hasValidEvidence(signals) {
    return signals.some((s) => !!s.evidenceSourceId && freshnessState({ type: s.type, detectedAt: s.detectedAt }) !== 'EXPIRED');
}
/**
 * Cap a recommendation's priority below the high-confidence line unless there's
 * provable, fresh evidence. Prevents surfacing a confident "contact now" the
 * system can't actually back up — the core trust promise.
 */
export function evidenceGatedPriority(priority, signals) {
    if (priority >= HIGH_CONFIDENCE_PRIORITY && !hasValidEvidence(signals)) {
        return HIGH_CONFIDENCE_PRIORITY - 1; // 69 — "enrich before treating as hot"
    }
    return priority;
}
