// Tests for the user-facing signal freshness state, derived from the same
// per-type exponential decay the scoring engine uses.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { freshnessState } from '../apps/api/src/lib/signalEngine.ts'

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000)

test('a just-observed signal is LIVE', () => {
  assert.equal(freshnessState({ type: 'HIRING', detectedAt: new Date() }), 'LIVE')
})

test('freshness degrades over time through RECENT, STALE, then EXPIRED', () => {
  // HIRING decay rate 0.012: remaining = e^(-0.012*age)
  // LIVE >=0.85 (~<13d), RECENT >=0.5 (~<58d), STALE >=0.2 (~<134d), else EXPIRED
  assert.equal(freshnessState({ type: 'HIRING', detectedAt: daysAgo(5) }), 'LIVE')
  assert.equal(freshnessState({ type: 'HIRING', detectedAt: daysAgo(40) }), 'RECENT')
  assert.equal(freshnessState({ type: 'HIRING', detectedAt: daysAgo(100) }), 'STALE')
  assert.equal(freshnessState({ type: 'HIRING', detectedAt: daysAgo(300) }), 'EXPIRED')
})

test('fast-decaying signals go stale sooner than slow-decaying ones at the same age', () => {
  const at = daysAgo(45)
  // WEBSITE_CHANGE rate 0.025 decays much faster than PROCUREMENT 0.007
  const fast = freshnessState({ type: 'WEBSITE_CHANGE', detectedAt: at })
  const slow = freshnessState({ type: 'PROCUREMENT', detectedAt: at })
  const order = ['EXPIRED', 'STALE', 'RECENT', 'LIVE']
  assert.ok(order.indexOf(fast) <= order.indexOf(slow), `${fast} should be no fresher than ${slow}`)
})

test('a future detectedAt is clamped to age 0 (LIVE, never throws)', () => {
  assert.equal(freshnessState({ type: 'FUNDING', detectedAt: daysAgo(-10) }), 'LIVE')
})
