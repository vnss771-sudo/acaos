import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  poolBenchmarks, networkMinClosed, networkMinContributors, MIN_CLOSED, MIN_CONTRIBUTORS, countBand, publicRate, toPublicBenchmark,
  type WorkspaceKindCounts,
  computeNetworkBenchmarks, loadNetworkBenchmarks, loadNetworkParticipation, setNetworkParticipation, NetworkAccessError,
} from '../packages/backend-core/src/lib/networkIntelligence.ts'
import { createFakePrisma, installPrisma, resetPrisma } from './helpers/integration.ts'

const env = { ...process.env }
afterEach(() => { process.env = { ...env } })

const ws = (closed: number, won: number, eventType = 'TENDER_OPPORTUNITY'): WorkspaceKindCounts[] =>
  [{ eventType, opportunities: closed + 2, conversations: Math.ceil(closed / 2), closed, won }]

const atFloor = () => Array.from({ length: 10 }, () => ws(5, 2))

test('pools a kind only at or above both floors (10 workspaces, 50 closed)', () => {
  const rows = poolBenchmarks(atFloor())
  assert.deepEqual(rows, [{
    eventType: 'TENDER_OPPORTUNITY', contributors: 10, opportunities: 70, conversations: 30, closed: 50, won: 20,
    winRate: 0.4, conversationRate: 0.429,
  }])
  assert.deepEqual(poolBenchmarks(atFloor().slice(0, 9)), [], 'nine workspaces is below the floor')
  assert.deepEqual(poolBenchmarks([ws(4, 2), ...atFloor().slice(1)]), [], '49 closed is below the floor')
})

test('a workspace with no closed outcome of a kind does not count as a contributor', () => {
  const rows = poolBenchmarks([...Array.from({ length: 9 }, () => ws(10, 3)), ws(0, 0)])
  assert.deepEqual(rows, [])
  // Kinds are judged independently; output carries no workspace identity or order.
  const mixed = [...Array.from({ length: 10 }, () => [...ws(5, 3), ...ws(1, 1, 'HIRING_SURGE')])]
  const out = poolBenchmarks(mixed)
  assert.deepEqual(out.map(r => r.eventType), ['TENDER_OPPORTUNITY'])
  assert.deepEqual(Object.keys(out[0]).sort(), ['closed', 'contributors', 'conversationRate', 'conversations', 'eventType', 'opportunities', 'winRate', 'won'])
  assert.deepEqual(poolBenchmarks([...mixed].reverse()), out)
})

test('floors can be raised, never lowered', () => {
  assert.deepEqual(poolBenchmarks(atFloor(), { minContributors: 2, minClosed: 1 }).length, 1, 'lower values are ignored')
  // Three big workspaces would pass a lowered floor — they must still be withheld.
  assert.deepEqual(poolBenchmarks([ws(30, 5), ws(30, 5), ws(30, 5)], { minContributors: 2 }), [])
  assert.deepEqual(poolBenchmarks(Array.from({ length: 10 }, () => ws(2, 1)), { minClosed: 5 }), [])
  assert.deepEqual(poolBenchmarks(atFloor(), { minContributors: 11 }), [])
  assert.deepEqual(poolBenchmarks(atFloor(), { minClosed: 51 }), [])

  delete process.env.NETWORK_MIN_CONTRIBUTORS
  delete process.env.NETWORK_MIN_CLOSED
  assert.deepEqual([networkMinContributors(), networkMinClosed()], [MIN_CONTRIBUTORS, MIN_CLOSED])
  process.env.NETWORK_MIN_CONTRIBUTORS = '8'
  process.env.NETWORK_MIN_CLOSED = 'x'
  assert.deepEqual([networkMinContributors(), networkMinClosed()], [MIN_CONTRIBUTORS, MIN_CLOSED])
  process.env.NETWORK_MIN_CONTRIBUTORS = '12'
  process.env.NETWORK_MIN_CLOSED = '60'
  assert.deepEqual([networkMinContributors(), networkMinClosed()], [12, 60])
})

// ── customer-facing sanitisation (UQ-30) ───────────────────────────────────────

test('counts are published as bands only', () => {
  assert.deepEqual([3, 10, 24, 25, 49, 50, 99, 100, 999, 1000, 50_000].map(countBand),
    ['<10', '10–24', '10–24', '25–49', '25–49', '50–99', '50–99', '100–249', '500–999', '1000+', '1000+'])
})

test('rates are rounded to 5 points and suppressed when either side is rare', () => {
  assert.equal(publicRate(20, 60), 0.35)
  assert.equal(publicRate(30, 60), 0.5)
  assert.equal(publicRate(4, 60), null, 'too few hits')
  assert.equal(publicRate(56, 60), null, 'too few misses')
  assert.equal(publicRate(5, 10), 0.5, 'exactly MIN_RATE_SIDE on both sides publishes')
})

