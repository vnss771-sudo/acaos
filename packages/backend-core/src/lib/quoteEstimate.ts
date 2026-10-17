// Quote estimate builder: what a price leaves after the costs the contractor
// has estimated, and what price a target margin needs.
//
// Pure and deterministic — no I/O, no clock — and on jobEconomics.ts's
// definitions, so an estimate and the closeout of the job it becomes compare
// like for like:
// - labour cost = hours × base rate × (1 + on-cost %), integer cents;
// - gross margin = price − labour − materials − subcontractors (direct costs);
// - overheads are a separate line: margin after overheads.
//
// Unknown is never zero. A blank input makes everything that depends on it
// unknown, with a plain-language entry in `gaps`; the parts that ARE known are
// still summed, labelled as known so far. Advisory only: nothing here changes
// or sends a quote.

export const QUOTE_ESTIMATE_VERSION = 1

// Percentage limits shared by the estimate inputs, the workspace quoting defaults
// and the database CHECKs on Workspace.default*Pct. On-costs and overheads may
// exceed 100 % of their base; a gross margin of 100 % or more is impossible.
export const ESTIMATE_PCT_LIMITS = { onCostPct: 200, overheadPct: 200, targetMarginPct: 95 } as const

export interface EstimateInputs {
  labourHours: number | null
  // Base pay, dollars per hour.
  labourRate: number | null
  // Super, workers' comp, … as a % of base pay. Null = not entered: labour cost
  // is then base pay only and says so (as the closeout does).
  onCostPct: number | null
  materialsCents: number | null
  subcontractCents: number | null
  // Overhead recovery as a % of direct costs.
  overheadPct: number | null
  // Gross margin % the price should leave, 0 ≤ x < 100.
  targetMarginPct: number | null
}

export interface EstimateTrackRecord {
  hoursFactor: number
  adjustedHours: number
  labourCostCents: number | null
  directCostCents: number | null
  grossMarginCents: number | null
  grossMarginPct: number | null
  marginAfterOverheadsCents: number | null
  marginAfterOverheadsPct: number | null
}

export interface EstimateResult {
  version: number
  labourCostCents: number | null
  labourIncludesOnCosts: boolean
  materialsCents: number | null
  subcontractCents: number | null
  // Labour + materials + subcontractors; null if any is unknown.
  directCostCents: number | null
  // Sum of the direct costs that are known: a floor, never presented as the total.
  knownDirectCostCents: number
  overheadCents: number | null
  // Direct costs + overheads: the break-even price.
  totalCostCents: number | null
  priceCents: number | null
  grossMarginCents: number | null
  grossMarginPct: number | null
  marginAfterOverheadsCents: number | null
  marginAfterOverheadsPct: number | null
  targetMarginPct: number | null
  // Lowest price that leaves the target gross margin over direct costs.
  priceForTargetCents: number | null
  // The same figures with labour hours scaled by the estimate check's hoursFactor:
  // what this price is likely to leave if the job runs like recent ones did.
  trackRecord: EstimateTrackRecord | null
  gaps: string[]
}

const pct = (num: number, den: number): number | null => (den > 0 ? Math.round((num / den) * 1000) / 10 : null)
const known = (n: number | null | undefined): n is number => n != null && Number.isFinite(n)

function labourCost(hours: number | null, rate: number | null, onCostPct: number | null): number | null {
  if (!known(hours) || !known(rate)) return null
  return Math.round(hours * rate * (1 + (known(onCostPct) ? onCostPct : 0) / 100) * 100)
}

function margins(priceCents: number | null, direct: number | null, overhead: number | null) {
  const gross = known(priceCents) && known(direct) ? priceCents - direct : null
  const afterOverheads = gross != null && known(overhead) ? gross - overhead : null
  return {
    grossMarginCents: gross,
    grossMarginPct: gross != null && priceCents ? pct(gross, priceCents) : null,
    marginAfterOverheadsCents: afterOverheads,
    marginAfterOverheadsPct: afterOverheads != null && priceCents ? pct(afterOverheads, priceCents) : null,
  }
}

