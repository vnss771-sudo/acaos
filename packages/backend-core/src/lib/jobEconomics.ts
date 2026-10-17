// Job economics (phase 15A): quoted vs delivered, and the margin it produced.
//
// Pure and deterministic — no I/O, no clock. The route loads a job's shifts,
// crew rates and accepted quote and passes them in; the same function computes
// the live view of an ACTIVE job and the frozen closeout snapshot.
//
// Economic truth rules (docs/ACQUISITION_OS_DELIVERY.md) this file enforces:
// - Shifts are the only source of actual hours; open shifts are counted, never
//   summed (closeout refuses while any are open).
// - A missing crew rate makes labour cost UNKNOWN, never $0. No recorded hours
//   at all is also unknown labour, not free labour.
// - Missing other costs make gross margin unknown; labour margin is reported
//   separately and labelled as such.
// - Missing revenue makes every margin unknown.
// - Money is integer cents throughout.

// v2 (UQ-35): approved variations and the adjusted contract value.
export const JOB_ECONOMICS_VERSION = 2

export interface EconomicsShift {
  crewMemberId: string
  totalHours: number
  // null = still open (in progress).
  endTime: Date | string | null
}

export interface EconomicsInput {
  shifts: EconomicsShift[]
  // Hourly base rate in dollars per crew member; null/absent = not recorded.
  rates: ReadonlyMap<string, number | null>
  quote: { amountCents: number; estimatedHours: number | null } | null
  revenueCents: number | null
  otherCostCents: number | null
  // Labour on-cost loading (super, workers' comp, …) as a percentage of base pay.
  onCostPct?: number
  // APPROVED variations only (UQ-35). Null = not priced / not estimated.
  variations?: Array<{ revenueCents: number | null; estimatedCostCents: number | null }>
}

export type MarginBasis = 'GROSS' | 'LABOUR' | 'UNKNOWN'

export interface JobEconomics {
  version: number
  actualHours: number
  openShifts: number
  costedHours: number
  // Share of actual hours with a known rate; null when there are no hours.
  rateCoverage: number | null
  onCostPct: number
  labourCostCents: number | null
  otherCostCents: number | null
  revenueCents: number | null
  quotedCents: number | null
  estimatedHours: number | null
  // (actual - estimated) / estimated, as a percentage. Positive = overran.
  hoursVariancePct: number | null
  // (revenue - quoted) / quoted, as a percentage. Often variations (scope the
  // client added), so it is "revenue vs quote", not an estimating error.
  revenueVsQuotePct: number | null
  // UQ-35: approved scope changes. The quote above is never rewritten; the
  // adjusted contract is quote + approved variation prices. Estimated variation
  // cost stays an estimate and never enters the actual margins below.
  approvedVariations: number
  approvedVariationRevenueCents: number | null
  approvedVariationCostCents: number | null
  adjustedQuotedCents: number | null
  revenueVsAdjustedQuotePct: number | null
  labourMarginCents: number | null
  labourMarginPct: number | null
  grossMarginCents: number | null
  grossMarginPct: number | null
  // The strongest margin that is honestly known.
  marginBasis: MarginBasis
  // Plain-language reasons for every unknown, for the UI and the audit trail.
  gaps: string[]
}

const round2 = (n: number) => Math.round(n * 100) / 100
const pct = (num: number, den: number): number | null => (den > 0 ? Math.round((num / den) * 1000) / 10 : null)