test('a public row carries bands and coarse rates, never exact pooled counts', () => {
  const pub = toPublicBenchmark({ eventType: 'NEW_PROJECT', contributors: 13, opportunities: 211, conversations: 37, closed: 77, won: 19 })
  assert.deepEqual(pub, {
    eventType: 'NEW_PROJECT', contributors: '10–24', opportunities: '100–249', closed: '50–99', winRate: 0.25, conversationRate: 0.2,
  })
  assert.equal('won' in pub || 'conversations' in pub, false)
})

// ── DB-bound paths, against the fake Prisma client ─────────────────────────────

afterEach(() => resetPrisma())

function fake(workspace: { networkOptInAt: Date | null } | null, extra: Record<string, unknown> = {}) {
  const f = createFakePrisma({
    workspace: { findUnique: async () => workspace, update: async () => ({}), findMany: async () => [] },
    networkBenchmark: {
      findMany: async () => [{ eventType: 'NEW_PROJECT', contributors: 12, opportunities: 80, conversations: 20, closed: 60, won: 15, winRate: 0.25, conversationRate: 0.25, computedAt: new Date('2026-10-01T00:00:00Z') }],
      deleteMany: async () => ({ count: 0 }), createMany: async () => ({ count: 0 }),
    },
    commercialOpportunity: { findMany: async () => [] },
    ...extra,
  } as never)
  ;(f as unknown as { $transaction: (fn: (tx: unknown) => unknown) => unknown }).$transaction = (fn) => fn(f)
  installPrisma(f)
  return f
}

test('participation: 404 for an unknown workspace; opt-in stamps once; opt-out clears', async () => {
  fake(null)
  await assert.rejects(setNetworkParticipation('w1', true), (e: unknown) => e instanceof NetworkAccessError && e.status === 404)

  const now = new Date('2026-10-02T00:00:00Z')
  let f = fake({ networkOptInAt: null })
  assert.deepEqual(await setNetworkParticipation('w1', true, now), { optedInAt: now.toISOString() })
  assert.equal(f.callsTo('workspace', 'update').length, 1)

  const earlier = new Date('2026-09-01T00:00:00Z')
  f = fake({ networkOptInAt: earlier })
  assert.deepEqual(await setNetworkParticipation('w1', true, now), { optedInAt: earlier.toISOString() })
  assert.equal(f.callsTo('workspace', 'update').length, 0, 'staying in writes nothing')
  assert.deepEqual(await setNetworkParticipation('w1', false, now), { optedInAt: null })
  assert.equal(f.callsTo('workspace', 'update').length, 1)
})

test('participation status: 404 unknown, null when not opted in, the opt-in time otherwise', async () => {
  fake(null)
  await assert.rejects(loadNetworkParticipation('w1'), (e: unknown) => e instanceof NetworkAccessError && e.status === 404)
  fake({ networkOptInAt: null })
  assert.deepEqual(await loadNetworkParticipation('w1'), { optedInAt: null })
  fake({ networkOptInAt: new Date('2026-09-01T00:00:00Z') })
  assert.deepEqual(await loadNetworkParticipation('w1'), { optedInAt: '2026-09-01T00:00:00.000Z' })
})

test('reading: 404 unknown, 403 not opted in, otherwise the pool beside your own figures', async () => {
  fake(null)
  await assert.rejects(loadNetworkBenchmarks('w1'), (e: unknown) => e instanceof NetworkAccessError && e.status === 404)
  fake({ networkOptInAt: null })
  await assert.rejects(loadNetworkBenchmarks('w1'), (e: unknown) => e instanceof NetworkAccessError && e.status === 403)
  fake({ networkOptInAt: new Date('2026-09-01T00:00:00Z') })
  const r = await loadNetworkBenchmarks('w1')
  assert.equal(r.optedInAt, '2026-09-01T00:00:00.000Z')
  assert.deepEqual(r.benchmarks, [{
    eventType: 'NEW_PROJECT', contributors: '10–24', opportunities: '50–99', closed: '50–99', winRate: 0.25, conversationRate: 0.25,
    computedAt: '2026-10-01T00:00:00.000Z', yours: null,
  }], 'exact pooled counts never leave the server')
})

test('recompute with no opted-in workspace clears the table and publishes nothing', async () => {
  const f = fake(null)
  assert.deepEqual(await computeNetworkBenchmarks(), { workspaces: 0, published: 0, withheld: 0 })
  assert.equal(f.callsTo('networkBenchmark', 'deleteMany').length, 1)
  assert.equal(f.callsTo('networkBenchmark', 'createMany').length, 0)
})