const overheadOf = (direct: number | null, overheadPct: number | null) =>
  known(direct) && known(overheadPct) ? Math.round(direct * overheadPct / 100) : null

const sumOrNull = (xs: Array<number | null>): number | null => (xs.every(known) ? (xs as number[]).reduce((a, x) => a + x, 0) : null)

export function computeEstimate(
  inputs: EstimateInputs,
  opts: { priceCents?: number | null; hoursFactor?: number | null } = {},
): EstimateResult {
  const gaps: string[] = []
  const { labourHours, labourRate, onCostPct, materialsCents, subcontractCents, overheadPct, targetMarginPct } = inputs
  const priceCents = opts.priceCents ?? null

  const labourCostCents = labourCost(labourHours, labourRate, onCostPct)
  if (!known(labourHours)) gaps.push('Labour hours not entered, so labour cost is unknown')
  else if (!known(labourRate)) gaps.push('Labour rate not entered, so labour cost is unknown')
  else if (!known(onCostPct)) gaps.push('Labour cost is base pay only (no on-cost % entered)')
  if (!known(materialsCents)) gaps.push('Materials not entered, so direct cost is unknown')
  if (!known(subcontractCents)) gaps.push('Subcontractors not entered, so direct cost is unknown')

  const parts = [labourCostCents, materialsCents ?? null, subcontractCents ?? null]
  const directCostCents = sumOrNull(parts)
  const knownDirectCostCents = parts.filter(known).reduce((a, x) => a + x, 0)
  if (!known(overheadPct)) gaps.push('Overhead % not entered, so margin after overheads is unknown')
  const overheadCents = overheadOf(directCostCents, overheadPct)
  const totalCostCents = known(directCostCents) && known(overheadCents) ? directCostCents + overheadCents : null
  if (!known(priceCents)) gaps.push('No quote price entered, so margin is unknown')

  const priceForTargetCents = known(directCostCents) && known(targetMarginPct) && targetMarginPct < 100
    ? Math.ceil(directCostCents / (1 - targetMarginPct / 100))
    : null

  let trackRecord: EstimateTrackRecord | null = null
  const factor = opts.hoursFactor
  if (known(factor) && factor > 0 && known(labourHours)) {
    const adjustedHours = Math.round(labourHours * factor * 10) / 10
    const lc = labourCost(adjustedHours, labourRate, onCostPct)
    const direct = sumOrNull([lc, materialsCents ?? null, subcontractCents ?? null])
    trackRecord = { hoursFactor: factor, adjustedHours, labourCostCents: lc, directCostCents: direct, ...margins(priceCents, direct, overheadOf(direct, overheadPct)) }
  }

  return {
    version: QUOTE_ESTIMATE_VERSION,
    labourCostCents,
    labourIncludesOnCosts: labourCostCents != null && known(onCostPct),
    materialsCents: materialsCents ?? null,
    subcontractCents: subcontractCents ?? null,
    directCostCents,
    knownDirectCostCents,
    overheadCents,
    totalCostCents,
    priceCents,
    ...margins(priceCents, directCostCents, overheadCents),
    targetMarginPct: targetMarginPct ?? null,
    priceForTargetCents,
    trackRecord,
    gaps,
  }
}

/** Middle base rate of active crew with a recorded rate; unrated crew are counted, never treated as $0. */
export function crewRateSummary(crew: Array<{ baseRate: number | null }>): { activeCrew: number; ratedCrew: number; medianBaseRate: number | null } {
  const rates = crew.map(c => c.baseRate).filter((r): r is number => known(r) && r > 0).sort((a, b) => a - b)
  const mid = Math.floor(rates.length / 2)
  const median = rates.length === 0 ? null : rates.length % 2 ? rates[mid] : (rates[mid - 1] + rates[mid]) / 2
  return { activeCrew: crew.length, ratedCrew: rates.length, medianBaseRate: median == null ? null : Math.round(median * 100) / 100 }
}
