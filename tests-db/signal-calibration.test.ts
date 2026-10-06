// Database-backed tests for phase 12, signal calibration
// (lib/signalCalibration.ts, lib/calibrationLearning.ts, EVENT_KIND_WEIGHT in
// lib/learningDecisions.ts): closed outcomes → a PENDING weight proposal (never
// auto-applied) → human approval → scoring uses the weight → revert.

import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { commercialOpportunitiesRouter } from '../apps/api/src/routes/commercialOpportunities.ts'
import { refreshCommercialOpportunities } from '../packages/backend-core/src/lib/commercialOpportunityStore.ts'
import { learnSignalCalibration } from './helpers/workerJobs.ts'
import { decideRecommendation } from '../packages/backend-core/src/lib/learningDecisions.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace, startTestServer, bearer, type TestServer } from './helpers/db.ts'

let opps: TestServer
before(async () => { opps = await startTestServer('/api/commercial-opportunities', commercialOpportunitiesRouter) })
after(async () => { await opps.close(); await disconnect() })
beforeEach(async () => { await resetDb() })

const DAY = 86_400_000
let n = 0

/** A closed opportunity of the given event kind (rows written directly — the engine isn't under test here). */
async function seedClosed(workspaceId: string, eventType: string, status: 'WON' | 'LOST') {
  const p = await prisma.prospect.create({ data: { workspaceId, companyName: `Co ${++n}` } })
  await prisma.commercialEvent.create({
    data: {
      workspaceId, prospectId: p.id, kind: eventType, family: 'CAPACITY_EXPANSION', title: eventType, implication: '', whyNow: '',
      confidence: 80, independentSources: 2, trustworthySignals: 2, corroborated: true, status: 'ACTIVE',
      firstDetectedAt: new Date(Date.now() - 20 * DAY), lastConfirmedAt: new Date(), lastAssessedAt: new Date(),
    },
  })
  await prisma.commercialOpportunity.create({
    data: {
      workspaceId, prospectId: p.id, offerKey: 'offer:x', eventType, eventTitle: eventType, whyNow: '', confidence: 80,
      evidenceConfidence: 80, independentSources: 2, trustworthySignals: 2, offerFit: 80, intentScore: 70, timingScore: 70,
      contactability: 80, probability: 0.4, urgency: 'MEDIUM', priority: 50, buyingStage: 'ACTIVE_REQUIREMENT',
      recommendedAction: 'CONTACT_NOW', actionLabel: 'Contact now', actionReason: 'x', blockers: [], reasons: [], evidence: [], velocity: [],
      intelligenceGate: true, status, statusChangedAt: new Date(Date.now() - 2 * DAY), firstDetectedAt: new Date(Date.now() - 10 * DAY),
    },
  })
}

async function seedHistory(workspaceId: string) {
  for (let i = 0; i < 5; i++) await seedClosed(workspaceId, 'CAPACITY_EXPANSION', 'WON')
  await seedClosed(workspaceId, 'CAPACITY_EXPANSION', 'LOST')
  await seedClosed(workspaceId, 'TENDER_OPPORTUNITY', 'WON')
  for (let i = 0; i < 5; i++) await seedClosed(workspaceId, 'TENDER_OPPORTUNITY', 'LOST')
}

