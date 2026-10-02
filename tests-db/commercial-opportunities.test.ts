// Database-backed tests for the opportunity engine's persistence
// (lib/commercialOpportunityStore.ts) and the /api/offers and
// /api/commercial-opportunities routes: lifecycle (create → expire → re-open),
// operator statuses never overwritten, offer scoping, RBAC and tenant isolation.

import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { offersRouter } from '../apps/api/src/routes/offers.ts'
import { commercialOpportunitiesRouter } from '../apps/api/src/routes/commercialOpportunities.ts'
import { evidenceGraphRouter } from '../apps/api/src/routes/evidenceGraph.ts'
import { refreshCommercialOpportunities } from '../packages/backend-core/src/lib/commercialOpportunityStore.ts'
import { prisma, resetDb, disconnect, seedUser, seedUserWithWorkspace, startTestServer, bearer, type TestServer } from './helpers/db.ts'

let offers: TestServer
let opps: TestServer
let graph: TestServer
before(async () => {
  offers = await startTestServer('/api/offers', offersRouter)
  opps = await startTestServer('/api/commercial-opportunities', commercialOpportunitiesRouter)
  graph = await startTestServer('/api/evidence-graph', evidenceGraphRouter)
})
after(async () => { await offers.close(); await opps.close(); await graph.close(); await disconnect() })
beforeEach(async () => { await resetDb() })

const DAY = 86_400_000
const json = (userId: string) => ({ Authorization: bearer(userId), 'Content-Type': 'application/json' })

async function seedProspect(workspaceId: string, over: Record<string, unknown> = {}) {
  return prisma.prospect.create({
    data: {
      workspaceId, companyName: 'ABC Electrical', industry: 'Electrical contractor', location: 'Brisbane, QLD',
      contactName: 'Sam Lee', contactEmail: 'sam@abc.example', contactTitle: 'Operations Manager', ...over,
    },
  })
}

/** Three independent, fresh, sourced signals → a corroborated capacity/procurement event. */
async function seedCorroboratedSignals(workspaceId: string, prospectId: string, daysAgo = 3) {
  const at = new Date(Date.now() - daysAgo * DAY)
  const rows = [
    { type: 'EXPANSION' as const, title: 'New depot opened in Brisbane', host: 'news.example.org' },
    { type: 'HIRING' as const, title: 'Hiring 17 field technicians', host: 'jobs.example.com' },
    { type: 'PROCUREMENT' as const, title: '$4.2M project awarded', host: 'tenders.example.gov' },
  ]
  for (const [i, r] of rows.entries()) {
    const url = `https://${r.host}/item-${i}`
    const ev = await prisma.evidenceSource.create({
      data: { workspaceId, prospectId, provider: r.host, sourceType: 'news', sourceUrl: url, observedAt: at, confidence: 0.9 },
    })
    await prisma.signal.create({
      data: {
        workspaceId, prospectId, evidenceSourceId: ev.id, type: r.type, strength: 85, sourceReliability: 90,
        industryRelevance: 85, title: r.title, description: `${r.title} — with 2 supporting details`, sourceUrl: url,
        source: r.host, detectedAt: at,
      },
    })
  }
}

async function seedOffer(workspaceId: string, over: Record<string, unknown> = {}) {
  return prisma.offer.create({
    data: {
      workspaceId, name: 'Temporary field crews', problemSolved: 'Short-notice field labour for expanding contractors',
      targetBuyerTitles: ['Operations Manager'], triggeringEvents: ['CAPACITY_EXPANSION', 'ACTIVE_PROCUREMENT'],
      qualifyingKeywords: ['field technicians', 'new depot'], dealValueMinCents: 4_000_000, dealValueMaxCents: 8_000_000,
      ...over,
    },
  })
}