export function computeJobEconomics(input: EconomicsInput): JobEconomics {
  const onCostPct = Math.max(0, input.onCostPct ?? 0)
  const gaps: string[] = []

  let actualHours = 0
  let costedHours = 0
  let openShifts = 0
  let labourDollars = 0
  const unratedCrew = new Set<string>()
  for (const s of input.shifts) {
    if (s.endTime == null) { openShifts++; continue }
    const hours = Math.max(0, s.totalHours)
    actualHours += hours
    const rate = input.rates.get(s.crewMemberId)
    if (rate == null || !Number.isFinite(rate) || rate < 0) { if (hours > 0) unratedCrew.add(s.crewMemberId); continue }
    costedHours += hours
    labourDollars += hours * rate
  }
  actualHours = round2(actualHours)
  costedHours = round2(costedHours)

  let labourCostCents: number | null = null
  if (openShifts > 0) gaps.push(`${openShifts} shift(s) still open`)
  if (actualHours === 0) gaps.push('No completed shift hours recorded, so labour cost is unknown')
  else if (unratedCrew.size > 0) gaps.push(`${unratedCrew.size} crew member(s) have no base rate, so labour cost is unknown`)
  else labourCostCents = Math.round(labourDollars * (1 + onCostPct / 100) * 100)
  if (labourCostCents != null && onCostPct === 0) gaps.push('Labour cost excludes on-costs (no on-cost % given)')

  const revenueCents = input.revenueCents
  const otherCostCents = input.otherCostCents
  if (revenueCents == null) gaps.push('No invoiced revenue entered, so margin is unknown')
  if (otherCostCents == null) gaps.push('Other costs (materials, subcontractors) not entered, so gross margin is unknown')

  const labourMarginCents = revenueCents != null && labourCostCents != null ? revenueCents - labourCostCents : null
  const grossMarginCents = labourMarginCents != null && otherCostCents != null ? labourMarginCents - otherCostCents : null
  const marginBasis: MarginBasis = grossMarginCents != null ? 'GROSS' : labourMarginCents != null ? 'LABOUR' : 'UNKNOWN'

  const approved = input.variations ?? []
  const sumKnown = (xs: Array<number | null>): number | null => (xs.some(x => x == null) ? null : xs.reduce<number>((a, x) => a + (x as number), 0))
  const approvedVariationRevenueCents = sumKnown(approved.map(v => v.revenueCents))
  const approvedVariationCostCents = sumKnown(approved.map(v => v.estimatedCostCents))
  if (approved.length && approvedVariationRevenueCents == null) gaps.push('An approved variation has no price, so the adjusted contract value is unknown')

  const quotedCents = input.quote?.amountCents ?? null
  const adjustedQuotedCents = quotedCents != null && approvedVariationRevenueCents != null ? quotedCents + approvedVariationRevenueCents : null
  const estimatedHours = input.quote?.estimatedHours ?? null
  if (!input.quote) gaps.push('No accepted quote, so there is nothing to compare against')
  else if (estimatedHours == null) gaps.push('The quote has no estimated hours, so hours variance is unknown')

  return {
    version: JOB_ECONOMICS_VERSION,
    actualHours,
    openShifts,
    costedHours,
    rateCoverage: actualHours > 0 ? Math.round((costedHours / actualHours) * 1000) / 1000 : null,
    onCostPct,
    labourCostCents,
    otherCostCents,
    revenueCents,
    quotedCents,
    estimatedHours,
    hoursVariancePct: estimatedHours != null && actualHours > 0 ? pct(actualHours - estimatedHours, estimatedHours) : null,
    revenueVsQuotePct: quotedCents != null && revenueCents != null ? pct(revenueCents - quotedCents, quotedCents) : null,
    approvedVariations: approved.length,
    approvedVariationRevenueCents,
    approvedVariationCostCents,
    adjustedQuotedCents,
    revenueVsAdjustedQuotePct: adjustedQuotedCents != null && revenueCents != null ? pct(revenueCents - adjustedQuotedCents, adjustedQuotedCents) : null,
    labourMarginCents,
    labourMarginPct: labourMarginCents != null && revenueCents ? pct(labourMarginCents, revenueCents) : null,
    grossMarginCents,
    grossMarginPct: grossMarginCents != null && revenueCents ? pct(grossMarginCents, revenueCents) : null,
    marginBasis,
    gaps,
  }
}

// Quote lifecycle: which status changes an operator may make.
export const QUOTE_STATUSES = ['DRAFT', 'SUBMITTED', 'ACCEPTED', 'REJECTED', 'WITHDRAWN'] as const
export type QuoteStatus = typeof QUOTE_STATUSES[number]

const QUOTE_TRANSITIONS: Record<QuoteStatus, readonly QuoteStatus[]> = {
  DRAFT: ['SUBMITTED', 'WITHDRAWN'],
  SUBMITTED: ['ACCEPTED', 'REJECTED', 'WITHDRAWN'],
  ACCEPTED: [],
  REJECTED: [],
  WITHDRAWN: [],
}

