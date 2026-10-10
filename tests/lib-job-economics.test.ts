import test from 'node:test'
import assert from 'node:assert/strict'
import { computeJobEconomics, canTransitionQuote, canTransitionVariation, buildDeliveryReport, type EconomicsShift, type ReportJob } from '../packages/backend-core/src/lib/jobEconomics.ts'

const done = new Date('2026-10-01T16:00:00Z')
const shift = (crewMemberId: string, totalHours: number, endTime: Date | null = done): EconomicsShift => ({ crewMemberId, totalHours, endTime })
const rates = new Map<string, number | null>([['a', 50], ['b', 40], ['c', null]])

test('fully known job: gross margin, variance against the quote, on-costs applied', () => {
  const e = computeJobEconomics({
    shifts: [shift('a', 300), shift('b', 230)],
    rates,
    quote: { amountCents: 6_000_000, estimatedHours: 400 },
    revenueCents: 6_200_000,
    otherCostCents: 2_500_000,
    onCostPct: 20,
  })
  assert.equal(e.actualHours, 530)
  assert.equal(e.rateCoverage, 1)
  // (300×50 + 230×40) × 1.2 = 29,040 dollars
  assert.equal(e.labourCostCents, 2_904_000)
  assert.equal(e.labourMarginCents, 6_200_000 - 2_904_000)
  assert.equal(e.grossMarginCents, 6_200_000 - 2_904_000 - 2_500_000)
  assert.equal(e.grossMarginPct, 12.8)
  assert.equal(e.marginBasis, 'GROSS')
  assert.equal(e.hoursVariancePct, 32.5)
  assert.equal(e.revenueVsQuotePct, 3.3)
  assert.deepEqual(e.gaps, [])
})

test('a missing crew rate makes labour cost unknown, never zero', () => {
  const e = computeJobEconomics({ shifts: [shift('a', 10), shift('c', 5)], rates, quote: null, revenueCents: 100_000, otherCostCents: 0 })
  assert.equal(e.labourCostCents, null)
  assert.equal(e.costedHours, 10)
  assert.equal(e.rateCoverage, 0.667)
  assert.equal(e.marginBasis, 'UNKNOWN')
  assert.equal(e.grossMarginCents, null)
  assert.ok(e.gaps.some(g => g.includes('no base rate')))
})

test('no recorded hours is unknown labour, not free labour', () => {
  const e = computeJobEconomics({ shifts: [], rates, quote: { amountCents: 100, estimatedHours: 10 }, revenueCents: 100, otherCostCents: 0 })
  assert.equal(e.labourCostCents, null)
  assert.equal(e.rateCoverage, null)
  assert.equal(e.hoursVariancePct, null)
  assert.equal(e.marginBasis, 'UNKNOWN')
})

test('missing other costs: labour margin only, labelled as such', () => {
  const e = computeJobEconomics({ shifts: [shift('a', 10)], rates, quote: { amountCents: 200_000, estimatedHours: null }, revenueCents: 200_000, otherCostCents: null })
  assert.equal(e.labourCostCents, 50_000)
  assert.equal(e.labourMarginPct, 75)
  assert.equal(e.grossMarginCents, null)
  assert.equal(e.marginBasis, 'LABOUR')
  assert.equal(e.hoursVariancePct, null)
  assert.ok(e.gaps.some(g => g.includes('excludes on-costs')))
  assert.ok(e.gaps.some(g => g.includes('no estimated hours')))
})

test('missing revenue: no margin; open shifts are counted, not summed', () => {
  const e = computeJobEconomics({ shifts: [shift('a', 8), shift('a', 3, null)], rates, quote: null, revenueCents: null, otherCostCents: 10 })
  assert.equal(e.openShifts, 1)
  assert.equal(e.actualHours, 8)
  assert.equal(e.labourMarginCents, null)
  assert.equal(e.revenueVsQuotePct, null)
  assert.equal(e.marginBasis, 'UNKNOWN')
  assert.ok(e.gaps.some(g => g.includes('still open')))
  assert.ok(e.gaps.some(g => g.includes('No accepted quote')))
})

test('zero revenue yields a known negative margin with no percentage', () => {
  const e = computeJobEconomics({ shifts: [shift('a', 2)], rates, quote: null, revenueCents: 0, otherCostCents: 0 })
  assert.equal(e.grossMarginCents, -10_000)
  assert.equal(e.grossMarginPct, null)
})

test('quote transitions follow the lifecycle; terminal states are final', () => {
  assert.equal(canTransitionQuote('DRAFT', 'SUBMITTED'), true)
  assert.equal(canTransitionQuote('DRAFT', 'ACCEPTED'), false)
  assert.equal(canTransitionQuote('SUBMITTED', 'ACCEPTED'), true)
  assert.equal(canTransitionQuote('SUBMITTED', 'REJECTED'), true)
  assert.equal(canTransitionQuote('ACCEPTED', 'WITHDRAWN'), false)
  assert.equal(canTransitionQuote('WITHDRAWN', 'SUBMITTED'), false)
  assert.equal(canTransitionQuote('bogus', 'SUBMITTED'), false)
})

