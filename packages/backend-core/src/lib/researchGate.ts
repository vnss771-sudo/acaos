// Research safety gate. Lenient research parsing (parseLeadResearchJson) self-heals
// malformed model output to EMPTY fields rather than throwing — good for resilience,
// but an empty research result must not flow through as `auto_draft`, or the
// outreach generator would produce generic, ungrounded copy and (in auto-send
// workspaces) ship it. When there is no summary AND no evidence, hold the lead for
// a human instead — unless research already said `skip` (poor fit), which we keep.

export type ThinResearchInput = {
  recommendedAction?: string | null
  aiSummary?: string | null
  evidenceCount: number
}

/**
 * Resolve the recommendedAction to persist, downgrading thin/empty research away
 * from auto-draft. Pure and dependency-free.
 */
export function resolveResearchAction(input: ThinResearchInput): string | null {
  const hasSubstance = Boolean(input.aiSummary?.trim()) || input.evidenceCount > 0
  // Empty research → force human review, but never resurrect a `skip` (poor fit).
  if (!hasSubstance && input.recommendedAction !== 'skip') return 'manual_review_then_draft'
  return input.recommendedAction ?? null
}
