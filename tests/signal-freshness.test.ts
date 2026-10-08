// Tests for the user-facing signal freshness state, derived from the same
// per-type exponential decay the scoring engine uses.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { freshnessState } from '../packages/backend-core/src/lib/signalEngine.ts'

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

// ── Event time (publishedAt) vs observation time (detectedAt) ───────────────
import { signalEventAt, toRawSignal } from '../packages/backend-core/src/lib/signalEngine.ts'

const row = (over: { detectedAt?: Date; publishedAt?: Date | null } = {}) => ({
  type: 'HIRING' as const, strength: 80, sourceReliability: 80, industryRelevance: 80,
  detectedAt: new Date(), publishedAt: null, ...over,
})

test('an old event discovered today is scored by its publication time', () => {
  const old = daysAgo(400)
  const raw = toRawSignal(row({ publishedAt: old }))
  assert.equal(raw.detectedAt.getTime(), old.getTime())
  assert.equal(freshnessState(raw), 'EXPIRED')
})

test('without publishedAt, freshness falls back to observation time', () => {
  const seen = new Date()
  assert.equal(signalEventAt({ detectedAt: seen, publishedAt: null }), seen)
  assert.equal(freshnessState(toRawSignal(row({ detectedAt: seen }))), 'LIVE')
})

test('a future publishedAt cannot make a signal fresher than when it was observed', () => {
  const seen = daysAgo(200)
  const future = new Date(Date.now() + 30 * 86_400_000)
  assert.equal(signalEventAt({ detectedAt: seen, publishedAt: future }), seen)
})

test('a publishedAt well after observation is ignored, small clock skew is tolerated', () => {
  const seen = daysAgo(100)
  assert.equal(signalEventAt({ detectedAt: seen, publishedAt: daysAgo(50) }), seen)
  const skewed = new Date(seen.getTime() + 60 * 60 * 1000)
  assert.equal(signalEventAt({ detectedAt: seen, publishedAt: skewed }), skewed)
})
