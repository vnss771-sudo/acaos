// Unit tests for the discovery unit-economics cost model (pure, no DB).
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  discoveryProviderCostCents,
  estimateDiscoveryCost,
  DISCOVERY_PROVIDER_COST_CENTS,
  DEFAULT_DISCOVERY_COST_CENTS,
} from '../packages/backend-core/src/lib/discoveryCost.ts'

test('discoveryProviderCostCents returns the configured weight per provider', () => {
  assert.equal(discoveryProviderCostCents('apollo'), DISCOVERY_PROVIDER_COST_CENTS.apollo)
  assert.equal(discoveryProviderCostCents('google_places'), DISCOVERY_PROVIDER_COST_CENTS.google_places)
  assert.equal(discoveryProviderCostCents('hunter'), DISCOVERY_PROVIDER_COST_CENTS.hunter)
})

test('apollo is weighted as the most expensive provider', () => {
  assert.ok(DISCOVERY_PROVIDER_COST_CENTS.apollo > DISCOVERY_PROVIDER_COST_CENTS.google_places)
  assert.ok(DISCOVERY_PROVIDER_COST_CENTS.google_places > DISCOVERY_PROVIDER_COST_CENTS.hunter)
})

test('unknown / local sources fall back to the free default', () => {
  assert.equal(discoveryProviderCostCents('example'), DEFAULT_DISCOVERY_COST_CENTS)
  assert.equal(discoveryProviderCostCents('manual-import'), DEFAULT_DISCOVERY_COST_CENTS)
  assert.equal(DEFAULT_DISCOVERY_COST_CENTS, 0)
})

test('estimateDiscoveryCost sums weighted cost across providers', () => {
  const { totalCents, byProvider } = estimateDiscoveryCost([
    { source: 'apollo', count: 10 },
    { source: 'google_places', count: 4 },
  ])
  const expected = DISCOVERY_PROVIDER_COST_CENTS.apollo * 10 + DISCOVERY_PROVIDER_COST_CENTS.google_places * 4
  assert.equal(totalCents, expected)
  assert.deepEqual(byProvider.apollo, { runs: 10, costCents: DISCOVERY_PROVIDER_COST_CENTS.apollo * 10 })
  assert.deepEqual(byProvider.google_places, { runs: 4, costCents: DISCOVERY_PROVIDER_COST_CENTS.google_places * 4 })
})

test('estimateDiscoveryCost merges duplicate source rows', () => {
  const { totalCents, byProvider } = estimateDiscoveryCost([
    { source: 'apollo', count: 3 },
    { source: 'apollo', count: 2 },
  ])
  assert.equal(byProvider.apollo.runs, 5)
  assert.equal(totalCents, DISCOVERY_PROVIDER_COST_CENTS.apollo * 5)
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
  assert.equal(totalCents, DISCOVERY_PROVIDER_COST_CENTS.apollo)
})

test('empty history yields zero cost', () => {
  assert.deepEqual(estimateDiscoveryCost([]), { totalCents: 0, byProvider: {} })
})
