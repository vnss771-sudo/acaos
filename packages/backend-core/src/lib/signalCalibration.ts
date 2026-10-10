// Signal calibration (phase 12): which commercial events actually turn into
// revenue, and how much should each be trusted?
//
//   funnel per event kind   opportunity → conversation → quote → win → revenue
//   combination lift        "A+B+C wins 6.7× as often as A alone"
//   event-kind weights      a bounded multiplier per kind (0.5–1.5) from its
//                           shrunk win rate vs the baseline — proposed as an
//                           EVENT_KIND_WEIGHT LearningRecommendation; a human
//                           approves it before scoring uses it
//
// Pure and deterministic. Win rates are over closed opportunities (WON/LOST)
// and shrunk toward the baseline (Bayesian, like learningLoop.ts), so a lucky
// 3/3 can't swing a weight to the cap.
import type { OutcomeGraphStage } from './outcomeGraph.js'

export type CalibrationItem = {
  opportunityId: string
  /** The kind the opportunity was built on. */
  eventType: string
  /** Every event kind detected at the company by the time it closed. */
  eventKinds: string[]
  /** Stages reached, with implied stages (a win implies a quote). */
  reached: OutcomeGraphStage[]
  final: 'WON' | 'LOST' | null
  revenueCents: number | null
  /** When it closed (ISO), for time-ordered holdout evaluation; null while open. */
  closedAt?: string | null
}

export type KindFunnel = {
  eventType: string
  opportunities: number
  conversations: number
  quotes: number
  closed: number
  won: number
  revenueCents: number
  /** Of opportunities, the share that reached a conversation (reply or meeting). */
  conversationRate: number | null
  /** Of closed opportunities, the share won. */
  winRate: number | null
  /** Win rate shrunk toward the baseline. */
  adjustedWinRate: number | null
}

export type CombinationLift = {
  /** The base kind plus the other kinds present, sorted. */
  kinds: string[]
  base: string
  closed: number
  won: number
  winRate: number
  /** Base kind with no other kind present. */
  baseAloneWinRate: number
  /** Adjusted win rate of the combination over the base alone (shrunk). */
  lift: number
}

export type CalibrationReport = {
  closed: number
  won: number
  baselineWinRate: number | null
  funnels: KindFunnel[]
  combinations: CombinationLift[]
}

/** Pseudocount strength pulling small samples toward the baseline. */
const SHRINKAGE_PRIOR = 5
export const WEIGHT_MIN = 0.5
export const WEIGHT_MAX = 1.5
/** Closed outcomes a kind (or combination) needs before it is weighed. */
export const MIN_KIND_CLOSED = 5

const r3 = (x: number) => Math.round(x * 1000) / 1000
const rate = (n: number, d: number) => (d === 0 ? null : r3(n / d))
function shrink(won: number, closed: number, baseline: number): number {
  return (won + SHRINKAGE_PRIOR * baseline) / (closed + SHRINKAGE_PRIOR)
}

