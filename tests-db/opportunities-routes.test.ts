// Database-backed tests for /api/opportunities: the discovery profile
// (validation + admin gate), the ranked list (hides dismissed, per-status
// counts, tenant scoping), status workflow, "won → Field Ops job site", and the
// run-now gates.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { opportunitiesRouter } from '../apps/api/src/routes/opportunities.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace, startTestServer, bearer, type TestServer } from './helpers/db.ts'

let server: TestServer
before(async () => { server = await startTestServer('/api/opportunities', opportunitiesRouter) })
after(async () => { await server.close(); await disconnect() })
beforeEach(async () => { await resetDb(); delete process.env.OPPORTUNITY_DISCOVERY_ENABLED })

function req(userId: string, method: string, path: string, body?: unknown) {
  return server.request(`/api/opportunities${path}`, {
    method,
    headers: { Authorization: bearer(userId), 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

async function memberOf(workspaceId: string, email: string) {
  const m = await seedUserWithWorkspace(email)
  await prisma.membership.create({ data: { userId: m.user.id, workspaceId, role: 'member' } })
  return m.user
}

let seq = 0
async function seedOpportunity(workspaceId: string, over: Record<string, unknown> = {}) {
  seq++
  return prisma.opportunity.create({
    data: {
      workspaceId, source: 'austender', externalId: `CN${seq}`, kind: 'CONTRACT_AWARD', title: `Contract ${seq}`,
      score: 50, matchedTrades: ['electrical'], reasons: ['Classified as electrical work'], contentHash: `h${seq}`,
      region: 'QLD', address: '1 Example St, Brisbane QLD 4000', lat: -27.47, lng: 153.02,
      counterpartyName: 'Acme Builders', sourceUrl: 'https://example.test/cn',
      ...over,
    },
  })
}

const PROFILE = { trades: ['electrical', 'hvac'], keywords: ['Switchroom'], baseLat: -27.47, baseLng: 153.02, radiusKm: 40, regions: ['QLD'], minValue: 50_000, sources: ['austender'] }

test('profile: an admin saves it; GET returns it with trade/region choices and source health', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const empty = await req(user.id, 'GET', `/profile?workspaceId=${workspace.id}`)
  assert.equal(empty.status, 200)
  assert.equal(empty.body.profile, null)
  assert.ok(empty.body.trades.some((t: { id: string }) => t.id === 'electrical'))
  assert.ok(empty.body.regions.includes('QLD'))
  assert.deepEqual(empty.body.sources.map((s: { name: string }) => s.name), ['austender', 'planningalerts'])
  assert.equal(empty.body.discoveryEnabled, false)

  const put = await req(user.id, 'PUT', '/profile', { workspaceId: workspace.id, ...PROFILE })
  assert.equal(put.status, 200)
  assert.deepEqual(put.body.profile.keywords, ['switchroom'], 'keywords are normalized')
  await prisma.discoverySourceState.create({ data: { workspaceId: workspace.id, source: 'austender', lastError: 'austender: 503', lastMatched: 4 } })

  const got = await req(user.id, 'GET', `/profile?workspaceId=${workspace.id}`)
  assert.equal(got.body.profile.radiusKm, 40)
  const aus = got.body.sources.find((s: { name: string }) => s.name === 'austender')
  assert.equal(aus.configured, true)
  assert.equal(aus.lastError, 'austender: 503')
  assert.equal(aus.lastMatched, 4)
  assert.ok(await prisma.auditEvent.findFirst({ where: { type: 'discovery.profile_updated' } }))
})

test('profile: validation rejects unknown trades/sources/regions and half a base point', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  for (const bad of [
    { ...PROFILE, trades: ['astronaut'] },
    { ...PROFILE, sources: ['zoominfo'] },
    { ...PROFILE, regions: ['XX'] },
    { ...PROFILE, baseLng: null },
    { ...PROFILE, radiusKm: 5000 },
  ]) {
    const r = await req(user.id, 'PUT', '/profile', { workspaceId: workspace.id, ...bad })
    assert.equal(r.status, 400, JSON.stringify(bad))
  }
})

test('profile: a plain member can read but not change it', async () => {
  const { workspace } = await seedUserWithWorkspace('owner1@x.test')
  const member = await memberOf(workspace.id, 'member1@x.test')
  assert.equal((await req(member.id, 'GET', `/profile?workspaceId=${workspace.id}`)).status, 200)
  assert.equal((await req(member.id, 'PUT', '/profile', { workspaceId: workspace.id, ...PROFILE })).status, 403)
})

test('list: best first, dismissed hidden by default, counts per status, tenant-scoped', async () => {
  const { user, workspace } = await seedUserWithWorkspace('owner2@x.test')
  const other = await seedUserWithWorkspace('other2@x.test')
  await seedOpportunity(workspace.id, { score: 40, title: 'Low' })
  await seedOpportunity(workspace.id, { score: 90, title: 'High' })
  await seedOpportunity(workspace.id, { score: 95, title: 'Dismissed', status: 'DISMISSED' })
  await seedOpportunity(other.workspace.id, { score: 99, title: 'Not yours' })

  const r = await req(user.id, 'GET', `/?workspaceId=${workspace.id}`)
  assert.equal(r.status, 200)
  assert.deepEqual(r.body.opportunities.map((o: { title: string }) => o.title), ['High', 'Low'])
  assert.deepEqual(r.body.counts, { NEW: 2, DISMISSED: 1 })
  assert.equal(r.body.opportunities[0].reasons[0], 'Classified as electrical work')

  const dismissed = await req(user.id, 'GET', `/?workspaceId=${workspace.id}&status=DISMISSED`)
  assert.deepEqual(dismissed.body.opportunities.map((o: { title: string }) => o.title), ['Dismissed'])

  assert.equal((await req(user.id, 'GET', `/?workspaceId=${other.workspace.id}`)).status, 403)
})

test('status: a member moves an opportunity through the workflow; cross-tenant ids 404', async () => {
  const { workspace } = await seedUserWithWorkspace('owner3@x.test')
  const member = await memberOf(workspace.id, 'member3@x.test')
  const other = await seedUserWithWorkspace('other3@x.test')
  const o = await seedOpportunity(workspace.id)

  const r = await req(member.id, 'PATCH', `/${o.id}/status`, { workspaceId: workspace.id, status: 'PURSUING' })
  assert.equal(r.status, 200)
  const row = await prisma.opportunity.findUniqueOrThrow({ where: { id: o.id } })
  assert.equal(row.status, 'PURSUING')
  assert.equal(row.statusChangedByUserId, member.id)
  const audit = await prisma.auditEvent.findFirst({ where: { type: 'discovery.opportunity_status', entityId: o.id } })
  assert.deepEqual(audit?.metadata, { from: 'NEW', to: 'PURSUING' })

  assert.equal((await req(member.id, 'PATCH', `/${o.id}/status`, { workspaceId: workspace.id, status: 'MAYBE' })).status, 400)
  // Another tenant can't touch it even by id.
  assert.equal((await req(other.user.id, 'PATCH', `/${o.id}/status`, { workspaceId: other.workspace.id, status: 'DISMISSED' })).status, 404)
})

test('create-job: only a WON opportunity becomes a Field Ops job site, once', async () => {
  const { user, workspace } = await seedUserWithWorkspace('owner4@x.test')
  const member = await memberOf(workspace.id, 'member4@x.test')
  const o = await seedOpportunity(workspace.id, { title: 'Electrical upgrade — Brisbane office' })

  assert.equal((await req(user.id, 'POST', `/${o.id}/create-job`, { workspaceId: workspace.id })).status, 409, 'not won yet')
  await prisma.opportunity.update({ where: { id: o.id }, data: { status: 'WON' } })
  assert.equal((await req(member.id, 'POST', `/${o.id}/create-job`, { workspaceId: workspace.id })).status, 403, 'ops:manage required')

  const r = await req(user.id, 'POST', `/${o.id}/create-job`, { workspaceId: workspace.id })
  assert.equal(r.status, 201)
  const site = await prisma.opsJobSite.findUniqueOrThrow({ where: { id: r.body.jobSite.id } })
  assert.equal(site.siteName, 'Electrical upgrade — Brisbane office')
  assert.equal(site.location, '1 Example St, Brisbane QLD 4000')
  assert.match(site.jobCode, /^OPP-/)
  assert.match(site.notes ?? '', /Acme Builders/)
  assert.equal((await prisma.opportunity.findUniqueOrThrow({ where: { id: o.id } })).opsJobSiteId, site.id)

  assert.equal((await req(user.id, 'POST', `/${o.id}/create-job`, { workspaceId: workspace.id })).status, 409, 'only once')
  assert.equal(await prisma.opsJobSite.count(), 1)
})

test('create-job: a clashing job code is a 409 and leaves nothing half-done', async () => {
  const { user, workspace } = await seedUserWithWorkspace('owner5@x.test')
  await prisma.opsJobSite.create({ data: { workspaceId: workspace.id, jobCode: 'J-1', siteName: 'Existing' } })
  const o = await seedOpportunity(workspace.id, { status: 'WON' })
  const r = await req(user.id, 'POST', `/${o.id}/create-job`, { workspaceId: workspace.id, jobCode: 'J-1' })
  assert.equal(r.status, 409)
  assert.equal((await prisma.opportunity.findUniqueOrThrow({ where: { id: o.id } })).opsJobSiteId, null)
})

test('run: admin-only, needs the server flag and a profile with sources', async () => {
  const { user, workspace } = await seedUserWithWorkspace('owner6@x.test')
  const member = await memberOf(workspace.id, 'member6@x.test')
  assert.equal((await req(member.id, 'POST', '/run', { workspaceId: workspace.id })).status, 403)
  const off = await req(user.id, 'POST', '/run', { workspaceId: workspace.id })
  assert.equal(off.status, 503)
  assert.match(off.body.error, /turned off/)

  process.env.OPPORTUNITY_DISCOVERY_ENABLED = 'true'
  const noProfile = await req(user.id, 'POST', '/run', { workspaceId: workspace.id })
  assert.equal(noProfile.status, 409)
})
