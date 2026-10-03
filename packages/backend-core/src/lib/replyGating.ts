// Reply-classification confidence gating. The AI reply classifier drives automated
// lead-stage transitions. Most are non-destructive (→ REPLIED / no-op), but exactly
// one is IRREVERSIBLE: NOT_INTERESTED → DEAD. A low-confidence misclassification
// there permanently disqualifies a possibly-interested prospect and taints the
// scoring model with a false negative.
//
// So we gate ONLY that destructive path on confidence: a NOT_INTERESTED below the
// threshold is downgraded to the conservative NEEDS_MORE_INFO, which keeps the lead
// (→ REPLIED, human-reviewable) instead of auto-killing it. Every other
// classification passes through unchanged. The RAW classification + confidence are
// still recorded on the send for the inbox/audit — only the automated consequence
// is made conservative. Tunable via REPLY_CLASSIFICATION_MIN_CONFIDENCE (0–100,
// default 60); set to 0 to restore always-act-on-the-label behaviour.

export function replyClassificationMinConfidence(): number {
  const n = Number(process.env.REPLY_CLASSIFICATION_MIN_CONFIDENCE)
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : 60
}

/**
 * The classification to ACT ON, after confidence gating. A NOT_INTERESTED whose
 * confidence is below `minConfidence` (or absent) becomes NEEDS_MORE_INFO so the
 * irreversible DEAD transition is not taken on a shaky negative. Pure.
 */
export function effectiveReplyClassification(
  classification: string,
  confidence: number | null | undefined,
  minConfidence: number = replyClassificationMinConfidence(),
): string {
  if (classification === 'NOT_INTERESTED' && (confidence ?? 0) < minConfidence) {
    return 'NEEDS_MORE_INFO'
  }
  return classification
}

// ── What a classification does ────────────────────────────────────────────────
// One source of truth for the automated consequences of a reply label, shared by
// the analyze-reply worker (which applies them) and the Inbox correction route
// (which undoes the automation's effect and applies a person's label instead).

/** Lead stage a reply classification moves the lead to. */
export const REPLY_STAGE: Record<string, string> = {
  INTERESTED: 'REPLIED',
  NOT_INTERESTED: 'DEAD',
  NEEDS_MORE_INFO: 'REPLIED',
  NOT_NOW: 'REPLIED',
  REFERRAL: 'REPLIED',
  OUT_OF_OFFICE: 'OUTREACH_SENT',
}

const OUTCOME_INTENT: Record<string, string> = {
  INTERESTED: 'INTERESTED',
  NOT_INTERESTED: 'NOT_INTERESTED',
  NEEDS_MORE_INFO: 'NEED_MORE_INFO',
  NOT_NOW: 'NEED_MORE_INFO',
  REFERRAL: 'INTERESTED',
  OUT_OF_OFFICE: 'NOT_INTERESTED',
}

/** The ScoringOutcome fields a reply classification records for the learning loop. */
export function replyOutcomeFor(classification: string): { replied: boolean; replyIntent: string | null } {
  return {
    replied: !['NOT_INTERESTED', 'OUT_OF_OFFICE'].includes(classification),
    replyIntent: OUTCOME_INTENT[classification] ?? null,
  }
}