export function canTransitionQuote(from: string, to: QuoteStatus): boolean {
  return (QUOTE_TRANSITIONS[from as QuoteStatus] ?? []).includes(to)
}

// ── Delivery report (phase 15B) ──────────────────────────────────────────────
// Closed jobs grouped by where the work came from. Medians, not means (a few
// jobs, outliers); every figure carries its n; below the floor a metric is
// withheld rather than guessed (truth rule 7).

export const DELIVERY_REPORT_MIN_JOBS = 3

export interface ReportJob {
  originKey: string
  originLabel: string
  economics: JobEconomics
}

export interface ReportStat { n: number; median: number; min: number; max: number }

export interface ReportGroup {
  key: string
  label: string
  jobs: number
  hoursVariancePct: ReportStat | null
  revenueVsQuotePct: ReportStat | null
  labourMarginPct: ReportStat | null
  grossMarginPct: ReportStat | null
}

export interface DeliveryReport {
  minJobs: number
  overall: ReportGroup
  groups: ReportGroup[]
}

function stat(values: Array<number | null>, minJobs: number): ReportStat | null {
  const v = values.filter((x): x is number => x != null && Number.isFinite(x)).sort((a, b) => a - b)
  if (v.length < minJobs) return null
  const mid = Math.floor(v.length / 2)
  const median = v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2
  return { n: v.length, median: Math.round(median * 10) / 10, min: v[0], max: v[v.length - 1] }
}

function group(key: string, label: string, jobs: ReportJob[], minJobs: number): ReportGroup {
  const e = jobs.map(j => j.economics)
  return {
    key, label, jobs: jobs.length,
    hoursVariancePct: stat(e.map(x => x.hoursVariancePct), minJobs),
    revenueVsQuotePct: stat(e.map(x => x.revenueVsQuotePct), minJobs),
    // Labour margin is only comparable where labour cost is known; gross only where GROSS.
    labourMarginPct: stat(e.map(x => x.labourMarginPct), minJobs),
    grossMarginPct: stat(e.filter(x => x.marginBasis === 'GROSS').map(x => x.grossMarginPct), minJobs),
  }
}

export function buildDeliveryReport(jobs: ReportJob[], minJobs = DELIVERY_REPORT_MIN_JOBS): DeliveryReport {
  const byKey = new Map<string, ReportJob[]>()
  for (const j of jobs) byKey.set(j.originKey, [...(byKey.get(j.originKey) ?? []), j])
  const groups = [...byKey.entries()]
    .map(([key, list]) => group(key, list[0].originLabel, list, minJobs))
    .sort((a, b) => b.jobs - a.jobs || a.label.localeCompare(b.label))
  return { minJobs, overall: group('ALL', 'All closed jobs', jobs, minJobs), groups }
}

// ── Estimate check (quote time) ─────────────────────────────────────────────
// Before a price goes out: how did recent closed jobs of the same origin land
// against their estimated hours? The delivery report's grouping, median and
// floor, read at the moment it can still change the quote. Advisory only
// (truth rule 10): it never alters a quote. A job with approved variations is
// left out — its hours were for a different scope, not an estimating miss.
// Below the floor for the origin it falls back to all closed jobs, labelled so;
// below the floor overall it says nothing (truth rule 7).

export const ESTIMATE_CHECK_RECENT_JOBS = 10
// A median within ±this of the estimate is "on target": no adjustment suggested.
export const ESTIMATE_CHECK_THRESHOLD_PCT = 10

export interface EstimateCheckJob {
  originKey: string
  completedAt: Date | string | null
  economics: JobEconomics
}

export type EstimateCheckBasis = 'SAME_ORIGIN' | 'ALL_JOBS'

export interface EstimateCheck {
  minJobs: number
  thresholdPct: number
  // Which jobs the figures are from; null = too few to say anything.
  basis: EstimateCheckBasis | null
  label: string
  // Comparable closed jobs of this origin (hours variance known, scope unchanged), before the recent cap.
  sameOriginJobs: number
  // Closed jobs left out of the chosen pool because approved variations changed the scope.
  scopeChangedJobs: number
  hoursVariancePct: ReportStat | null
  // Of the jobs in the stat, how many took more hours than estimated.
  overran: number | null
  direction: 'OVER' | 'UNDER' | 'ON_TARGET' | null
  // Multiply an hours estimate by this to match the track record; null unless OVER/UNDER.
  hoursFactor: number | null
  message: string | null
}

