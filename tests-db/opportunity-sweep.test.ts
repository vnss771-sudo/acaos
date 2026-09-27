// Database-backed tests for the work-discovery sweep: matching + upsert,
// idempotent re-delivery, change detection that never touches a user's status,
// cursor durability on failure, per-source isolation, skip reasons, a shared
// national fetch across workspaces, and tenant scoping.
import { test, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { runOpportunitySweep } from '../packages/backend-core/src/lib/opportunitySweep.ts'
import type { OpportunitySource, SourceFetchContext, SourceFetchResult } from '../packages/backend-core/src/lib/opportunitySources.ts'
import type { OpportunityCandidate } from '../packages/backend-core/src/lib/opportunityTypes.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace } from './helpers/db.ts'

after(async () => { await disconnect() })
beforeEach(async () => { await resetDb() })

const NOW = new Date('2026-09-25T09:00:00Z')

function contract(id: string, over: Partial<OpportunityCandidate> = {}): OpportunityCandidate {
  return {
    externalId: id, kind: 'CONTRACT_AWARD', title: 'Electrical maintenance services', region: 'QLD', locality: 'Brisbane',
    valueAmount: 400_000, publishedAt: new Date('2026-09-23T00:00:00Z'),
    classifications: [{ scheme: 'UNSPSC', id: '72151500', description: 'Electrical system services' }],
    counterparty: { name: 'Acme Builders Pty Ltd', abn: '12345678901' },
    ...over,
  }
}

// A scriptable in-memory source: `pages` is consumed one per fetch call.
function fakeSource(name: string, pages: Array<SourceFetchResult | Error>, calls: SourceFetchContext[] = [], over: Partial<OpportunitySource> = {}): OpportunitySource {
  return {
    name, label: name, description: name, isConfigured: true,
    unavailableReason: () => null,
    requestKey: (ctx) => `${name}:${ctx.cursor}`,
    async fetch(ctx) {
      calls.push(ctx)
      const next = pages.shift()
      if (!next) return { items: [], nextCursor: ctx.cursor }
      if (next instanceof Error) throw next
      return next
    },
    ...over,
  }
}

async function profileFor(workspaceId: string, over: Record<string, unknown> = {}) {
  return prisma.discoveryProfile.create({
    data: { workspaceId, trades: ['electrical'], keywords: [], regions: ['QLD'], sources: ['fake'], ...over },
  })
}

test('stores matching opportunities with score, reasons and counterparty; drops the rest', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await profileFor(workspace.id)
  const src = fakeSource('fake', [{
    items: [
      contract('CN1'),
      contract('CN2', { title: 'Software licences', classifications: [{ scheme: 'UNSPSC', id: '43230000', description: 'Software' }] }),
      contract('CN3', { region: 'VIC' }),
    ],
    nextCursor: 'c1',
  }])

  const r = await runOpportunitySweep({ sources: [src], now: NOW })
  assert.equal(r.runs.length, 1)
  assert.deepEqual({ status: r.runs[0].status, fetched: r.runs[0].fetched, matched: r.runs[0].matched, created: r.runs[0].created }, { status: 'ok', fetched: 3, matched: 1, created: 1 })

  const [o] = await prisma.opportunity.findMany({ where: { workspaceId: workspace.id } })
  assert.equal(o.externalId, 'CN1')
  assert.equal(o.status, 'NEW')
  assert.equal(o.counterpartyName, 'Acme Builders Pty Ltd')
  assert.deepEqual(o.matchedTrades, ['electrical'])
  assert.ok(o.score >= 60)
  assert.ok((o.reasons as string[]).some(x => /Classified as electrical work/.test(x)))
  assert.match(o.recommendedAction ?? '', /Contact Acme Builders/)

  const state = await prisma.discoverySourceState.findUniqueOrThrow({ where: { workspaceId_source: { workspaceId: workspace.id, source: 'fake' } } })
  assert.equal(state.cursor, 'c1')
  assert.equal(state.lastFetched, 3)
  assert.equal(state.lastMatched, 1)
  assert.equal(state.lastError, null)
})

test('re-delivery is idempotent; a real change bumps lastChangedAt but never the user\'s status', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await profileFor(workspace.id)
  const src = fakeSource('fake', [
    { items: [contract('CN1')], nextCursor: 'c1' },
    { items: [contract('CN1')], nextCursor: 'c2' },
    { items: [contract('CN1', { valueAmount: 900_000 })], nextCursor: 'c3' },
  ])

  await runOpportunitySweep({ sources: [src], now: NOW })
  await prisma.opportunity.updateMany({ where: { workspaceId: workspace.id }, data: { status: 'PURSUING' } })

  const later = new Date(NOW.getTime() + 3_600_000)
  const second = await runOpportunitySweep({ sources: [src], now: later })
  assert.deepEqual({ created: second.runs[0].created, updated: second.runs[0].updated }, { created: 0, updated: 0 })
  let o = await prisma.opportunity.findFirstOrThrow({ where: { workspaceId: workspace.id } })
  assert.equal(o.lastChangedAt.toISOString(), NOW.toISOString(), 'unchanged content: not flagged as changed')
  assert.equal(o.lastSeenAt.toISOString(), later.toISOString())

  const third = await runOpportunitySweep({ sources: [src], now: new Date(later.getTime() + 3_600_000) })
  assert.equal(third.runs[0].updated, 1)
  o = await prisma.opportunity.findFirstOrThrow({ where: { workspaceId: workspace.id } })
  assert.equal(o.valueAmount, 900_000)
  assert.ok(o.lastChangedAt > later)
  assert.equal(o.status, 'PURSUING', 'status is the user\'s — never reset by the sweep')
  assert.equal(await prisma.opportunity.count(), 1)
})

