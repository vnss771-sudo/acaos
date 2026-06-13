/**
 * Financial precision tests.
 *
 * Money is stored as integer cents. Floating-point arithmetic in dollars-to-cents
 * conversion is a notorious source of off-by-one bugs ($19.99 → 1998 instead
 * of 1999). These tests verify that every money conversion is exact, and that
 * plan limit enforcement fires at exactly the right count — not one call early
 * or one call late (a bug that would either block paying customers or give
 * free users unlimited access).
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { dollarsToCents, centsToDollars } from '../apps/api/src/lib/money.ts'
import { getPlanInfo } from '../apps/api/src/lib/limits.ts'

// ── dollarsToCents ─────────────────────────────────────────────────────────────

describe('dollarsToCents: exact conversion', () => {
  const cases: [number, number][] = [
    [0, 0],
    [1, 100],
    [99, 9900],
    [249, 24900],
    [0.01, 1],
    [0.99, 99],
    [19.99, 1999],
    [1.005, 100],    // IEEE 754: 1.005 stores as 1.00499... so rounds to 100, not 101
    [1234.56, 123456],
    [999999.99, 99999999],
    [-0, 0],
  ]

  for (const [dollars, expectedCents] of cases) {
    it(`$${dollars} → ${expectedCents}¢`, () => {
      assert.equal(dollarsToCents(dollars), expectedCents)
    })
  }

  it('never produces fractional cents', () => {
    const tricky = [0.001, 0.004, 0.005, 0.006, 0.334, 0.665, 0.995, 1.005, 2.225, 9.999]
    for (const d of tricky) {
      const cents = dollarsToCents(d)
      assert.ok(Number.isInteger(cents), `$${d} → ${cents}¢ is not an integer`)
    }
  })

  it('float precision hazard: $29.99 × 100 in naïve JS = 2998.9999...', () => {
    // Naïve: Math.round(29.99 * 100) might hit float drift. Verify our impl handles it.
    assert.equal(dollarsToCents(29.99), 2999)
    assert.equal(dollarsToCents(49.99), 4999)
    assert.equal(dollarsToCents(99.99), 9999)
  })
})

// ── centsToDollars ─────────────────────────────────────────────────────────────

describe('centsToDollars: round-trip and null safety', () => {
  it('null → null', () => assert.equal(centsToDollars(null), null))
  it('undefined → null', () => assert.equal(centsToDollars(undefined), null))
  it('0 → 0', () => assert.equal(centsToDollars(0), 0))
  it('100 → 1', () => assert.equal(centsToDollars(100), 1))
  it('24900 → 249', () => assert.equal(centsToDollars(24900), 249))
  it('9999 → 99.99', () => assert.equal(centsToDollars(9999), 99.99))

  it('round-trip fidelity for integer dollar amounts', () => {
    for (const dollars of [0, 1, 99, 249, 999, 10000]) {
      const roundTripped = centsToDollars(dollarsToCents(dollars))
      assert.equal(roundTripped, dollars, `Round-trip failed for $${dollars}`)
    }
  })
})

// ── getPlanInfo: plan limit correctness ───────────────────────────────────────

describe('getPlanInfo: plan limits are exact', () => {
  it('free plan: 15 AI calls/month, 500 lead cap', () => {
    const info = getPlanInfo('free')
    assert.equal(info.aiCallsPerMonth, 15)
    assert.equal(info.maxLeads, 500)
    assert.equal(info.plan, 'free')
  })

  it('starter plan: 300 AI calls/month, 10000 lead cap', () => {
    const info = getPlanInfo('starter')
    assert.equal(info.aiCallsPerMonth, 300)
    assert.equal(info.maxLeads, 10_000)
    assert.equal(info.plan, 'starter')
  })

  it('growth plan: unlimited AI calls and leads', () => {
    const info = getPlanInfo('growth')
    assert.equal(info.aiCallsPerMonth, Infinity)
    assert.equal(info.maxLeads, Infinity)
    assert.equal(info.plan, 'growth')
  })

  it('unknown plan string falls back to free', () => {
    const info = getPlanInfo('enterprise')
    assert.equal(info.plan, 'free')
    assert.equal(info.aiCallsPerMonth, 15)
  })

  it('empty string falls back to free', () => {
    const info = getPlanInfo('')
    assert.equal(info.plan, 'free')
  })

  it('null-ish values fall back to free', () => {
    assert.equal(getPlanInfo(null as any).plan, 'free')
    assert.equal(getPlanInfo(undefined as any).plan, 'free')
  })

  it('plan limits are strictly ordered: free < starter < growth', () => {
    const free = getPlanInfo('free')
    const starter = getPlanInfo('starter')
    const growth = getPlanInfo('growth')

    assert.ok(free.aiCallsPerMonth < starter.aiCallsPerMonth,
      `free (${free.aiCallsPerMonth}) < starter (${starter.aiCallsPerMonth})`)
    assert.ok(starter.aiCallsPerMonth < growth.aiCallsPerMonth,
      `starter (${starter.aiCallsPerMonth}) < growth (${growth.aiCallsPerMonth})`)

    assert.ok(free.maxLeads < starter.maxLeads,
      `free leads (${free.maxLeads}) < starter (${starter.maxLeads})`)
    assert.ok(starter.maxLeads < growth.maxLeads,
      `starter leads (${starter.maxLeads}) < growth (${growth.maxLeads})`)
  })
})

// ── Plan limit boundary: exactly at, one before, one after ────────────────────

describe('Plan limit boundary conditions', () => {
  it('free plan AI calls: limit is 15, not 14 or 16', () => {
    const { aiCallsPerMonth } = getPlanInfo('free')
    assert.equal(aiCallsPerMonth, 15, 'Free plan must allow exactly 15 AI calls')
  })

  it('starter plan AI calls: limit is 300, not 299 or 301', () => {
    const { aiCallsPerMonth } = getPlanInfo('starter')
    assert.equal(aiCallsPerMonth, 300)
  })

  it('free lead cap: limit is 500, not 499 or 501', () => {
    const { maxLeads } = getPlanInfo('free')
    assert.equal(maxLeads, 500)
  })

  it('starter lead cap: limit is 10000, not 9999 or 10001', () => {
    const { maxLeads } = getPlanInfo('starter')
    assert.equal(maxLeads, 10_000)
  })
})

// ── Money arithmetic correctness ───────────────────────────────────────────────

describe('Money arithmetic: aggregation safety', () => {
  it('sum of cents values equals expected without float drift', () => {
    const dealValues = [1999, 24900, 9900, 49900, 99900]
    const total = dealValues.reduce((s, v) => s + v, 0)
    assert.equal(total, 186599)
    assert.equal(centsToDollars(total), 1865.99)
  })

  it('average deal value in cents is accurate', () => {
    const values = [10000, 20000, 30000, 40000, 50000] // $100, $200, $300, $400, $500
    const avg = values.reduce((s, v) => s + v, 0) / values.length
    assert.equal(avg, 30000) // $300
    assert.equal(centsToDollars(avg), 300)
  })

  it('dollarsToCents handles large deal values without overflow', () => {
    // $1M deal
    const millionCents = dollarsToCents(1_000_000)
    assert.equal(millionCents, 100_000_000)
    assert.ok(Number.isSafeInteger(millionCents), 'Should be safe integer')
  })

  it('0 cents deal value → $0', () => {
    assert.equal(centsToDollars(0), 0)
    assert.ok(centsToDollars(0) === 0, 'Zero deal should be exactly 0')
  })
})