test('refresh creates a corroborated opportunity with its evidence and recommendation', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const p = await seedProspect(workspace.id)
  await seedCorroboratedSignals(workspace.id, p.id)
  const offer = await seedOffer(workspace.id)

  const r = await refreshCommercialOpportunities(workspace.id, [p.id])
  assert.deepEqual({ prospects: r.prospects, upserted: r.upserted, expired: r.expired }, { prospects: 1, upserted: 1, expired: 0 })

  const row = await prisma.commercialOpportunity.findFirstOrThrow({ where: { workspaceId: workspace.id, prospectId: p.id } })
  assert.equal(row.offerId, offer.id)
  assert.equal(row.offerKey, `offer:${offer.id}`)
  assert.equal(row.status, 'OPEN')
  assert.equal(row.intelligenceGate, true)
  // Built on the strongest triggered event: expansion + hiring, two sources.
  assert.equal(row.eventType, 'CAPACITY_EXPANSION')
  assert.equal(row.eventFamily, 'CAPACITY_EXPANSION')
  assert.equal(row.independentSources, 2)
  assert.equal(row.recommendedAction, 'CONTACT_NOW')
  const evidence = row.evidence as Array<{ signalId: string; sourceUrl: string }>
  const signalIds = (await prisma.signal.findMany({ where: { prospectId: p.id, type: { in: ['EXPANSION', 'HIRING'] } }, select: { id: true } })).map(s => s.id).sort()
  assert.deepEqual(evidence.map(e => e.signalId).sort(), signalIds, 'every claim traces to a stored signal')

  // The opportunity links to the persisted event, whose evidence links are the same signals.
  assert.ok(row.commercialEventId)
  const event = await prisma.commercialEvent.findUniqueOrThrow({ where: { id: row.commercialEventId }, include: { evidenceLinks: true } })
  assert.equal(event.kind, 'CAPACITY_EXPANSION')
  assert.equal(event.status, 'ACTIVE')
  assert.deepEqual(event.evidenceLinks.map(l => l.signalId).sort(), signalIds)
})

test('events are persisted with their evidence links, even with no offer, and go STALE when unsupported', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const p = await seedProspect(workspace.id)
  await seedCorroboratedSignals(workspace.id, p.id)

  const r = await refreshCommercialOpportunities(workspace.id, [p.id])
  assert.equal(r.upserted, 0, 'no offer → no opportunity')
  const events = await prisma.commercialEvent.findMany({ where: { workspaceId: workspace.id }, include: { evidenceLinks: true }, orderBy: { kind: 'asc' } })
  const kinds = events.map(e => e.kind)
  for (const k of ['CAPACITY_EXPANSION', 'GEOGRAPHIC_EXPANSION', 'HIRING_SURGE', 'NEW_PROJECT']) assert.ok(kinds.includes(k), `${k} in ${kinds}`)
  assert.equal(r.events, events.length)
  for (const e of events) {
    assert.ok(e.evidenceLinks.length > 0, `${e.kind} has evidence`)
    assert.ok(e.evidenceLinks.every(l => l.workspaceId === workspace.id && l.claim.length > 0))
  }

  // Re-running replaces links rather than accumulating them.
  const linkCount = await prisma.evidenceLink.count({ where: { workspaceId: workspace.id } })
  await refreshCommercialOpportunities(workspace.id, [p.id])
  assert.equal(await prisma.evidenceLink.count({ where: { workspaceId: workspace.id } }), linkCount)

  await prisma.signal.updateMany({ where: { prospectId: p.id }, data: { detectedAt: new Date(Date.now() - 120 * DAY) } })
  const r2 = await refreshCommercialOpportunities(workspace.id, [p.id])
  assert.equal(r2.staleEvents, events.length)
  assert.equal(await prisma.commercialEvent.count({ where: { workspaceId: workspace.id, status: 'ACTIVE' } }), 0)
  assert.equal(await prisma.evidenceLink.count({ where: { workspaceId: workspace.id } }), linkCount, 'stale events keep their history')
})

