import test from 'node:test'
import assert from 'node:assert/strict'
import { computeEstimate, crewRateSummary, type EstimateInputs } from '../packages/backend-core/src/lib/quoteEstimate.ts'
import { computeJobEconomics } from '../packages/backend-core/src/lib/jobEconomics.ts'

const full: EstimateInputs = {
  labourHours: 400, labourRate: 50, onCostPct: 20,
  materialsCents: 1_500_000, subcontractCents: 500_000,
  overheadPct: 10, targetMarginPct: 25,
}

test('fully known estimate: labour with on-costs, direct cost, overheads, margins and price for target', () => {
  const e = computeEstimate(full, { priceCents: 6_000_000 })
  // 400 h × $50 × 1.2 = $24,000
  assert.equal(e.labourCostCents, 2_400_000)
  assert.equal(e.labourIncludesOnCosts, true)
  assert.equal(e.directCostCents, 4_400_000)
  assert.equal(e.knownDirectCostCents, 4_400_000)
  assert.equal(e.overheadCents, 440_000)
  assert.equal(e.totalCostCents, 4_840_000, 'break-even price')
  assert.equal(e.grossMarginCents, 1_600_000)
  assert.equal(e.grossMarginPct, 26.7)
  assert.equal(e.marginAfterOverheadsCents, 1_160_000)
  assert.equal(e.marginAfterOverheadsPct, 19.3)
  // 4,400,000 / 0.75 = 5,866,666.67 → rounded up so the target is met
  assert.equal(e.priceForTargetCents, 5_866_667)
  assert.equal(e.trackRecord, null)
  assert.deepEqual(e.gaps, [])
})

test('same definitions as the closeout: labour and gross margin match computeJobEconomics for the same figures', () => {
  const e = computeEstimate(full, { priceCents: 6_000_000 })
  const actual = computeJobEconomics({
    shifts: [{ crewMemberId: 'a', totalHours: 400, endTime: '2026-10-01T00:00:00Z' }],
    rates: new Map([['a', 50]]),
    quote: { amountCents: 6_000_000, estimatedHours: 400 },
    revenueCents: 6_000_000,
    otherCostCents: 2_000_000,
    onCostPct: 20,
  })
  assert.equal(e.labourCostCents, actual.labourCostCents)
  assert.equal(e.grossMarginCents, actual.grossMarginCents)
  assert.equal(e.grossMarginPct, actual.grossMarginPct)
})

test('unknown is never zero: a blank materials figure makes direct cost and every margin unknown', () => {
  const e = computeEstimate({ ...full, materialsCents: null }, { priceCents: 6_000_000 })
  assert.equal(e.materialsCents, null)
  assert.equal(e.directCostCents, null)
  assert.equal(e.knownDirectCostCents, 2_900_000, 'labour + subcontractors entered so far')
  assert.equal(e.overheadCents, null)
  assert.equal(e.totalCostCents, null)
  assert.equal(e.grossMarginCents, null)
  assert.equal(e.marginAfterOverheadsCents, null)
  assert.equal(e.priceForTargetCents, null)
  assert.ok(e.gaps.some(g => /Materials not entered/.test(g)))
})

test('an entered zero is a real zero, not unknown', () => {
  const e = computeEstimate({ ...full, materialsCents: 0, subcontractCents: 0, overheadPct: 0 }, { priceCents: 3_000_000 })
  assert.equal(e.directCostCents, 2_400_000)
  assert.equal(e.overheadCents, 0)
  assert.equal(e.grossMarginCents, 600_000)
  assert.equal(e.marginAfterOverheadsCents, 600_000)
  assert.deepEqual(e.gaps, [])
})

test('missing labour hours or rate makes labour unknown; missing on-cost is labelled base pay only', () => {
  assert.equal(computeEstimate({ ...full, labourHours: null }).labourCostCents, null)
  const noRate = computeEstimate({ ...full, labourRate: null })
  assert.equal(noRate.labourCostCents, null)
  assert.ok(noRate.gaps.some(g => /Labour rate not entered/.test(g)))
  const noOnCost = computeEstimate({ ...full, onCostPct: null }, { priceCents: 6_000_000 })
  assert.equal(noOnCost.labourCostCents, 2_000_000)
  assert.equal(noOnCost.labourIncludesOnCosts, false)
  assert.ok(noOnCost.gaps.some(g => /base pay only/.test(g)))
})

test('no price: costs and price for target still computed, margins unknown', () => {
  const e = computeEstimate(full)
  assert.equal(e.priceCents, null)
  assert.equal(e.grossMarginCents, null)
  assert.equal(e.priceForTargetCents, 5_866_667)
  assert.ok(e.gaps.some(g => /No quote price/.test(g)))
})

test('missing overhead % leaves gross margin known and margin after overheads unknown', () => {
  const e = computeEstimate({ ...full, overheadPct: null }, { priceCents: 6_000_000 })
  assert.equal(e.grossMarginCents, 1_600_000)
  assert.equal(e.marginAfterOverheadsCents, null)
  assert.equal(e.totalCostCents, null)
})

test('a loss is reported as a negative margin, never hidden', () => {
  const e = computeEstimate(full, { priceCents: 4_000_000 })
  assert.equal(e.grossMarginCents, -400_000)
  assert.equal(e.grossMarginPct, -10)
})

test('track record: labour hours scaled by the estimate check factor, other costs unchanged', () => {
  const e = computeEstimate(full, { priceCents: 6_000_000, hoursFactor: 1.11 })
  assert.ok(e.trackRecord)
  assert.equal(e.trackRecord!.adjustedHours, 444)
  assert.equal(e.trackRecord!.labourCostCents, 2_664_000)
  assert.equal(e.trackRecord!.directCostCents, 4_664_000)
  assert.equal(e.trackRecord!.grossMarginCents, 1_336_000)
  assert.equal(e.trackRecord!.grossMarginPct, 22.3)
  assert.equal(e.grossMarginCents, 1_600_000, 'the estimate as entered is unchanged')
  assert.equal(computeEstimate({ ...full, labourHours: null }, { hoursFactor: 1.11 }).trackRecord, null)
  assert.equal(computeEstimate(full, { hoursFactor: null }).trackRecord, null)
})

test('crew rates: median of rated active crew; unrated crew counted, never treated as $0', () => {
  assert.deepEqual(crewRateSummary([{ baseRate: 40 }, { baseRate: 60 }, { baseRate: null }, { baseRate: 50 }]), { activeCrew: 4, ratedCrew: 3, medianBaseRate: 50 })
  assert.deepEqual(crewRateSummary([{ baseRate: 40 }, { baseRate: 45 }]), { activeCrew: 2, ratedCrew: 2, medianBaseRate: 42.5 })
  assert.deepEqual(crewRateSummary([{ baseRate: null }]), { activeCrew: 1, ratedCrew: 0, medianBaseRate: null })
})
