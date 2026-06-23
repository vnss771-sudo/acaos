// Outreach generation gate: turns a lead-research `recommendedAction` into an
// enforceable decision at generate-outreach time. Pure and dependency-free so the
// policy lives in ONE testable place; the worker applies the result.
//
// The gate is TIGHTEN-ONLY — it can suppress generation or route a draft to human
// review, but it can never bypass approval or auto-send something that wouldn't
// otherwise go. It can only add safety, never remove it.
//
//   skip                     → do NOT generate (poor fit); the lead is marked
//                              SKIPPED_POOR_FIT and held in a review queue. A human
//                              can override, which generates a draft into POLICY_REVIEW.
//   manual_review_then_draft → generate, but force POLICY_REVIEW (held for a human
//                              even in auto-send workspaces — evidence is thin).
//   auto_draft / (none)      → normal DRAFTED flow (still subject to the existing
//                              send-time content policy + workspace approval).

export type GateDraftStatus = 'DRAFTED' | 'POLICY_REVIEW'

// Stable, machine-greppable reason recorded on a suppressed lead.
export const SKIPPED_POOR_FIT_REASON =
  'SKIPPED_POOR_FIT: research recommended skipping this lead as a poor fit'

export type OutreachGateDecision =
  | { generate: false; skipReason: string }
  | { generate: true; draftStatus: GateDraftStatus }

/**
 * Resolve what the generate-outreach worker should do for a lead, given the
 * research `recommendedAction` and whether a human is explicitly overriding.
 */
export function resolveOutreachGate(input: {
  recommendedAction: string | null | undefined
  override?: boolean | null
}): OutreachGateDecision {
  const action = input.recommendedAction
  const override = !!input.override

  // Poor-fit lead: suppress generation entirely unless a human overrides.
  if (action === 'skip' && !override) {
    return { generate: false, skipReason: SKIPPED_POOR_FIT_REASON }
  }

  // Hold for a human when the model asked for manual review, OR when a human is
  // overriding a prior skip — a thin-evidence lead must never auto-send.
  if (override || action === 'manual_review_then_draft') {
    return { generate: true, draftStatus: 'POLICY_REVIEW' }
  }

  // auto_draft, or no recommendation (e.g. lead never researched) → normal flow.
  return { generate: true, draftStatus: 'DRAFTED' }
}
