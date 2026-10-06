import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  poolBenchmarks, networkMinClosed, networkMinContributors, MIN_CLOSED, MIN_CONTRIBUTORS,
  type WorkspaceKindCounts,
  computeNetworkBenchmarks, loadNetworkBenchmarks, loadNetworkParticipation, setNetworkParticipation, NetworkAccessError,
} from '../packages/backend-core/src/lib/networkIntelligence.ts'
import { createFakePrisma, installPrisma, resetPrisma } from './helpers/integration.ts'

const env = { ...process.env }
afterEach(() => { process.env = { ...env } })

const ws = (closed: number, won: number, eventType = 'TENDER_OPPORTUNITY'): WorkspaceKindCounts[] =>
  [{ eventType, opportunities: closed + 2, conversations: Math.ceil(closed / 2), closed, won }]

test('pools a kind only at or above both floors (5 workspaces, 30 closed)', () => {
  const five = [ws(6, 2), ws(6, 3), ws(6, 1), ws(6, 2), ws(6, 2)]
  const rows = poolBenchmarks(five)
  assert.deepEqual(rows, [{
    eventType: 'TENDER_OPPORTUNITY', contributors: 5, opportunities: 40, conversations: 15, closed: 30, won: 10,
    winRate: 0.333, conversationRate: 0.375,
  }])
  assert.deepEqual(poolBenchmarks(five.slice(0, 4)), [], 'four workspaces is below the floor')
  assert.deepEqual(poolBenchmarks([ws(5, 2), ws(6, 3), ws(6, 1), ws(6, 2), ws(6, 2)]), [], '29 closed is below the floor')
})

test('a workspace with no closed outcome of a kind does not count as a contributor', () => {
  const rows = poolBenchmarks([ws(10, 3), ws(10, 3), ws(10, 3), ws(10, 3), ws(0, 0)])
  assert.deepEqual(rows, [])
  // Kinds are judged independently; output carries no workspace identity or order.
  const mixed = [...Array.from({ length: 5 }, () => [...ws(6, 3), ...ws(1, 1, 'HIRING_SURGE')])]
  const out = poolBenchmarks(mixed)
  assert.deepEqual(out.map(r => r.eventType), ['TENDER_OPPORTUNITY'])
  assert.deepEqual(Object.keys(out[0]).sort(), ['closed', 'contributors', 'conversationRate', 'conversations', 'eventType', 'opportunities', 'winRate', 'won'])
  assert.deepEqual(poolBenchmarks([...mixed].reverse()), out)
})

test('floors can be raised, never lowered', () => {
  const five = [ws(6, 2), ws(6, 3), ws(6, 1), ws(6, 2), ws(6, 2)]
  assert.deepEqual(poolBenchmarks(five, { minContributors: 2, minClosed: 1 }).length, 1, 'lower values are ignored')
  // Three big workspaces would pass a lowered floor — they must still be withheld.
  assert.deepEqual(poolBenchmarks([ws(20, 5), ws(20, 5), ws(20, 5)], { minContributors: 2 }), [])
  assert.deepEqual(poolBenchmarks([ws(2, 1), ws(2, 1), ws(2, 1), ws(2, 1), ws(2, 1)], { minClosed: 5 }), [])
  assert.deepEqual(poolBenchmarks(five, { minContributors: 6 }), [])
  assert.deepEqual(poolBenchmarks(five, { minClosed: 31 }), [])

  delete process.env.NETWORK_MIN_CONTRIBUTORS
  delete process.env.NETWORK_MIN_CLOSED
  assert.deepEqual([networkMinContributors(), networkMinClosed()], [MIN_CONTRIBUTORS, MIN_CLOSED])
  process.env.NETWORK_MIN_CONTRIBUTORS = '2'
  process.env.NETWORK_MIN_CLOSED = 'x'
  assert.deepEqual([networkMinContributors(), networkMinClosed()], [MIN_CONTRIBUTORS, MIN_CLOSED])
  process.env.NETWORK_MIN_CONTRIBUTORS = '8'
  process.env.NETWORK_MIN_CLOSED = '50'
  assert.deepEqual([networkMinContributors(), networkMinClosed()], [8, 50])
})

// ── DB-bound paths, against the fake Prisma client ─────────────────────────────

afterEach(() => resetPrisma())

function fake(workspace: { networkOptInAt: Date | null } | null, extra: Record<string, unknown> = {}) {
  const f = createFakePrisma({
    workspace: { findUnique: async () => workspace, update: async () => ({}), findMany: async () => [] },
    networkBenchmark: {
      findMany: async () => [{ eventType: 'NEW_PROJECT', contributors: 6, opportunities: 50, conversations: 20, closed: 40, won: 10, winRate: 0.25, conversationRate: 0.4, computedAt: new Date('2026-10-01T00:00:00Z') }],
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
  assert.deepEqual(r.benchmarks.map(b => [b.eventType, b.winRate, b.yours, b.computedAt]), [['NEW_PROJECT', 0.25, null, '2026-10-01T00:00:00.000Z']])
})

test('recompute with no opted-in workspace clears the table and publishes nothing', async () => {
  const f = fake(null)
  assert.deepEqual(await computeNetworkBenchmarks(), { workspaces: 0, published: 0, withheld: 0 })
  assert.equal(f.callsTo('networkBenchmark', 'deleteMany').length, 1)
  assert.equal(f.callsTo('networkBenchmark', 'createMany').length, 0)
})
