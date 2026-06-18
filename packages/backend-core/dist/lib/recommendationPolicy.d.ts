import { type RawSignal } from './signalEngine.js';
export declare const AUTO_RECOMMEND_THRESHOLD = 70;
export declare const HIGH_CONFIDENCE_PRIORITY = 70;
export type EvidenceCheckSignal = {
    type: RawSignal['type'];
    detectedAt: Date;
    evidenceSourceId?: string | null;
};
/**
 * Evidence-first gate: a prospect has "valid evidence" when at least one signal
 * is both backed by an EvidenceSource AND not EXPIRED. This is what lets a
 * recommendation be high-confidence — the "why now" must be provable and fresh.
 */
export declare function hasValidEvidence(signals: EvidenceCheckSignal[]): boolean;
/**
 * Cap a recommendation's priority below the high-confidence line unless there's
 * provable, fresh evidence. Prevents surfacing a confident "contact now" the
 * system can't actually back up — the core trust promise.
 */
export declare function evidenceGatedPriority(priority: number, signals: EvidenceCheckSignal[]): number;