export function buildCalibrationReport(items: CalibrationItem[], opts: { minClosed?: number } = {}): CalibrationReport {
  const minClosed = opts.minClosed ?? MIN_KIND_CLOSED
  const closedItems = items.filter(i => i.final)
  const won = closedItems.filter(i => i.final === 'WON').length
  const baseline = closedItems.length ? won / closedItems.length : null

  const byKind = new Map<string, CalibrationItem[]>()
  for (const i of items) byKind.set(i.eventType, [...(byKind.get(i.eventType) ?? []), i])
  const funnels: KindFunnel[] = [...byKind.entries()].map(([eventType, its]) => {
    const has = (i: CalibrationItem, s: OutcomeGraphStage) => i.reached.includes(s)
    const closed = its.filter(i => i.final)
    const w = closed.filter(i => i.final === 'WON')
    return {
      eventType,
      opportunities: its.length,
      conversations: its.filter(i => has(i, 'REPLIED') || has(i, 'MEETING')).length,
      quotes: its.filter(i => has(i, 'QUOTED')).length,
      closed: closed.length,
      won: w.length,
      revenueCents: w.reduce((a, i) => a + (i.revenueCents ?? 0), 0),
      conversationRate: rate(its.filter(i => has(i, 'REPLIED') || has(i, 'MEETING')).length, its.length),
      winRate: rate(w.length, closed.length),
      adjustedWinRate: baseline != null && closed.length ? r3(shrink(w.length, closed.length, baseline)) : null,
    }
  }).sort((a, b) => b.opportunities - a.opportunities || a.eventType.localeCompare(b.eventType))

  const combinations: CombinationLift[] = []
  if (baseline != null) {
    const groups = new Map<string, CalibrationItem[]>()
    for (const i of closedItems) {
      const kinds = [...new Set([i.eventType, ...i.eventKinds])].sort()
      const key = `${i.eventType}|${kinds.join('+')}`
      groups.set(key, [...(groups.get(key) ?? []), i])
    }
    for (const [key, its] of groups) {
      const [base, combo] = key.split('|')
      const kinds = combo.split('+')
      if (kinds.length < 2 || its.length < minClosed) continue
      const alone = groups.get(`${base}|${base}`) ?? []
      if (alone.length < minClosed) continue
      const w = its.filter(i => i.final === 'WON').length
      const wAlone = alone.filter(i => i.final === 'WON').length
      const adjCombo = shrink(w, its.length, baseline)
      const adjAlone = shrink(wAlone, alone.length, baseline)
      combinations.push({
        kinds, base, closed: its.length, won: w,
        winRate: r3(w / its.length),
        baseAloneWinRate: r3(wAlone / alone.length),
        lift: adjAlone > 0 ? Math.round((adjCombo / adjAlone) * 100) / 100 : 0,
      })
    }
    combinations.sort((a, b) => b.lift - a.lift || b.closed - a.closed)
  }
  return { closed: closedItems.length, won, baselineWinRate: baseline != null ? r3(baseline) : null, funnels, combinations }
}

/**
 * A bounded weight per event kind with at least `minClosed` closed outcomes:
 * adjusted win rate ÷ baseline, clamped to [WEIGHT_MIN, WEIGHT_MAX]. Kinds below
 * the sample bar are left out (they keep weight 1). Nothing is proposed without
 * a win to learn from.
 */
export function proposeEventKindWeights(report: CalibrationReport, opts: { minClosed?: number } = {}): Record<string, number> {
  const minClosed = opts.minClosed ?? MIN_KIND_CLOSED
  if (!report.baselineWinRate || report.won === 0) return {}
  const out: Record<string, number> = {}
  for (const f of report.funnels) {
    if (f.closed < minClosed || f.adjustedWinRate == null) continue
    const w = f.adjustedWinRate / report.baselineWinRate
    out[f.eventType] = Math.round(Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, w)) * 100) / 100
  }
  return out
}

/** The weight scoring applies for a kind: the approved one, else 1 (neutral). */
export function eventKindWeight(weights: Record<string, number> | null | undefined, kind: string): number {
  const w = weights?.[kind]
  return typeof w === 'number' && Number.isFinite(w) ? Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, w)) : 1
}

// ── Held-out evaluation (UQ-29) ──────────────────────────────────────────────
// A proposal must not grade itself on the outcomes it was fitted to. Closed
// outcomes are ordered by close date; the newest HOLDOUT_SHARE are held back,
// candidate weights are fitted on the older ones only, and the live and
// candidate weights are scored on the same held-back outcomes. Only a real
// improvement in calibration (Brier) without a material ranking (AUC) loss
// counts — approving an EVENT_KIND_WEIGHT proposal requires it.

export type HeldOutVerdict = 'IMPROVED' | 'NO_IMPROVEMENT' | 'DEGRADED' | 'INSUFFICIENT'

export type HeldOutMetrics = { brier: number; auc: number | null }

export type HeldOutEvaluation = {
  verdict: HeldOutVerdict
  reason: string
  trainSize: number
  holdoutSize: number
  holdoutFrom: string | null
  holdoutTo: string | null
  baseline: HeldOutMetrics | null
  candidate: HeldOutMetrics | null
  /** baseline − candidate: positive means the candidate's error is lower. */
  brierImprovement: number | null
  /** candidate − baseline AUC. */
  aucDelta: number | null
}

export const HOLDOUT_SHARE = 0.3
export const MIN_HOLDOUT = 10
export const MIN_TRAIN = 10
/** Brier improvement below this is noise, not evidence. */
export const BRIER_NOISE = 0.002
/** An AUC drop beyond this blocks promotion even when Brier improves. */
export const MAX_AUC_DROP = 0.02

const r4 = (x: number) => Math.round(x * 10_000) / 10_000

