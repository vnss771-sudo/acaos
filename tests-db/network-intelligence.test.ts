// Database-backed tests for phase 13, cross-customer intelligence
// (lib/networkIntelligence.ts): opt-in only, aggregated and anonymised, with an
// anonymity floor of 5 workspaces / 30 closed outcomes per published figure.

import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { commercialOpportunitiesRouter } from '../apps/api/src/routes/commercialOpportunities.ts'
import { computeNetworkBenchmarks } from '../packages/backend-core/src/lib/networkIntelligence.ts'
import { prisma, resetDb, disconnect, seedUser, seedUserWithWorkspace, startTestServer, bearer, type TestServer } from './helpers/db.ts'

let opps: TestServer
before(async () => { opps = await startTestServer('/api/commercial-opportunities', commercialOpportunitiesRouter) })
after(async () => { await opps.close(); await disconnect() })
beforeEach(async () => { await resetDb() })

const DAY = 86_400_000
const json = (userId: string) => ({ Authorization: bearer(userId), 'Content-Type': 'application/json' })
let n = 0

async function seedClosed(workspaceId: string, eventType: string, status: 'WON' | 'LOST') {
  const p = await prisma.prospect.create({ data: { workspaceId, companyName: `Secret Co ${++n}` } })
  await prisma.commercialOpportunity.create({
    data: {
      workspaceId, prospectId: p.id, offerKey: 'offer:private', eventType, eventTitle: eventType, whyNow: '', confidence: 80,
      evidenceConfidence: 80, independentSources: 2, trustworthySignals: 2, offerFit: 80, intentScore: 70, timingScore: 70,
      contactability: 80, probability: 0.4, urgency: 'MEDIUM', priority: 50, buyingStage: 'ACTIVE_REQUIREMENT',
      recommendedAction: 'CONTACT_NOW', actionLabel: 'Contact now', actionReason: 'x', blockers: [], reasons: [], evidence: [], velocity: [],
      intelligenceGate: true, status, statusChangedAt: new Date(Date.now() - DAY), firstDetectedAt: new Date(Date.now() - 10 * DAY),
    },
  })
}

/** A workspace with 6 closed capacity-expansion opportunities (2 won) and 1 closed tender. */
async function seedContributor(i: number, optIn: boolean) {
  const { user, workspace } = await seedUserWithWorkspace(`owner${i}@acme.test`)
  for (let k = 0; k < 2; k++) await seedClosed(workspace.id, 'CAPACITY_EXPANSION', 'WON')
  for (let k = 0; k < 4; k++) await seedClosed(workspace.id, 'CAPACITY_EXPANSION', 'LOST')
  await seedClosed(workspace.id, 'TENDER_OPPORTUNITY', 'WON')
  if (optIn) await prisma.workspace.update({ where: { id: workspace.id }, data: { networkOptInAt: new Date() } })
  return { user, workspace }
}

test('only opted-in workspaces are pooled, only above the floor, and nothing identifying is stored', async () => {
  const contributors = []
  for (let i = 0; i < 5; i++) contributors.push(await seedContributor(i, true))
  // A large workspace that never opted in: its 20 losses must not move the benchmark.
  const outsider = await seedUserWithWorkspace('outsider@acme.test')
  for (let k = 0; k < 20; k++) await seedClosed(outsider.workspace.id, 'CAPACITY_EXPANSION', 'LOST')

  const r = await computeNetworkBenchmarks()
  assert.deepEqual(r, { workspaces: 5, published: 1, withheld: 1 })
  const rows = await prisma.networkBenchmark.findMany()
  assert.equal(rows.length, 1)
  const row = rows[0]
  assert.deepEqual([row.eventType, row.contributors, row.closed, row.won, row.winRate], ['CAPACITY_EXPANSION', 5, 30, 10, 0.333])
  assert.deepEqual(Object.keys(row).sort(), ['closed', 'computedAt', 'contributors', 'conversationRate', 'conversations', 'eventType', 'id', 'opportunities', 'winRate', 'won'])
  const stored = JSON.stringify(rows)
  for (const c of [...contributors, outsider]) assert.ok(!stored.includes(c.workspace.id))
  assert.ok(!stored.includes('Secret Co') && !stored.includes('offer:private'))

  // Reading: opted-in members see the pool beside their own figures.
  const me = contributors[0]
  const res = await opps.request(`/api/commercial-opportunities/network-benchmarks?workspaceId=${me.workspace.id}`, { headers: json(me.user.id) })
  assert.equal(res.status, 200)
  const body = res.body as { benchmarks: Array<{ eventType: string; winRate: number; yours: { closed: number; won: number; winRate: number } }> }
  assert.deepEqual(body.benchmarks.map(b => [b.eventType, b.winRate, b.yours]), [['CAPACITY_EXPANSION', 0.333, { closed: 6, won: 2, winRate: 0.333 }]])
  // A workspace that hasn't opted in can't read the pool.
  const denied = await opps.request(`/api/commercial-opportunities/network-benchmarks?workspaceId=${outsider.workspace.id}`, { headers: json(outsider.user.id) })
  assert.equal(denied.status, 403)
  // Nor can a non-member read another workspace's view.
  assert.equal((await opps.request(`/api/commercial-opportunities/network-benchmarks?workspaceId=${me.workspace.id}`, { headers: json(outsider.user.id) })).status, 403)
})

test('participation: admin-only, audited; opting out removes the workspace at the next recompute', async () => {
  const contributors = []
  for (let i = 0; i < 5; i++) contributors.push(await seedContributor(i, true))
  await computeNetworkBenchmarks()
  assert.equal(await prisma.networkBenchmark.count(), 1)

  const { user, workspace } = contributors[0]
  const member = await seedUser('member@acme.test', null, { emailVerified: true })
  await prisma.membership.create({ data: { userId: member.id, workspaceId: workspace.id, role: 'member' } })
  const put = (uid: string, optIn: boolean) => opps.request('/api/commercial-opportunities/network-participation', {
    method: 'PUT', headers: json(uid), body: JSON.stringify({ workspaceId: workspace.id, optIn }),
  })
  assert.equal((await put(member.id, false)).status, 403)

  const before = (await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } })).networkOptInAt
  const stay = await put(user.id, true)
  assert.equal(stay.status, 200)
  assert.equal((stay.body as { optedInAt: string }).optedInAt, before?.toISOString(), 'staying in keeps the original opt-in time')

  const out = await put(user.id, false)
  assert.deepEqual(out.body, { optedInAt: null })
  assert.ok(await prisma.auditEvent.findFirst({ where: { workspaceId: workspace.id, type: 'network.opt_out' } }))
  assert.equal((await opps.request(`/api/commercial-opportunities/network-benchmarks?workspaceId=${workspace.id}`, { headers: json(user.id) })).status, 403)

  // Four contributors remain — below the floor — so the next recompute withholds the kind.
  assert.deepEqual(await computeNetworkBenchmarks(), { workspaces: 4, published: 0, withheld: 2 })
  assert.equal(await prisma.networkBenchmark.count(), 0)

  assert.equal((await put(user.id, true)).status, 200)
  assert.ok(await prisma.auditEvent.findFirst({ where: { workspaceId: workspace.id, type: 'network.opt_in' } }))
})
