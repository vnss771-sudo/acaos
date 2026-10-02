// Database-backed tests for phase 9, intelligence → execution
// (lib/opportunityIntent.ts, lib/draftGrounding.ts): opportunity → bridged
// recommendation → PROPOSED OutreachIntent → grounded draft → approval gate.
// Nothing is sent.

import { test, before, beforeEach, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { commercialOpportunitiesRouter } from '../apps/api/src/routes/commercialOpportunities.ts'
import { prospectsRouter } from '../apps/api/src/routes/prospects/index.ts'
import { refreshCommercialOpportunities } from '../packages/backend-core/src/lib/commercialOpportunityStore.ts'
import { prisma, resetDb, disconnect, seedUser, seedUserWithWorkspace, startTestServer, bearer, type TestServer } from './helpers/db.ts'

let opps: TestServer
let prospects: TestServer
before(async () => {
  opps = await startTestServer('/api/commercial-opportunities', commercialOpportunitiesRouter)
  prospects = await startTestServer('/api/prospects', prospectsRouter)
})
after(async () => { await opps.close(); await prospects.close(); await disconnect() })
beforeEach(async () => { await resetDb() })

const origFetch = globalThis.fetch
const origKey = process.env.OPENAI_API_KEY
afterEach(() => {
  globalThis.fetch = origFetch
  if (origKey === undefined) delete process.env.OPENAI_API_KEY
  else process.env.OPENAI_API_KEY = origKey
})

/** Stub the model to return this draft; every other request goes through. */
function stubDraft(draft: { subject: string; email: string }) {
  process.env.OPENAI_API_KEY = 'sk-test'
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    if (!String(url).includes('openai')) return origFetch(url as string, init)
    const body = JSON.parse(String(init?.body))
    return new Response(JSON.stringify({
      id: 'c1', object: 'chat.completion', created: 0, model: body.model,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(draft) } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
}

const DAY = 86_400_000
const json = (userId: string) => ({ Authorization: bearer(userId), 'Content-Type': 'application/json' })

async function seedOpportunity(workspaceId: string, companyName = 'ABC Electrical') {
  const p = await prisma.prospect.create({
    data: {
      workspaceId, companyName, industry: 'Electrical contractor', location: 'Brisbane, QLD',
      contactName: 'Sam Lee', contactEmail: 'sam@abc.example', contactTitle: 'Operations Manager',
    },
  })
  const at = new Date(Date.now() - 3 * DAY)
  const rows = [
    { type: 'EXPANSION' as const, title: 'New depot opened in Brisbane', host: 'news.example.org' },
    { type: 'HIRING' as const, title: 'Hiring 17 field technicians', host: 'jobs.example.com' },
  ]
  for (const [i, r] of rows.entries()) {
    const url = `https://${r.host}/${companyName.length}-${i}`
    const ev = await prisma.evidenceSource.create({ data: { workspaceId, prospectId: p.id, provider: r.host, sourceType: 'news', sourceUrl: url, observedAt: at, confidence: 0.9 } })
    await prisma.signal.create({
      data: {
        workspaceId, prospectId: p.id, evidenceSourceId: ev.id, type: r.type, strength: 85, sourceReliability: 90,
        industryRelevance: 85, title: r.title, description: `${r.title} — with 2 supporting details`, sourceUrl: url, source: r.host, detectedAt: at,
      },
    })
  }
  if (!await prisma.offer.findFirst({ where: { workspaceId } })) {
    await prisma.offer.create({
      data: {
        workspaceId, name: 'Temporary field crews', problemSolved: 'Short-notice field labour for expanding contractors',
        targetBuyerTitles: ['Operations Manager'], triggeringEvents: ['CAPACITY_EXPANSION'], qualifyingKeywords: ['field technicians', 'new depot'],
        proofPoints: ['Crewed a 40-person shutdown in 10 days'], dealValueMinCents: 4_000_000, dealValueMaxCents: 8_000_000,
      },
    })
  }
  await refreshCommercialOpportunities(workspaceId, [p.id])
  const opp = await prisma.commercialOpportunity.findFirstOrThrow({ where: { workspaceId, prospectId: p.id } })
  return { prospect: p, opp }
}

test('opportunity → PROPOSED intent with evidence and grounding; idempotent; admin only; nothing sent', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const member = await seedUser('member@acme.test', null, { emailVerified: true })
  await prisma.membership.create({ data: { userId: member.id, workspaceId: workspace.id, role: 'member' } })
  const { prospect, opp } = await seedOpportunity(workspace.id)
  assert.equal(opp.recommendationKind, 'CONTACT_NOW')
  const body = JSON.stringify({ workspaceId: workspace.id })

  const denied = await opps.request(`/api/commercial-opportunities/${opp.id}/intent`, { method: 'POST', headers: json(member.id), body })
  assert.equal(denied.status, 403)

  const res = await opps.request(`/api/commercial-opportunities/${opp.id}/intent`, { method: 'POST', headers: json(user.id), body })
  assert.equal(res.status, 201)
  const { intentId, created } = res.body as { intentId: string; created: boolean }
  assert.equal(created, true)

  const intent = await prisma.outreachIntent.findUniqueOrThrow({ where: { id: intentId } })
  const bridge = await prisma.recommendation.findFirstOrThrow({ where: { workspaceId: workspace.id, commercialOpportunityId: opp.id } })
  assert.equal(intent.status, 'PROPOSED')
  assert.equal(intent.origin, 'OPPORTUNITY')
  assert.equal(intent.prospectId, prospect.id)
  assert.equal(intent.commercialOpportunityId, opp.id)
  assert.equal(intent.recommendationId, bridge.id)
  assert.ok(bridge.actedAt, 'the recommendation is frozen once proposed')
  const grounding = intent.grounding as { facts: Array<{ signalId: string; source: string; confidence: number }>; context: string[]; grounded: null }
  const signalIds = (await prisma.signal.findMany({ where: { prospectId: prospect.id }, select: { id: true } })).map(s => s.id)
  assert.ok(grounding.facts.length > 0 && grounding.facts.every(f => signalIds.includes(f.signalId) && f.source && f.confidence > 0))
  assert.ok(grounding.context.includes('Crewed a 40-person shutdown in 10 days'))
  assert.equal(grounding.grounded, null)
  assert.equal((intent.evidenceSnapshot as { recommendationKind: string }).recommendationKind, 'CONTACT_NOW')
  assert.ok(await prisma.auditEvent.findFirst({ where: { type: 'outreachIntent.propose', entityId: intentId } }))

  const again = await opps.request(`/api/commercial-opportunities/${opp.id}/intent`, { method: 'POST', headers: json(user.id), body })
  assert.equal(again.status, 200)
  assert.deepEqual(again.body, { ok: true, created: false, intentId })
  // A rescore leaves the acted-on recommendation alone.
  await refreshCommercialOpportunities(workspace.id, [prospect.id])
  assert.equal(await prisma.outreachIntent.count({ where: { workspaceId: workspace.id } }), 1)
  assert.equal(await prisma.outreachSent.count({ where: { workspaceId: workspace.id } }), 0)
  assert.equal(await prisma.lead.count({ where: { workspaceId: workspace.id } }), 0)
})

test('no intent without a live outreach recommendation', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const body = JSON.stringify({ workspaceId: workspace.id })
  const post = (id: string) => opps.request(`/api/commercial-opportunities/${id}/intent`, { method: 'POST', headers: json(user.id), body })

  assert.equal((await post('missing-opportunity')).status, 404)

  const dismissed = await seedOpportunity(workspace.id, 'Dismissed Co')
  await prisma.commercialOpportunity.update({ where: { id: dismissed.opp.id }, data: { status: 'DISMISSED' } })
  const r1 = await post(dismissed.opp.id)
  assert.equal(r1.status, 409)
  assert.match(String((r1.body as { error: string }).error), /dismissed/)

  const quiet = await seedOpportunity(workspace.id, 'Monitor Co')
  await prisma.commercialOpportunity.update({ where: { id: quiet.opp.id }, data: { recommendation: { ...(quiet.opp.recommendation as object), kind: 'MONITOR', label: 'Monitor', outreach: false } } })
  assert.equal((await post(quiet.opp.id)).status, 409)

  const uncited = await seedOpportunity(workspace.id, 'Uncited Co')
  await prisma.commercialOpportunity.update({ where: { id: uncited.opp.id }, data: { recommendation: { ...(uncited.opp.recommendation as object), citations: [] } } })
  assert.equal((await post(uncited.opp.id)).status, 409)

  const stale = await seedOpportunity(workspace.id, 'Stale Co')
  await prisma.recommendation.updateMany({ where: { workspaceId: workspace.id, commercialOpportunityId: stale.opp.id }, data: { expiresAt: new Date(Date.now() - 1000) } })
  const r2 = await post(stale.opp.id)
  assert.equal(r2.status, 409)
  assert.match(String((r2.body as { error: string }).error), /no longer live/)

  assert.equal(await prisma.outreachIntent.count({ where: { workspaceId: workspace.id } }), 0)
})

test('the draft is checked against the evidence; an ungrounded draft cannot be approved', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const { prospect, opp } = await seedOpportunity(workspace.id)
  const res = await opps.request(`/api/commercial-opportunities/${opp.id}/intent`, { method: 'POST', headers: json(user.id), body: JSON.stringify({ workspaceId: workspace.id }) })
  const { intentId } = res.body as { intentId: string }
  const base = `/api/prospects/${prospect.id}/intents/${intentId}`

  stubDraft({ subject: 'crews for Brisbane', email: 'Saw you are hiring 17 field technicians after landing a $9M contract. Need crews?' })
  const bad = await prospects.request(`${base}/draft`, { method: 'POST', headers: json(user.id) })
  assert.equal(bad.status, 200)
  const badGrounding = (await prisma.outreachIntent.findUniqueOrThrow({ where: { id: intentId } })).grounding as { grounded: boolean; problems: string[]; claims: Array<{ signalId: string }> }
  assert.equal(badGrounding.grounded, false)
  assert.deepEqual(badGrounding.problems, ['States "9m" without evidence'])
  const blocked = await prospects.request(`${base}/approve`, { method: 'POST', headers: json(user.id), body: '{}' })
  assert.equal(blocked.status, 409)
  assert.match(String((blocked.body as { error: string }).error), /9m/)

  stubDraft({ subject: 'crews for Brisbane', email: 'Saw the new depot in Brisbane and that you are hiring 17 field technicians. We crewed a 40-person shutdown in 10 days — useful?' })
  await prospects.request(`${base}/draft`, { method: 'POST', headers: json(user.id) })
  const good = await prisma.outreachIntent.findUniqueOrThrow({ where: { id: intentId } })
  const grounding = good.grounding as { grounded: boolean; claims: Array<{ claim: string; signalId: string; source: string; confidence: number }> }
  assert.equal(grounding.grounded, true)
  assert.ok(grounding.claims.length >= 2 && grounding.claims.every(c => c.signalId && c.source && c.confidence > 0))
  assert.equal(good.status, 'DRAFTED')

  const approved = await prospects.request(`${base}/approve`, { method: 'POST', headers: json(user.id), body: '{}' })
  assert.equal(approved.status, 200)
  assert.equal((await prisma.outreachIntent.findUniqueOrThrow({ where: { id: intentId } })).status, 'APPROVED')
  assert.equal(await prisma.outreachSent.count({ where: { workspaceId: workspace.id } }), 0, 'approval alone sends nothing')
})