test('evidence graph: company → sources → signals → events → opportunities, tenant-scoped', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const other = await seedUserWithWorkspace('other@acme.test')
  const p = await seedProspect(workspace.id)
  await seedCorroboratedSignals(workspace.id, p.id)
  const offer = await seedOffer(workspace.id)
  await refreshCommercialOpportunities(workspace.id, [p.id])

  const res = await graph.request(`/api/evidence-graph/${p.id}?workspaceId=${workspace.id}`, { headers: { Authorization: bearer(user.id) } })
  assert.equal(res.status, 200)
  const byKind = (k: string) => res.body.nodes.filter((n: { kind: string }) => n.kind === k)
  assert.equal(byKind('company').length, 1)
  assert.equal(byKind('source').length, 3)
  assert.equal(byKind('signal').length, 3)
  assert.ok(byKind('event').length >= 3)
  assert.equal(byKind('opportunity').length, 1)
  assert.deepEqual(byKind('offer').map((n: { label: string }) => n.label), [offer.name])

  const edge = (k: string) => res.body.edges.filter((e: { kind: string }) => e.kind === k)
  assert.equal(edge('REPORTED').length, 3)
  assert.equal(edge('OBSERVED').length, 3)
  assert.equal(edge('CREATES').length, 1)
  assert.equal(edge('FOR_OFFER').length, 1)
  assert.ok(edge('SUPPORTS').every((e: { data: { claim: string } }) => e.data.claim.length > 0))
  const nodeIds = new Set(res.body.nodes.map((n: { id: string }) => n.id))
  assert.ok(res.body.edges.every((e: { from: string; to: string }) => nodeIds.has(e.from) && nodeIds.has(e.to)), 'no dangling edges')

  const signal = byKind('signal')[0]
  assert.equal(typeof signal.data.quality, 'number')
  assert.ok(['HIGH', 'MEDIUM', 'LOW', 'UNUSABLE'].includes(signal.data.grade))
  const capacity = res.body.narratives.find((n: { text: string }) => n.text.includes('capacity expansion'))
  assert.ok(capacity, 'a narrative per active event')
  assert.match(capacity.text, /^ABC Electrical: capacity expansion \(confidence \d+%\)\./)
  assert.match(capacity.text, /• Hiring 17 field technicians — jobs\.example\.com, \d{4}-\d{2}-\d{2}/)

  assert.equal((await graph.request(`/api/evidence-graph/${p.id}?workspaceId=${workspace.id}`, { headers: { Authorization: bearer(other.user.id) } })).status, 403)
  assert.equal((await graph.request(`/api/evidence-graph/${p.id}?workspaceId=${other.workspace.id}`, { headers: { Authorization: bearer(other.user.id) } })).status, 404)

  // Stale events are hidden unless asked for.
  await prisma.commercialEvent.updateMany({ where: { workspaceId: workspace.id }, data: { status: 'STALE' } })
  const hidden = await graph.request(`/api/evidence-graph/${p.id}?workspaceId=${workspace.id}`, { headers: { Authorization: bearer(user.id) } })
  assert.equal(hidden.body.nodes.filter((n: { kind: string }) => n.kind === 'event').length, 0)
  assert.equal(hidden.body.narratives.length, 0)
  const withStale = await graph.request(`/api/evidence-graph/${p.id}?workspaceId=${workspace.id}&includeStale=true`, { headers: { Authorization: bearer(user.id) } })
  assert.ok(withStale.body.nodes.filter((n: { kind: string }) => n.kind === 'event').length >= 3)
})

test('an OPEN opportunity expires when its evidence goes stale, and re-opens on fresh evidence', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const p = await seedProspect(workspace.id)
  await seedCorroboratedSignals(workspace.id, p.id)
  await seedOffer(workspace.id)
  await refreshCommercialOpportunities(workspace.id, [p.id])

  // Age every signal past the event window.
  await prisma.signal.updateMany({ where: { prospectId: p.id }, data: { detectedAt: new Date(Date.now() - 120 * DAY) } })
  const r1 = await refreshCommercialOpportunities(workspace.id, [p.id])
  assert.equal(r1.expired, 1)
  assert.equal((await prisma.commercialOpportunity.findFirstOrThrow({ where: { prospectId: p.id } })).status, 'EXPIRED')

  await seedCorroboratedSignals(workspace.id, p.id, 1)
  await refreshCommercialOpportunities(workspace.id, [p.id])
  const row = await prisma.commercialOpportunity.findFirstOrThrow({ where: { prospectId: p.id } })
  assert.equal(row.status, 'OPEN')
  assert.equal(await prisma.commercialOpportunity.count({ where: { prospectId: p.id } }), 1, 'same row, not a duplicate')
})

test('the engine never overwrites an operator status', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const p = await seedProspect(workspace.id)
  await seedCorroboratedSignals(workspace.id, p.id)
  await seedOffer(workspace.id)
  await refreshCommercialOpportunities(workspace.id, [p.id])
  await prisma.commercialOpportunity.updateMany({ where: { prospectId: p.id }, data: { status: 'PURSUING' } })

  await prisma.signal.updateMany({ where: { prospectId: p.id }, data: { detectedAt: new Date(Date.now() - 120 * DAY) } })
  await refreshCommercialOpportunities(workspace.id, [p.id])
  assert.equal((await prisma.commercialOpportunity.findFirstOrThrow({ where: { prospectId: p.id } })).status, 'PURSUING')
})