const completedMs = (j: EstimateCheckJob) => (j.completedAt ? new Date(j.completedAt).getTime() : 0)

export function buildEstimateCheck(
  target: { originKey: string; originLabel: string },
  jobs: EstimateCheckJob[],
  opts: { minJobs?: number; recentJobs?: number; thresholdPct?: number } = {},
): EstimateCheck {
  const minJobs = opts.minJobs ?? DELIVERY_REPORT_MIN_JOBS
  const recentJobs = opts.recentJobs ?? ESTIMATE_CHECK_RECENT_JOBS
  const thresholdPct = opts.thresholdPct ?? ESTIMATE_CHECK_THRESHOLD_PCT
  const measured = jobs
    .filter(j => j.economics.hoursVariancePct != null && Number.isFinite(j.economics.hoursVariancePct))
    .sort((a, b) => completedMs(b) - completedMs(a))
  // Economics v1 predate variations: absent means none.
  const scopeChanged = (j: EstimateCheckJob) => (j.economics.approvedVariations ?? 0) > 0
  const sameOrigin = measured.filter(j => j.originKey === target.originKey)
  const sameUsable = sameOrigin.filter(j => !scopeChanged(j))
  const allUsable = measured.filter(j => !scopeChanged(j))

  const basis: EstimateCheckBasis | null = sameUsable.length >= minJobs ? 'SAME_ORIGIN' : allUsable.length >= minJobs ? 'ALL_JOBS' : null
  const domain = basis === 'ALL_JOBS' ? measured : sameOrigin
  const pool = (basis === 'ALL_JOBS' ? allUsable : sameUsable).slice(0, recentJobs)
  const variance = basis ? stat(pool.map(j => j.economics.hoursVariancePct), minJobs) : null
  const base = {
    minJobs, thresholdPct, basis,
    label: basis === 'ALL_JOBS' ? 'All closed jobs' : target.originLabel,
    sameOriginJobs: sameUsable.length,
    scopeChangedJobs: domain.filter(scopeChanged).length,
  }
  if (!variance) return { ...base, basis: null, hoursVariancePct: null, overran: null, direction: null, hoursFactor: null, message: null }

  const overran = pool.filter(j => (j.economics.hoursVariancePct as number) > 0).length
  const m = variance.median
  const direction = m >= thresholdPct ? 'OVER' : m <= -thresholdPct ? 'UNDER' : 'ON_TARGET'
  const subject = basis === 'SAME_ORIGIN'
    ? `${target.originLabel} — your last ${variance.n} closed jobs`
    : `Across your last ${variance.n} closed jobs (fewer than ${minJobs} of this kind so far)`
  const message = direction === 'OVER'
    ? `${subject} took a median ${m}% more hours than estimated (${overran} of ${variance.n} ran over). Review the labour allowance before you send this quote.`
    : direction === 'UNDER'
      ? `${subject} took a median ${Math.abs(m)}% fewer hours than estimated. Your labour allowance may be pricing you out.`
      : `${subject} landed within ${thresholdPct}% of their estimated hours (median ${m > 0 ? '+' : ''}${m}%).`
  return {
    ...base, hoursVariancePct: variance, overran, direction,
    hoursFactor: direction === 'ON_TARGET' ? null : Math.round((1 + m / 100) * 1000) / 1000,
    message,
  }
}

// Variation lifecycle (UQ-35). Decided variations are history, never edited.
export const VARIATION_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED'] as const
export type VariationStatus = typeof VARIATION_STATUSES[number]
const VARIATION_TRANSITIONS: Record<VariationStatus, readonly VariationStatus[]> = {
  DRAFT: ['SUBMITTED', 'CANCELLED'],
  SUBMITTED: ['APPROVED', 'REJECTED', 'CANCELLED'],
  APPROVED: [],
  REJECTED: [],
  CANCELLED: [],
}
export function canTransitionVariation(from: string, to: string): boolean {
  return (VARIATION_TRANSITIONS as Record<string, readonly string[]>)[from]?.includes(to) ?? false
}