test('a failing fetch leaves the cursor in place and the next run resumes from it', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await profileFor(workspace.id)
  const calls: SourceFetchContext[] = []
  const src = fakeSource('fake', [
    { items: [contract('CN1')], nextCursor: 'c1' },
    new Error('austender findByDates: 503'),
    { items: [contract('CN2')], nextCursor: 'c2' },
  ], calls)

  await runOpportunitySweep({ sources: [src], now: NOW })
  const failed = await runOpportunitySweep({ sources: [src], now: NOW })
  assert.equal(failed.runs[0].status, 'failed')
  let state = await prisma.discoverySourceState.findFirstOrThrow({ where: { workspaceId: workspace.id } })
  assert.equal(state.cursor, 'c1')
  assert.match(state.lastError ?? '', /503/)

  await runOpportunitySweep({ sources: [src], now: NOW })
  assert.deepEqual(calls.map(c => c.cursor), [null, 'c1', 'c1'], 'the retry re-reads from the last good cursor')
  state = await prisma.discoverySourceState.findFirstOrThrow({ where: { workspaceId: workspace.id } })
  assert.equal(state.cursor, 'c2')
  assert.equal(state.lastError, null)
})

test('a persistence failure mid-batch does not advance the cursor', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await profileFor(workspace.id)
  // Inject a real DB failure on the second item only.
  await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION acaos_test_fail_cn2() RETURNS trigger AS $$ BEGIN IF NEW."externalId" = 'CN2' THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`)
  await prisma.$executeRawUnsafe(`CREATE TRIGGER acaos_test_fail_cn2 BEFORE INSERT ON "Opportunity" FOR EACH ROW EXECUTE FUNCTION acaos_test_fail_cn2()`)
  try {
    const src = fakeSource('fake', [{ items: [contract('CN1'), contract('CN2')], nextCursor: 'c1' }])
    const r = await runOpportunitySweep({ sources: [src], now: NOW })
    assert.equal(r.runs[0].status, 'failed')
    const state = await prisma.discoverySourceState.findFirstOrThrow({ where: { workspaceId: workspace.id } })
    assert.equal(state.cursor, null, 'CN2 was not stored, so the range must be re-read')
  } finally {
    await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS acaos_test_fail_cn2 ON "Opportunity"')
  }
})

test('one failing source does not stop the others; unconfigured / unavailable sources are skipped with a reason', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await profileFor(workspace.id, { sources: ['broken', 'good', 'nokey', 'needsbase', 'nosuch'] })
  const sources = [
    fakeSource('broken', [new Error('boom')]),
    fakeSource('good', [{ items: [contract('CN1')], nextCursor: 'g1' }]),
    fakeSource('nokey', [], [], { isConfigured: false }),
    fakeSource('needsbase', [], [], { unavailableReason: () => 'Set a base location' }),
  ]
  const r = await runOpportunitySweep({ sources, now: NOW })
  const by = Object.fromEntries(r.runs.map(x => [x.source, x]))
  assert.equal(by.broken.status, 'failed')
  assert.equal(by.good.status, 'ok')
  assert.equal(by.good.created, 1)
  assert.equal(by.nokey.status, 'skipped')
  assert.match(by.nokey.reason ?? '', /not configured/)
  assert.equal(by.needsbase.reason, 'Set a base location')
  assert.equal(by.nosuch.reason, 'Unknown source')
  const warn = await prisma.discoverySourceState.findFirstOrThrow({ where: { workspaceId: workspace.id, source: 'needsbase' } })
  assert.equal(warn.lastWarning, 'Set a base location')
})

test('a national feed is fetched once per sweep and matched per workspace', async () => {
  const a = await seedUserWithWorkspace('a@x.test')
  const b = await seedUserWithWorkspace('b@x.test')
  const c = await seedUserWithWorkspace('c@x.test')
  await profileFor(a.workspace.id)
  await profileFor(b.workspace.id, { trades: ['plumbing'] }) // electrical contract doesn't fit
  await profileFor(c.workspace.id, { enabled: false })
  const calls: SourceFetchContext[] = []
  const src = fakeSource('fake', [{ items: [contract('CN1')], nextCursor: 'c1' }], calls)

  const r = await runOpportunitySweep({ sources: [src], now: NOW })
  assert.equal(r.workspaces, 2, 'disabled profile is not swept')
  assert.equal(calls.length, 1, 'one upstream read shared by both workspaces')
  assert.equal(await prisma.opportunity.count({ where: { workspaceId: a.workspace.id } }), 1)
  assert.equal(await prisma.opportunity.count({ where: { workspaceId: b.workspace.id } }), 0)
  // Each workspace keeps its own cursor.
  assert.equal(await prisma.discoverySourceState.count({ where: { cursor: 'c1' } }), 2)
})

test('workspaceId limits the sweep to one workspace', async () => {
  const a = await seedUserWithWorkspace('a2@x.test')
  const b = await seedUserWithWorkspace('b2@x.test')
  await profileFor(a.workspace.id)
  await profileFor(b.workspace.id)
  const src = fakeSource('fake', [{ items: [contract('CN1')], nextCursor: 'c1' }, { items: [contract('CN1')], nextCursor: 'c1' }])
  const r = await runOpportunitySweep({ workspaceId: b.workspace.id, sources: [src], now: NOW })
  assert.deepEqual(r.runs.map(x => x.workspaceId), [b.workspace.id])
  assert.equal(await prisma.opportunity.count({ where: { workspaceId: a.workspace.id } }), 0)
})