test('offer scoping: a mission offer applies to its prospects only; no offer at all → no opportunity', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const mission = await prisma.mission.create({ data: { workspaceId: workspace.id, name: 'Field crews', goalType: 'pipeline' } })
  const inMission = await seedProspect(workspace.id, { missionId: mission.id })
  const outside = await seedProspect(workspace.id, { companyName: 'Other Co' })
  for (const p of [inMission, outside]) await seedCorroboratedSignals(workspace.id, p.id)

  await refreshCommercialOpportunities(workspace.id, [inMission.id, outside.id])
  assert.equal(await prisma.commercialOpportunity.count({ where: { workspaceId: workspace.id } }), 0, 'nothing to assess against')

  await seedOffer(workspace.id, { missionId: mission.id })
  await refreshCommercialOpportunities(workspace.id, [inMission.id, outside.id])
  const rows = await prisma.commercialOpportunity.findMany({ where: { workspaceId: workspace.id } })
  assert.deepEqual(rows.map(r => r.prospectId), [inMission.id])
})

test('a mission free-text offer is used when the mission has no structured offer', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const mission = await prisma.mission.create({
    data: { workspaceId: workspace.id, name: 'Crews', goalType: 'pipeline', offer: 'temporary field crews and procurement support for expanding contractors' },
  })
  const p = await seedProspect(workspace.id, { missionId: mission.id })
  await seedCorroboratedSignals(workspace.id, p.id)
  await refreshCommercialOpportunities(workspace.id, [p.id])
  const row = await prisma.commercialOpportunity.findFirstOrThrow({ where: { prospectId: p.id } })
  assert.equal(row.offerKey, `mission:${mission.id}`)
  assert.equal(row.offerId, null)
})

test('offers API: admin-only writes, mission must be in the workspace, delete expires OPEN opportunities', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const member = await seedUser('member@acme.test', null, { emailVerified: true })
  await prisma.membership.create({ data: { userId: member.id, workspaceId: workspace.id, role: 'member' } })
  const other = await seedUserWithWorkspace('other@acme.test')
  const foreignMission = await prisma.mission.create({ data: { workspaceId: other.workspace.id, name: 'X', goalType: 'pipeline' } })

  const body = { workspaceId: workspace.id, name: 'Temporary field crews', triggeringEvents: ['CAPACITY_EXPANSION'], qualifyingKeywords: ['Field Technicians'] }
  const denied = await offers.request('/api/offers', { method: 'POST', headers: json(member.id), body: JSON.stringify(body) })
  assert.equal(denied.status, 403)
  const badMission = await offers.request('/api/offers', { method: 'POST', headers: json(user.id), body: JSON.stringify({ ...body, missionId: foreignMission.id }) })
  assert.equal(badMission.status, 404)
  const badRange = await offers.request('/api/offers', { method: 'POST', headers: json(user.id), body: JSON.stringify({ ...body, dealValueMinCents: 10, dealValueMaxCents: 5 }) })
  assert.equal(badRange.status, 400)
  const badEvent = await offers.request('/api/offers', { method: 'POST', headers: json(user.id), body: JSON.stringify({ ...body, triggeringEvents: ['NO_CLEAR_EVENT'] }) })
  assert.equal(badEvent.status, 400)

  const created = await offers.request('/api/offers', { method: 'POST', headers: json(user.id), body: JSON.stringify(body) })
  assert.equal(created.status, 201)
  assert.deepEqual(created.body.offer.qualifyingKeywords, ['field technicians'], 'keywords are normalised to lower case')
  const offerId = created.body.offer.id

  const put = (userId: string, wsId: string, b: Record<string, unknown>) =>
    offers.request(`/api/offers/${offerId}`, { method: 'PUT', headers: json(userId), body: JSON.stringify({ workspaceId: wsId, ...b }) })
  const updated = await put(user.id, workspace.id, { dealValueMinCents: 4_000_000, dealValueMaxCents: 8_000_000, geographies: ['QLD'] })
  assert.equal(updated.status, 200)
  assert.equal(updated.body.offer.name, 'Temporary field crews', 'fields not sent are left alone')
  assert.deepEqual(updated.body.offer.geographies, ['QLD'])
  const inverted = await put(user.id, workspace.id, { dealValueMinCents: 9_000_000 })
  assert.equal(inverted.status, 400, 'min is checked against the stored max')
  assert.equal((await put(member.id, workspace.id, { name: 'Nope' })).status, 403)
  assert.equal((await put(other.user.id, other.workspace.id, { name: 'Nope' })).status, 404)

  const list = await offers.request(`/api/offers?workspaceId=${workspace.id}`, { headers: { Authorization: bearer(member.id) } })
  assert.equal(list.status, 200)
  assert.equal(list.body.offers.length, 1)
  const foreignList = await offers.request(`/api/offers?workspaceId=${workspace.id}`, { headers: { Authorization: bearer(other.user.id) } })
  assert.equal(foreignList.status, 403)

  const p = await seedProspect(workspace.id)
  await seedCorroboratedSignals(workspace.id, p.id)
  await refreshCommercialOpportunities(workspace.id, [p.id])
  assert.equal((await prisma.commercialOpportunity.findFirstOrThrow({ where: { prospectId: p.id } })).status, 'OPEN')

  const crossDelete = await offers.request(`/api/offers/${offerId}?workspaceId=${other.workspace.id}`, { method: 'DELETE', headers: { Authorization: bearer(other.user.id) } })
  assert.equal(crossDelete.status, 404)
  const del = await offers.request(`/api/offers/${offerId}?workspaceId=${workspace.id}`, { method: 'DELETE', headers: { Authorization: bearer(user.id) } })
  assert.equal(del.status, 200)
  assert.equal(await prisma.offer.count({ where: { id: offerId } }), 0)
  assert.equal((await prisma.commercialOpportunity.findFirstOrThrow({ where: { prospectId: p.id } })).status, 'EXPIRED')
  assert.ok(await prisma.auditEvent.findFirst({ where: { type: 'offer.deleted', entityId: offerId } }))
})

