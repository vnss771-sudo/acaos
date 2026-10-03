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

export const JOB_ECONOMICS_VERSION = 1

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

  const quotedCents = input.quote?.amountCents ?? null
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