test('calibration proposes event-kind weights for approval only; approval feeds scoring; revert restores', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  await seedHistory(workspace.id)

  // The read-only report.
  const res = await opps.request(`/api/commercial-opportunities/calibration?workspaceId=${workspace.id}`, { headers: { Authorization: bearer(user.id) } })
  assert.equal(res.status, 200)
  const body = res.body as { report: { closed: number; won: number; funnels: Array<{ eventType: string; winRate: number }> }; currentWeights: object; proposedWeights: Record<string, number> }
  assert.deepEqual([body.report.closed, body.report.won], [12, 6])
  assert.equal(body.report.funnels.find(f => f.eventType === 'CAPACITY_EXPANSION')?.winRate, 0.833)
  assert.deepEqual(body.currentWeights, {})
  assert.ok(body.proposedWeights.CAPACITY_EXPANSION > 1 && body.proposedWeights.TENDER_OPPORTUNITY < 1)

  // off: nothing.
  assert.equal((await learnSignalCalibration(workspace.id, { mode: 'off' })).learned, false)
  assert.equal(await prisma.learningRecommendation.count({ where: { workspaceId: workspace.id } }), 0)

  // live: still PENDING — never applied without a human.
  const r = await learnSignalCalibration(workspace.id, { mode: 'live' })
  assert.deepEqual([r.closed, r.proposed], [12, 1])
  const rec = await prisma.learningRecommendation.findFirstOrThrow({ where: { workspaceId: workspace.id, type: 'EVENT_KIND_WEIGHT' } })
  assert.equal(rec.status, 'PENDING')
  assert.deepEqual(rec.currentValue, {})
  assert.deepEqual(rec.proposedValue, body.proposedWeights)
  assert.equal(await prisma.scoringModel.count({ where: { workspaceId: workspace.id } }), 0)
  assert.deepEqual(await learnSignalCalibration(workspace.id, { mode: 'live' }), { learned: true, closed: 12, proposed: 0, superseded: 0 })

  // Approve: the weights land on the scoring model…
  await decideRecommendation({ workspaceId: workspace.id, recommendationId: rec.id, actorUserId: user.id, action: 'approve' })
  const model = await prisma.scoringModel.findUniqueOrThrow({ where: { workspaceId: workspace.id } })
  assert.deepEqual(model.eventKindWeights, body.proposedWeights)
  // …and nothing new is proposed while the picture is unchanged.
  assert.equal((await learnSignalCalibration(workspace.id, { mode: 'shadow' })).proposed, 0)

  // …and the engine applies them to a fresh opportunity of that kind.
  const p = await prisma.prospect.create({ data: { workspaceId: workspace.id, companyName: 'Fresh Co', contactName: 'Sam', contactEmail: 'sam@fresh.example', contactTitle: 'Operations Manager' } })
  const at = new Date(Date.now() - 3 * DAY)
  for (const [i, s] of [{ type: 'EXPANSION' as const, title: 'New depot opened', host: 'news.example.org' }, { type: 'HIRING' as const, title: 'Hiring 17 field technicians', host: 'jobs.example.com' }].entries()) {
    const url = `https://${s.host}/fresh-${i}`
    const ev = await prisma.evidenceSource.create({ data: { workspaceId: workspace.id, prospectId: p.id, provider: s.host, sourceType: 'news', sourceUrl: url, observedAt: at, confidence: 0.9 } })
    await prisma.signal.create({ data: { workspaceId: workspace.id, prospectId: p.id, evidenceSourceId: ev.id, type: s.type, strength: 85, sourceReliability: 90, industryRelevance: 85, title: s.title, description: `${s.title} — with 2 details`, sourceUrl: url, source: s.host, detectedAt: at } })
  }
  await prisma.offer.create({ data: { workspaceId: workspace.id, name: 'Crews', targetBuyerTitles: ['Operations Manager'], triggeringEvents: ['CAPACITY_EXPANSION'], qualifyingKeywords: ['field technicians'] } })
  await refreshCommercialOpportunities(workspace.id, [p.id])
  const fresh = await prisma.commercialOpportunity.findFirstOrThrow({ where: { workspaceId: workspace.id, prospectId: p.id } })
  assert.equal(fresh.eventType, 'CAPACITY_EXPANSION')
  assert.equal((fresh.scorecard as { calibration: { weight: number } }).calibration.weight, body.proposedWeights.CAPACITY_EXPANSION)

  // Revert restores the previous (empty) weights.
  await decideRecommendation({ workspaceId: workspace.id, recommendationId: rec.id, actorUserId: user.id, action: 'revert' })
  assert.deepEqual((await prisma.scoringModel.findUniqueOrThrow({ where: { workspaceId: workspace.id } })).eventKindWeights, {})
})
