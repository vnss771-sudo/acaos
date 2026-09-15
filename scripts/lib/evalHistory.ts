/**
 * Turns eval findings into a single trackable quality score, and tracks that
 * score across runs so a scheduled CI run can report *lift* (the delta vs. the
 * last recorded run) rather than only current-run pass/fail. Pure — no fs, no
 * network — so it's unit tested directly; scripts/eval-*.ts own the fs I/O
 * (reading/writing the on-disk history file) and call into this.
 */

export type EvalFinding = { case: string; severity: 'FAIL' | 'WARN'; message: string }

// Point cost per finding severity, folded into a single 0-100 score. FAILs are
// the hard pass/fail gate signal (a real product regression), so they cost far
// more than WARNs (soft quality nudges) — a handful of WARNs shouldn't read as
// equivalent to one real FAIL. Floors at 0 rather than going negative.
const FAIL_PENALTY = 20
const WARN_PENALTY = 4

export function computeEvalScore(findings: EvalFinding[]): number {
  const fails = findings.filter((f) => f.severity === 'FAIL').length
  const warns = findings.filter((f) => f.severity === 'WARN').length
  return Math.max(0, 100 - fails * FAIL_PENALTY - warns * WARN_PENALTY)
}

export type EvalRunRecord = {
  recordedAt: string // ISO timestamp
  gitSha?: string
  model?: string
  score: number
  fails: number
  warns: number
  cases: number
}

export type EvalHistory = EvalRunRecord[]

// Cap the on-disk history so it stays a small, reviewable file rather than
// growing unbounded forever — recent trend is what matters for lift.
export const MAX_EVAL_HISTORY = 200

/** Append a run, capped to the most recent MAX_EVAL_HISTORY entries. Pure. */
export function appendEvalRun(history: EvalHistory, run: EvalRunRecord): EvalHistory {
  return [...history, run].slice(-MAX_EVAL_HISTORY)
}

export type EvalLift = { deltaScore: number; previous: EvalRunRecord }

/**
 * Lift vs. the most recent prior run already in `history` (i.e. before the
 * current run is appended) — the quantitative comparison this module exists
 * to provide. `null` when there is no prior run to compare against yet (the
 * very first recorded run).
 */
export function computeLift(history: EvalHistory, currentScore: number): EvalLift | null {
  if (history.length === 0) return null
  const previous = history[history.length - 1]
  return { deltaScore: currentScore - previous.score, previous }
}

/** Human-readable one-liner for console + workflow step summary output. */
export function formatLift(lift: EvalLift | null, currentScore: number): string {
  if (!lift) return `Quality score: ${currentScore}/100 (first recorded run — no prior baseline to compare against)`
  const sign = lift.deltaScore >= 0 ? '+' : ''
  return `Quality score: ${currentScore}/100 (lift vs previous run on ${lift.previous.recordedAt}: ${sign}${lift.deltaScore})`
}
