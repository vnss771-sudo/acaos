// Database-backed tests for phase 11, closed-loop learning
// (lib/outcomeCauses.ts, lib/outcomeLearning.ts, advisory decisions in
// lib/learningDecisions.ts): stalled opportunities are attributed to a cause,
// repeated causes become advisory PENDING proposals, and approving one changes
// nothing.

import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { commercialOpportunitiesRouter } from '../apps/api/src/routes/commercialOpportunities.ts'
import { refreshCommercialOpportunities } from '../packages/backend-core/src/lib/commercialOpportunityStore.ts'
import { learnFromOutcomes } from './helpers/workerJobs.ts'
import { decideRecommendation, DecisionError } from '../packages/backend-core/src/lib/learningDecisions.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace, startTestServer, bearer, type TestServer } from './helpers/db.ts'

let opps: TestServer
before(async () => { opps = await startTestServer('/api/commercial-opportunities', commercialOpportunitiesRouter) })
after(async () => { await opps.close(); await disconnect() })
beforeEach(async () => { await resetDb() })

const DAY = 86_400_000
const auth = (userId: string) => ({ Authorization: bearer(userId) })

/** A corroborated opportunity whose outreach went out 30 days ago and got no reply. */
async function seedStalled(workspaceId: string, companyName: string) {
  const p = await prisma.prospect.create({
    data: { workspaceId, companyName, industry: 'Electrical contractor', contactName: 'Sam Lee', contactEmail: `sam@${companyName.length}.example`, contactTitle: 'Operations Manager' },
  })
  const at = new Date(Date.now() - 3 * DAY)
  for (const [i, r] of [
    { type: 'EXPANSION' as const, title: 'New depot opened in Brisbane', host: 'news.example.org' },
    { type: 'HIRING' as const, title: 'Hiring 17 field technicians', host: 'jobs.example.com' },
  ].entries()) {
    const url = `https://${r.host}/${companyName}-${i}`
    const ev = await prisma.evidenceSource.create({ data: { workspaceId, prospectId: p.id, provider: r.host, sourceType: 'news', sourceUrl: url, observedAt: at, confidence: 0.9 } })
    await prisma.signal.create({
      data: {
        workspaceId, prospectId: p.id, evidenceSourceId: ev.id, type: r.type, strength: 85, sourceReliability: 90, industryRelevance: 85,
        title: r.title, description: `${r.title} — with 2 supporting details`, sourceUrl: url, source: r.host, detectedAt: at,
      },
    })
  }
  if (!await prisma.offer.findFirst({ where: { workspaceId } })) {
    await prisma.offer.create({
      data: {
        workspaceId, name: 'Temporary field crews', targetBuyerTitles: ['Operations Manager'], triggeringEvents: ['CAPACITY_EXPANSION'],
        qualifyingKeywords: ['field technicians', 'new depot'], dealValueMinCents: 4_000_000, dealValueMaxCents: 8_000_000,
      },
    })
  }
  await refreshCommercialOpportunities(workspaceId, [p.id])
  const opp = await prisma.commercialOpportunity.findFirstOrThrow({ where: { workspaceId, prospectId: p.id } })
  const intent = await prisma.outreachIntent.create({
    data: { workspaceId, prospectId: p.id, commercialOpportunityId: opp.id, status: 'SENT', origin: 'OPPORTUNITY', approvedAt: new Date(Date.now() - 31 * DAY) },
  })
  await prisma.outreachSent.create({ data: { workspaceId, toEmail: p.contactEmail!, status: 'SENT', outreachIntentId: intent.id, sentAt: new Date(Date.now() - 30 * DAY) } })
  return opp
}

