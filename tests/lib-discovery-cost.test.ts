// Unit tests for the discovery unit-economics cost model (pure, no DB).
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  discoveryProviderCostCents,
  estimateDiscoveryCost,
  DEFAULT_DISCOVERY_COST_CENTS,
} from '../packages/backend-core/src/lib/discoveryCost.ts'

// Hard-coded expected defaults so the tests verify the default values explicitly
// rather than circularly comparing the function to itself.
const DEFAULTS = { apollo: 5, google_places: 3, hunter: 2 }

test('discoveryProviderCostCents returns the default weight per provider', () => {
  assert.equal(discoveryProviderCostCents('apollo'), DEFAULTS.apollo)
  assert.equal(discoveryProviderCostCents('google_places'), DEFAULTS.google_places)
  assert.equal(discoveryProviderCostCents('hunter'), DEFAULTS.hunter)
})

test('apollo is weighted as the most expensive provider by default', () => {
  assert.ok(DEFAULTS.apollo > DEFAULTS.google_places)
  assert.ok(DEFAULTS.google_places > DEFAULTS.hunter)
})

test('unknown / local sources fall back to the free default', () => {
  assert.equal(discoveryProviderCostCents('example'), DEFAULT_DISCOVERY_COST_CENTS)
  assert.equal(discoveryProviderCostCents('manual-import'), DEFAULT_DISCOVERY_COST_CENTS)
  assert.equal(DEFAULT_DISCOVERY_COST_CENTS, 0)
})

test('env overrides change the per-provider cost', () => {
  const saved = process.env.DISCOVERY_COST_APOLLO_CENTS
  try {
    process.env.DISCOVERY_COST_APOLLO_CENTS = '10'
    assert.equal(discoveryProviderCostCents('apollo'), 10)
  } finally {
    if (saved === undefined) delete process.env.DISCOVERY_COST_APOLLO_CENTS
    else process.env.DISCOVERY_COST_APOLLO_CENTS = saved
  }
})

test('estimateDiscoveryCost sums weighted cost across providers', () => {
  const { totalCents, byProvider } = estimateDiscoveryCost([
    { source: 'apollo', count: 10 },
    { source: 'google_places', count: 4 },
  ])
  const expected = DEFAULTS.apollo * 10 + DEFAULTS.google_places * 4
  assert.equal(totalCents, expected)
  assert.deepEqual(byProvider.apollo, { runs: 10, costCents: DEFAULTS.apollo * 10 })
  assert.deepEqual(byProvider.google_places, { runs: 4, costCents: DEFAULTS.google_places * 4 })
})

test('estimateDiscoveryCost merges duplicate source rows', () => {
  const { totalCents, byProvider } = estimateDiscoveryCost([
    { source: 'apollo', count: 3 },
    { source: 'apollo', count: 2 },
  ])
  assert.equal(byProvider.apollo.runs, 5)
  assert.equal(totalCents, DEFAULTS.apollo * 5)
})

test('estimateDiscoveryCost ignores zero, negative, and non-finite counts', () => {
  const { totalCents, byProvider } = estimateDiscoveryCost([
    { source: 'apollo', count: 0 },
    { source: 'google_places', count: -5 },
    { source: 'hunter', count: Number.NaN },
  ])
  assert.equal(totalCents, 0)
  assert.deepEqual(byProvider, {})
})

test('an unpriced provider contributes runs but no cost', () => {
  const { totalCents, byProvider } = estimateDiscoveryCost([
    { source: 'example', count: 7 },
    { source: 'apollo', count: 1 },
  ])
  assert.equal(byProvider.example.runs, 7)
  assert.equal(byProvider.example.costCents, 0)
  assert.equal(totalCents, DEFAULTS.apollo)
})

test('empty history yields zero cost', () => {
  assert.deepEqual(estimateDiscoveryCost([]), { totalCents: 0, byProvider: {} })
})