/** Win probability for an item under a weight set: base rate × its kind's weight. */
function predict(baseRate: number, weights: Record<string, number>, kind: string): number {
  return Math.min(0.99, Math.max(0.01, baseRate * eventKindWeight(weights, kind)))
}

function brier(ps: number[], ys: number[]): number {
  return ps.reduce((a, p, i) => a + (p - ys[i]) ** 2, 0) / ps.length
}

/** Pairwise AUC (ties count half); null without both a win and a loss. */
function auc(ps: number[], ys: number[]): number | null {
  const pos = ps.filter((_, i) => ys[i] === 1)
  const neg = ps.filter((_, i) => ys[i] === 0)
  if (!pos.length || !neg.length) return null
  let s = 0
  for (const p of pos) for (const n of neg) s += p > n ? 1 : p === n ? 0.5 : 0
  return s / (pos.length * neg.length)
}

export function evaluateEventKindWeights(
  items: CalibrationItem[],
  currentWeights: Record<string, number>,
  opts: { minClosed?: number } = {},
): HeldOutEvaluation {
  const closed = items
    .filter(i => i.final && i.closedAt)
    .sort((a, b) => Date.parse(a.closedAt!) - Date.parse(b.closedAt!) || a.opportunityId.localeCompare(b.opportunityId))
  const holdoutSize = Math.max(MIN_HOLDOUT, Math.round(closed.length * HOLDOUT_SHARE))
  const train = closed.slice(0, closed.length - holdoutSize)
  const holdout = closed.slice(closed.length - holdoutSize)
  const empty = { baseline: null, candidate: null, brierImprovement: null, aucDelta: null }
  const window = { holdoutFrom: holdout[0]?.closedAt ?? null, holdoutTo: holdout.at(-1)?.closedAt ?? null }
  if (closed.length < MIN_TRAIN + MIN_HOLDOUT || train.length < MIN_TRAIN) {
    return { verdict: 'INSUFFICIENT', reason: `Needs at least ${MIN_TRAIN + MIN_HOLDOUT} dated closed outcomes to test on unseen ones; has ${closed.length}`, trainSize: train.length, holdoutSize: Math.min(holdoutSize, closed.length), ...window, ...empty }
  }
  const trainReport = buildCalibrationReport(train, opts)
  const learned = proposeEventKindWeights(trainReport, opts)
  if (!trainReport.baselineWinRate || !Object.keys(learned).length) {
    return { verdict: 'INSUFFICIENT', reason: 'The older outcomes alone support no weight change to test', trainSize: train.length, holdoutSize, ...window, ...empty }
  }
  const candidateWeights = { ...currentWeights, ...learned }
  const base = trainReport.baselineWinRate
  const ys = holdout.map(i => (i.final === 'WON' ? 1 : 0))
  const pb = holdout.map(i => predict(base, currentWeights, i.eventType))
  const pc = holdout.map(i => predict(base, candidateWeights, i.eventType))
  const baseline = { brier: r4(brier(pb, ys)), auc: auc(pb, ys) }
  const candidate = { brier: r4(brier(pc, ys)), auc: auc(pc, ys) }
  const brierImprovement = r4(baseline.brier - candidate.brier)
  const aucDelta = baseline.auc != null && candidate.auc != null ? r4(candidate.auc - baseline.auc) : null
  const rankingHeld = aucDelta == null || aucDelta >= -MAX_AUC_DROP
  const verdict: HeldOutVerdict = brierImprovement > BRIER_NOISE && rankingHeld
    ? 'IMPROVED'
    : brierImprovement < -BRIER_NOISE || !rankingHeld ? 'DEGRADED' : 'NO_IMPROVEMENT'
  const reason = verdict === 'IMPROVED'
    ? `Predicted the ${holdout.length} newest outcomes better than the current weights`
    : verdict === 'DEGRADED'
      ? `Predicted the ${holdout.length} newest outcomes worse than the current weights${rankingHeld ? '' : ' (ranking got worse)'}`
      : `No measurable gain on the ${holdout.length} newest outcomes`
  return { verdict, reason, trainSize: train.length, holdoutSize: holdout.length, ...window, baseline, candidate, brierImprovement, aucDelta }
}

/** The held-out evaluation stored on an EVENT_KIND_WEIGHT proposal, if any. */
export function heldOutOf(evidence: unknown): HeldOutEvaluation | null {
  const h = (evidence as { heldOut?: HeldOutEvaluation } | null)?.heldOut
  return h && typeof h.verdict === 'string' ? h : null
}
