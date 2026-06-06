/**
 * Tests for the funnel and metrics computation logic in routes/stats.ts.
 * The logic is extracted here as pure functions matching the route implementation.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

// Pure replicas of the stats computation logic (mirrored from routes/stats.ts)
const STAGES = ['NEW', 'RESEARCHED', 'OUTREACH_SENT', 'REPLIED', 'BOOKED', 'CLOSED', 'DEAD']

function buildFunnel(stageCounts: Array<{ stage: string; _count: { _all: number } }>) {
  const funnel: Record<string, number> = {}
  for (const stage of STAGES) funnel[stage] = 0
  for (const row of stageCounts) funnel[row.stage] = row._count._all
  return funnel
}

function computeMetrics(funnel: Record<string, number>) {
  const contacted =
    (funnel['OUTREACH_SENT'] ?? 0) +
    (funnel['REPLIED'] ?? 0) +
    (funnel['BOOKED'] ?? 0) +
    (funnel['CLOSED'] ?? 0)
  const replied =
    (funnel['REPLIED'] ?? 0) + (funnel['BOOKED'] ?? 0) + (funnel['CLOSED'] ?? 0)
  const booked = (funnel['BOOKED'] ?? 0) + (funnel['CLOSED'] ?? 0)

  const replyRate   = contacted > 0 ? Math.round((replied / contacted) * 100) : 0
  const bookingRate = replied   > 0 ? Math.round((booked  / replied)   * 100) : 0
  const closeRate   = booked    > 0 ? Math.round((funnel['CLOSED']! / booked) * 100) : 0

  return { replyRate, bookingRate, closeRate, contacted, replied, booked, closed: funnel['CLOSED'] ?? 0 }
}

// ---------------------------------------------------------------------------
// buildFunnel
// ---------------------------------------------------------------------------
test('funnel: all stages initialized to 0 when no data', () => {
  const funnel = buildFunnel([])
  for (const stage of STAGES) {
    assert.equal(funnel[stage], 0, `${stage} should default to 0`)
  }
})

test('funnel: all defined stages are present in output', () => {
  const funnel = buildFunnel([])
  for (const stage of STAGES) {
    assert.ok(stage in funnel, `${stage} should be a key in funnel`)
  }
})

test('funnel: populates stage counts from input rows', () => {
  const funnel = buildFunnel([
    { stage: 'NEW', _count: { _all: 10 } },
    { stage: 'REPLIED', _count: { _all: 5 } }
  ])
  assert.equal(funnel['NEW'], 10)
  assert.equal(funnel['REPLIED'], 5)
  assert.equal(funnel['RESEARCHED'], 0)
})

test('funnel: unknown stage from DB does not corrupt known stages', () => {
  const funnel = buildFunnel([
    { stage: 'UNKNOWN_FUTURE_STAGE', _count: { _all: 99 } },
    { stage: 'NEW', _count: { _all: 7 } }
  ])
  assert.equal(funnel['NEW'], 7)
  assert.equal(funnel['UNKNOWN_FUTURE_STAGE'], 99) // stored but not in STAGES list
})

test('funnel: later row for same stage overwrites earlier (last wins)', () => {
  const funnel = buildFunnel([
    { stage: 'NEW', _count: { _all: 5 } },
    { stage: 'NEW', _count: { _all: 10 } }
  ])
  assert.equal(funnel['NEW'], 10)
})

test('funnel: all stages fully populated', () => {
  const input = STAGES.map((stage, i) => ({ stage, _count: { _all: (i + 1) * 10 } }))
  const funnel = buildFunnel(input)
  assert.equal(funnel['NEW'], 10)
  assert.equal(funnel['DEAD'], STAGES.length * 10)
})

// ---------------------------------------------------------------------------
// computeMetrics — zero-division safety
// ---------------------------------------------------------------------------
test('metrics: all rates are 0 when funnel is empty', () => {
  const m = computeMetrics(buildFunnel([]))
  assert.equal(m.replyRate, 0)
  assert.equal(m.bookingRate, 0)
  assert.equal(m.closeRate, 0)
  assert.equal(m.contacted, 0)
  assert.equal(m.replied, 0)
  assert.equal(m.booked, 0)
  assert.equal(m.closed, 0)
})

test('metrics: replyRate is 0 when no one was contacted', () => {
  const funnel = buildFunnel([{ stage: 'NEW', _count: { _all: 50 } }])
  const m = computeMetrics(funnel)
  assert.equal(m.replyRate, 0)
  assert.equal(m.contacted, 0)
})

test('metrics: bookingRate is 0 when no replies', () => {
  const funnel = buildFunnel([{ stage: 'OUTREACH_SENT', _count: { _all: 20 } }])
  const m = computeMetrics(funnel)
  assert.equal(m.bookingRate, 0)
  assert.equal(m.replied, 0)
})

test('metrics: closeRate is 0 when no bookings', () => {
  const funnel = buildFunnel([{ stage: 'REPLIED', _count: { _all: 10 } }])
  const m = computeMetrics(funnel)
  assert.equal(m.closeRate, 0)
})

// ---------------------------------------------------------------------------
// computeMetrics — correct calculations
// ---------------------------------------------------------------------------
test('metrics: contacted counts OUTREACH_SENT + REPLIED + BOOKED + CLOSED', () => {
  const funnel = buildFunnel([
    { stage: 'OUTREACH_SENT', _count: { _all: 10 } },
    { stage: 'REPLIED', _count: { _all: 4 } },
    { stage: 'BOOKED', _count: { _all: 2 } },
    { stage: 'CLOSED', _count: { _all: 1 } }
  ])
  assert.equal(computeMetrics(funnel).contacted, 17)
})

test('metrics: replied counts REPLIED + BOOKED + CLOSED (not OUTREACH_SENT)', () => {
  const funnel = buildFunnel([
    { stage: 'OUTREACH_SENT', _count: { _all: 10 } },
    { stage: 'REPLIED', _count: { _all: 4 } },
    { stage: 'BOOKED', _count: { _all: 2 } },
    { stage: 'CLOSED', _count: { _all: 1 } }
  ])
  assert.equal(computeMetrics(funnel).replied, 7)
})

test('metrics: replyRate rounds to nearest integer', () => {
  // 7 replied / 17 contacted = 41.17...% → rounds to 41
  const funnel = buildFunnel([
    { stage: 'OUTREACH_SENT', _count: { _all: 10 } },
    { stage: 'REPLIED', _count: { _all: 4 } },
    { stage: 'BOOKED', _count: { _all: 2 } },
    { stage: 'CLOSED', _count: { _all: 1 } }
  ])
  assert.equal(computeMetrics(funnel).replyRate, 41)
})

test('metrics: 100% replyRate when all contacted replied', () => {
  const funnel = buildFunnel([{ stage: 'REPLIED', _count: { _all: 10 } }])
  assert.equal(computeMetrics(funnel).replyRate, 100)
})

test('metrics: closeRate 100% when all booked closed', () => {
  const funnel = buildFunnel([{ stage: 'CLOSED', _count: { _all: 5 } }])
  const m = computeMetrics(funnel)
  assert.equal(m.closeRate, 100)
  assert.equal(m.closed, 5)
})

test('metrics: full pipeline scenario', () => {
  const funnel = buildFunnel([
    { stage: 'NEW', _count: { _all: 100 } },
    { stage: 'OUTREACH_SENT', _count: { _all: 50 } },
    { stage: 'REPLIED', _count: { _all: 20 } },
    { stage: 'BOOKED', _count: { _all: 10 } },
    { stage: 'CLOSED', _count: { _all: 5 } }
  ])
  const m = computeMetrics(funnel)
  assert.equal(m.contacted, 85)        // 50+20+10+5
  assert.equal(m.replied, 35)          // 20+10+5
  assert.equal(m.booked, 15)           // 10+5
  assert.equal(m.closed, 5)
  assert.equal(m.replyRate, 41)        // 35/85 = 41.17% → 41
  assert.equal(m.bookingRate, 43)      // 15/35 = 42.85% → 43
  assert.equal(m.closeRate, 33)        // 5/15 = 33.33% → 33
})

test('metrics: DEAD stage does not affect any metric', () => {
  const withDead = buildFunnel([
    { stage: 'OUTREACH_SENT', _count: { _all: 10 } },
    { stage: 'DEAD', _count: { _all: 1000 } }
  ])
  const withoutDead = buildFunnel([{ stage: 'OUTREACH_SENT', _count: { _all: 10 } }])
  const m1 = computeMetrics(withDead)
  const m2 = computeMetrics(withoutDead)
  assert.equal(m1.contacted, m2.contacted)
  assert.equal(m1.replyRate, m2.replyRate)
})
