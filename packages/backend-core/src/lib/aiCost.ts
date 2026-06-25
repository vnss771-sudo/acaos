// AI unit economics.
//
// OpenAI bills the *platform* through a shared API key, so per-call model spend is
// only legible per workspace by weighting each metered AI action by its typical
// token cost. A flat call count hides that a research call (more output tokens)
// costs more than a reply classification. This module turns per-action call counts
// into an estimated dollar cost so unit economics — cost-per-lead / ROI — become
// observable, mirroring discoveryCost.ts.
//
// These are deliberately rough, tunable estimates (USD cents per call at the
// default gpt-4o-mini tier), not invoices. They feed reporting/observability only;
// the enforced monthly AI quota is a separate, plan-priced concept and unaffected.

export type AiAction = 'AI_RESEARCH' | 'AI_OUTREACH' | 'AI_REPLY'

const AI_ACTIONS: readonly AiAction[] = ['AI_RESEARCH', 'AI_OUTREACH', 'AI_REPLY']

// Default cents-per-call, derived from each action's token profile at gpt-4o-mini
// pricing (research ≈ 700in+1500out, outreach ≈ 500in+1200out, reply ≈ 3000in+700out).
// Tunable for other model tiers via AI_COST_CENTS_RESEARCH / _OUTREACH / _REPLY.
const DEFAULT_CENTS: Record<AiAction, number> = {
  AI_RESEARCH: 0.1,
  AI_OUTREACH: 0.08,
  AI_REPLY: 0.05,
}

const round2 = (n: number): number => Math.round(n * 100) / 100

export function aiActionCostCents(action: AiAction): number {
  const env = Number(process.env[`AI_COST_CENTS_${action.slice('AI_'.length)}`])
  return Number.isFinite(env) && env >= 0 ? env : DEFAULT_CENTS[action]
}

export type AiCostBreakdown = {
  totalCents: number
  byAction: Record<string, { calls: number; costCents: number }>
}

// Pure: turn per-action call counts into a weighted cost breakdown. Unknown actions
// and non-positive counts are ignored, so callers can pass a full totals map safely.
export function estimateAiCost(callsByAction: Partial<Record<AiAction, number>>): AiCostBreakdown {
  const byAction: Record<string, { calls: number; costCents: number }> = {}
  let totalCents = 0
  for (const action of AI_ACTIONS) {
    const calls = callsByAction[action] ?? 0
    if (!Number.isFinite(calls) || calls <= 0) continue
    const costCents = round2(aiActionCostCents(action) * calls)
    byAction[action] = { calls, costCents }
    totalCents += costCents
  }
  return { totalCents: round2(totalCents), byAction }
}