function closedJob(originKey: string, revenue: number, labourHours: number, estHours: number, other: number | null): ReportJob {
  return {
    originKey, originLabel: originKey,
    economics: computeJobEconomics({ shifts: [shift('a', labourHours)], rates, quote: { amountCents: revenue, estimatedHours: estHours }, revenueCents: revenue, otherCostCents: other }),
  }
}

test('delivery report: medians with n per origin, withheld below the floor, gross only where gross is known', () => {
  const jobs = [
    closedJob('DA', 1_000_000, 100, 100, 200_000),
    closedJob('DA', 1_000_000, 120, 100, 300_000),
    closedJob('DA', 1_000_000, 80, 100, null),
    closedJob('TENDER', 1_000_000, 100, 100, 100_000),
  ]
  const r = buildDeliveryReport(jobs, 3)
  assert.equal(r.overall.jobs, 4)
  const da = r.groups.find(g => g.key === 'DA')!
  assert.equal(r.groups[0].key, 'DA', 'largest group first')
  assert.deepEqual(da.hoursVariancePct, { n: 3, median: 0, min: -20, max: 20 })
  // Labour cost 5,000/6,000/4,000 dollars on 10,000 revenue → 50/40/60 %.
  assert.deepEqual(da.labourMarginPct, { n: 3, median: 50, min: 40, max: 60 })
  assert.equal(da.grossMarginPct, null, 'only 2 DA jobs have gross basis')
  assert.equal(r.groups.find(g => g.key === 'TENDER')!.hoursVariancePct, null, 'one job is not a pattern')
  assert.equal(r.overall.grossMarginPct!.n, 3)
  assert.equal(r.overall.grossMarginPct!.median, 30)
  assert.deepEqual(buildDeliveryReport([]).groups, [])
})

// ── Variations (UQ-35) ──────────────────────────────────────────────────────

const base = () => ({
  shifts: [shift('a', 300), shift('b', 230)], rates,
  quote: { amountCents: 6_000_000, estimatedHours: 400 }, revenueCents: 6_600_000, otherCostCents: 2_500_000, onCostPct: 20,
})

test('approved variations adjust the contract, never the quote or the actual margin', () => {
  const without = computeJobEconomics(base())
  const e = computeJobEconomics({ ...base(), variations: [
    { revenueCents: 500_000, estimatedCostCents: 200_000 },
    { revenueCents: -100_000, estimatedCostCents: 0 },
  ] })
  assert.equal(e.quotedCents, 6_000_000, 'the accepted quote is unchanged')
  assert.equal(e.approvedVariations, 2)
  assert.equal(e.approvedVariationRevenueCents, 400_000)
  assert.equal(e.approvedVariationCostCents, 200_000)
  assert.equal(e.adjustedQuotedCents, 6_400_000)
  assert.equal(e.revenueVsQuotePct, 10)
  assert.equal(e.revenueVsAdjustedQuotePct, 3.1)
  // Estimated variation cost is not actual cost: margins match the no-variation job.
  assert.equal(e.grossMarginCents, without.grossMarginCents)
  assert.equal(e.otherCostCents, 2_500_000)
})

test('an unpriced approved variation makes the adjusted contract unknown, never zero', () => {
  const e = computeJobEconomics({ ...base(), variations: [{ revenueCents: 500_000, estimatedCostCents: null }, { revenueCents: null, estimatedCostCents: 100 }] })
  assert.equal(e.adjustedQuotedCents, null)
  assert.equal(e.revenueVsAdjustedQuotePct, null)
  assert.equal(e.approvedVariationCostCents, null)
  assert.ok(e.gaps.some(g => /variation has no price/.test(g)))
  const none = computeJobEconomics(base())
  assert.deepEqual([none.approvedVariations, none.approvedVariationRevenueCents, none.adjustedQuotedCents], [0, 0, 6_000_000])
})

test('variation lifecycle: drafts submit, submissions are decided, decisions are final', () => {
  assert.ok(canTransitionVariation('DRAFT', 'SUBMITTED'))
  assert.ok(canTransitionVariation('DRAFT', 'CANCELLED'))
  assert.ok(canTransitionVariation('SUBMITTED', 'APPROVED'))
  assert.ok(canTransitionVariation('SUBMITTED', 'REJECTED'))
  assert.ok(!canTransitionVariation('DRAFT', 'APPROVED'), 'approval needs a submission first')
  for (const done of ['APPROVED', 'REJECTED', 'CANCELLED']) assert.ok(!canTransitionVariation(done, 'SUBMITTED'))
  assert.ok(!canTransitionVariation('APPROVED', 'CANCELLED'), 'an approved variation is history')
})
