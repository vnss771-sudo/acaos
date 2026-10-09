import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceHealthSnapshot, type SourceStateCounters } from '../packages/backend-core/src/lib/sourceHealth.ts'

const NOW = new Date('2026-10-08T12:00:00Z')
const HOUR = 3_600_000
const INTERVAL = 6 * HOUR
const ago = (h: number) => new Date(NOW.getTime() - h * HOUR)

function state(over: Partial<SourceStateCounters> = {}): SourceStateCounters {
  return {
    lastRunAt: ago(1), lastSuccessAt: ago(1), lastError: null, lastWarning: null,
    runCount: 10, successCount: 10, failureCount: 0, skippedCount: 0, warningCount: 0,
    fetchedTotal: 200, matchedTotal: 50, createdTotal: 30, updatedTotal: 5,
    lastLatencyMs: 900, latencyTotalMs: 10_000,
    ...over,
  }
}
const snap = (s: SourceStateCounters | null, yieldStats = null as Parameters<typeof sourceHealthSnapshot>[1]['yieldStats']) =>
  sourceHealthSnapshot(s, { now: NOW, intervalMs: INTERVAL, yieldStats })

test('a recently successful source is healthy, with transport and data rates', () => {
  const h = snap(state())
  assert.equal(h.status, 'HEALTHY')
  assert.equal(h.transport.successRate, 1)
  assert.equal(h.transport.avgLatencyMs, 1000)
  assert.equal(h.transport.hoursSinceSuccess, 1)
  assert.equal(h.data.matchRate, 0.25)
  assert.equal(h.data.unchangedRate, 0.3) // 50 matched − 30 created − 5 updated = 15 re-deliveries
})

test('no successful read for three intervals is stale', () => {
  const h = snap(state({ lastRunAt: ago(1), lastSuccessAt: ago(19) }))
  assert.equal(h.status, 'STALE')
  assert.match(h.summary, /19 h/)
})

test('a failure after the last success is failing; an old failure followed by success is not', () => {
  assert.equal(snap(state({ lastRunAt: ago(1), lastSuccessAt: ago(7), lastError: 'HTTP 500', failureCount: 1, successCount: 9 })).status, 'FAILING')
  assert.equal(snap(state({ lastError: 'HTTP 500', lastRunAt: ago(1), lastSuccessAt: ago(1) })).status, 'HEALTHY')
})

test('a low success rate or a current warning is degraded', () => {
  assert.equal(snap(state({ successCount: 7, failureCount: 3 })).status, 'DEGRADED')
  const warned = snap(state({ lastWarning: 'Feed returned an unexpected shape', warningCount: 2 }))
  assert.equal(warned.status, 'DEGRADED')
  assert.equal(warned.data.warningRate, 0.2)
})

test('a source that has only been skipped is reported as not running', () => {
  const h = snap(state({ runCount: 3, successCount: 0, failureCount: 0, skippedCount: 3, lastSuccessAt: null, lastWarning: 'Not configured on this server' }))
  assert.equal(h.status, 'SKIPPED')
  assert.equal(h.transport.successRate, null)
})

test('a legacy row with no counters, or no row, does not fabricate health', () => {
  for (const s of [null, state({ runCount: 0, successCount: 0, fetchedTotal: 0, matchedTotal: 0, createdTotal: 0, updatedTotal: 0, latencyTotalMs: 0, lastLatencyMs: null })]) {
    const h = snap(s)
    assert.equal(h.status, 'UNKNOWN')
    assert.equal(h.transport.avgLatencyMs, null)
  }
})

test('business yield rates come from what the source opportunities became', () => {
  const h = snap(state(), { opportunities: 20, dismissed: 5, actioned: 8, won: 3, lost: 1, jobsCreated: 2 })
  assert.equal(h.yield.dismissalRate, 0.25)
  assert.equal(h.yield.actionRate, 0.4)
  assert.equal(h.yield.winRate, 0.75)
  assert.equal(h.yield.resolvedOutcomes, 4)
  assert.equal(snap(state()).yield.winRate, null)
})