test('commercial-opportunities API: list, detail, status workflow, refresh — all tenant-scoped', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const other = await seedUserWithWorkspace('other@acme.test')
  const p = await seedProspect(workspace.id)
  await seedCorroboratedSignals(workspace.id, p.id)
  await seedOffer(workspace.id)

  const refresh = await opps.request('/api/commercial-opportunities/refresh', { method: 'POST', headers: json(user.id), body: JSON.stringify({ workspaceId: workspace.id }) })
  assert.equal(refresh.status, 200)
  assert.equal(refresh.body.upserted, 1)

  const list = await opps.request(`/api/commercial-opportunities?workspaceId=${workspace.id}`, { headers: { Authorization: bearer(user.id) } })
  assert.equal(list.status, 200)
  assert.equal(list.body.total, 1)
  const id = list.body.opportunities[0].id
  assert.equal(list.body.opportunities[0].prospect.companyName, 'ABC Electrical')

  const detail = await opps.request(`/api/commercial-opportunities/${id}?workspaceId=${workspace.id}`, { headers: { Authorization: bearer(user.id) } })
  assert.equal(detail.status, 200)
  assert.equal(detail.body.opportunity.evidence.length, 2)

  const foreignDetail = await opps.request(`/api/commercial-opportunities/${id}?workspaceId=${other.workspace.id}`, { headers: { Authorization: bearer(other.user.id) } })
  assert.equal(foreignDetail.status, 404)
  const foreignList = await opps.request(`/api/commercial-opportunities?workspaceId=${workspace.id}`, { headers: { Authorization: bearer(other.user.id) } })
  assert.equal(foreignList.status, 403)
  const foreignRefresh = await opps.request('/api/commercial-opportunities/refresh', { method: 'POST', headers: json(other.user.id), body: JSON.stringify({ workspaceId: other.workspace.id, prospectId: p.id }) })
  assert.equal(foreignRefresh.status, 404)

  const expiredByOperator = await opps.request(`/api/commercial-opportunities/${id}/status`, { method: 'PATCH', headers: json(user.id), body: JSON.stringify({ workspaceId: workspace.id, status: 'EXPIRED' }) })
  assert.equal(expiredByOperator.status, 400, 'EXPIRED is the engine\'s to set')
  const dismissed = await opps.request(`/api/commercial-opportunities/${id}/status`, { method: 'PATCH', headers: json(user.id), body: JSON.stringify({ workspaceId: workspace.id, status: 'DISMISSED' }) })
  assert.equal(dismissed.status, 200)
  assert.ok(await prisma.auditEvent.findFirst({ where: { type: 'commercial_opportunity.status', entityId: id } }))

  const hidden = await opps.request(`/api/commercial-opportunities?workspaceId=${workspace.id}`, { headers: { Authorization: bearer(user.id) } })
  assert.equal(hidden.body.total, 0, 'dismissed is hidden by default')
  assert.equal(hidden.body.counts.DISMISSED, 1)
})