test('stalled opportunities get a cause; repeated causes become advisory PENDING proposals', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const seeded = []
  for (const name of ['Alpha Electrical', 'Bravo Electrical', 'Charlie Electrical']) seeded.push(await seedStalled(workspace.id, name))

  // The API attaches the cause to the chain and counts causes in the summary.
  const one = await opps.request(`/api/commercial-opportunities/${seeded[0].id}/outcome?workspaceId=${workspace.id}`, { headers: auth(user.id) })
  assert.equal(one.status, 200)
  const { cause } = one.body as { cause: { cause: string; basis: string; reasons: string[] } }
  assert.deepEqual([cause.cause, cause.basis], ['BAD_MESSAGE', 'STALLED'])
  const sum = await opps.request(`/api/commercial-opportunities/outcomes?workspaceId=${workspace.id}`, { headers: auth(user.id) })
  assert.equal((sum.body as { summary: { causes: Record<string, number> } }).summary.causes.BAD_MESSAGE, 3)

  // off: nothing at all.
  const off = await learnFromOutcomes(workspace.id, { mode: 'off', minSample: 3 })
  assert.equal(off.learned, false)
  assert.equal(await prisma.learningRecommendation.count({ where: { workspaceId: workspace.id } }), 0)

  // live: still only PENDING — advisory proposals are never applied.
  const r = await learnFromOutcomes(workspace.id, { mode: 'live', minSample: 3 })
  assert.equal(r.attributed, 3)
  assert.equal(r.byCause?.BAD_MESSAGE, 3)
  assert.deepEqual([r.proposed, r.findings], [1, 3], 'one review; a finding per event, offer and stage group')
  const recs = await prisma.learningRecommendation.findMany({ where: { workspaceId: workspace.id } })
  assert.equal(recs.length, 1)
  assert.ok(recs.every(x => x.type === 'OPPORTUNITY_CAUSE' && x.status === 'PENDING' && x.mode === 'live' && x.currentValue === null))
  const ev = recs[0].evidence as { findings: Array<{ examples: string[]; share: number; cause: string }> }
  assert.ok(ev.findings.every(f => f.cause === 'BAD_MESSAGE' && f.share === 1))
  assert.deepEqual([...ev.findings[0].examples].sort(), seeded.map(o => o.id).sort())

  // A rerun with the same picture changes nothing.
  const again = await learnFromOutcomes(workspace.id, { mode: 'shadow', minSample: 3 })
  assert.deepEqual([again.proposed, again.superseded], [0, 0])
  // Below the sample bar the old proposals are superseded, none created.
  const fewer = await learnFromOutcomes(workspace.id, { mode: 'shadow', minSample: 10 })
  assert.deepEqual([fewer.proposed, fewer.superseded], [0, 1])
  assert.equal(await prisma.learningRecommendation.count({ where: { workspaceId: workspace.id, status: 'PENDING' } }), 0)
})

test('approving an advisory proposal acknowledges it, changes no configuration, and cannot be reverted', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const icpBefore = await prisma.workspaceICP.findUnique({ where: { workspaceId: workspace.id } })
  const rec = await prisma.learningRecommendation.create({
    data: {
      workspaceId: workspace.id, type: 'OPPORTUNITY_CAUSE', status: 'PENDING', mode: 'shadow', sampleSize: 12,
      proposedValue: { cause: 'WRONG_TIMING', dimension: 'eventType', value: 'HIRING_SURGE', advice: 'Wait' }, evidence: { share: 0.5 },
    },
  })
  const approved = await decideRecommendation({ workspaceId: workspace.id, recommendationId: rec.id, actorUserId: user.id, action: 'approve' })
  assert.equal(approved.status, 'APPROVED')
  assert.equal(approved.decidedBy, user.id)
  assert.deepEqual(await prisma.workspaceICP.findUnique({ where: { workspaceId: workspace.id } }), icpBefore)
  assert.equal(await prisma.scoringModel.count({ where: { workspaceId: workspace.id } }), 0)
  assert.ok(await prisma.auditEvent.findFirst({ where: { workspaceId: workspace.id, type: 'learning.recommendation.approved', entityId: rec.id } }))

  await assert.rejects(
    decideRecommendation({ workspaceId: workspace.id, recommendationId: rec.id, actorUserId: user.id, action: 'revert' }),
    (e: unknown) => e instanceof DecisionError && e.status === 422,
  )
  await assert.rejects(
    decideRecommendation({ workspaceId: workspace.id, recommendationId: rec.id, actorUserId: user.id, action: 'approve' }),
    (e: unknown) => e instanceof DecisionError && e.status === 409,
  )

  // Rejecting and expiry work as for every other proposal.
  const other = await prisma.learningRecommendation.create({
    data: { workspaceId: workspace.id, type: 'OPPORTUNITY_CAUSE', status: 'PENDING', mode: 'shadow', sampleSize: 12, proposedValue: { cause: 'BAD_MESSAGE' }, evidence: {} },
  })
  assert.equal((await decideRecommendation({ workspaceId: workspace.id, recommendationId: other.id, actorUserId: user.id, action: 'reject' })).status, 'REJECTED')
  const old = await prisma.learningRecommendation.create({
    data: { workspaceId: workspace.id, type: 'OPPORTUNITY_CAUSE', status: 'PENDING', mode: 'shadow', sampleSize: 12, proposedValue: { cause: 'WRONG_SIGNAL' }, evidence: {}, createdAt: new Date(Date.now() - 90 * DAY) },
  })
  await assert.rejects(
    decideRecommendation({ workspaceId: workspace.id, recommendationId: old.id, actorUserId: user.id, action: 'approve' }),
    (e: unknown) => e instanceof DecisionError && e.status === 410,
  )
})
