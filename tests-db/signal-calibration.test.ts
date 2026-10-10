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
async function seedClosed(workspaceId: string, eventType: string, status: 'WON' | 'LOST', closedDaysAgo = 2) {
  const closed = Date.now() - closedDaysAgo * DAY
  const p = await prisma.prospect.create({ data: { workspaceId, companyName: `Co ${++n}` } })
  await prisma.commercialEvent.create({
    data: {
      workspaceId, prospectId: p.id, kind: eventType, family: 'CAPACITY_EXPANSION', title: eventType, implication: '', whyNow: '',
      confidence: 80, independentSources: 2, trustworthySignals: 2, corroborated: true, status: 'ACTIVE',
      firstDetectedAt: new Date(closed - 20 * DAY), lastConfirmedAt: new Date(), lastAssessedAt: new Date(),
    },
  })
  await prisma.commercialOpportunity.create({
    data: {
      workspaceId, prospectId: p.id, offerKey: 'offer:x', eventType, eventTitle: eventType, whyNow: '', confidence: 80,
      evidenceConfidence: 80, independentSources: 2, trustworthySignals: 2, offerFit: 80, intentScore: 70, timingScore: 70,
      contactability: 80, probability: 0.4, urgency: 'MEDIUM', priority: 50, buyingStage: 'ACTIVE_REQUIREMENT',
      recommendedAction: 'CONTACT_NOW', actionLabel: 'Contact now', actionReason: 'x', blockers: [], reasons: [], evidence: [], velocity: [],
      intelligenceGate: true, status, statusChangedAt: new Date(closed), firstDetectedAt: new Date(closed - 10 * DAY),
    },
  })
}

/** One batch of 12: capacity expansions mostly win, tenders mostly lose, each closing on its own day. */
async function seedBatch(workspaceId: string, startDaysAgo: number) {
  const rows: Array<[string, 'WON' | 'LOST']> = [
    ...Array.from({ length: 5 }, () => ['CAPACITY_EXPANSION', 'WON'] as [string, 'WON']), ['CAPACITY_EXPANSION', 'LOST'],
    ['TENDER_OPPORTUNITY', 'WON'], ...Array.from({ length: 5 }, () => ['TENDER_OPPORTUNITY', 'LOST'] as [string, 'LOST']),
  ]
  // Interleave kinds so any window holds both.
  const order = [0, 6, 1, 7, 2, 8, 3, 9, 4, 10, 5, 11]
  for (const [d, i] of order.entries()) await seedClosed(workspaceId, rows[i][0], rows[i][1], startDaysAgo - d)
}

/** Two batches with the same pattern, so the older outcomes predict the newer ones (UQ-29 holdout). */
async function seedHistory(workspaceId: string) {
  await seedBatch(workspaceId, 60)
  await seedBatch(workspaceId, 30)
}

test('calibration proposes event-kind weights for approval only; approval feeds scoring; revert restores', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  await seedHistory(workspace.id)

  // The read-only report.
  const res = await opps.request(`/api/commercial-opportunities/calibration?workspaceId=${workspace.id}`, { headers: { Authorization: bearer(user.id) } })
  assert.equal(res.status, 200)
  const body = res.body as { report: { closed: number; won: number; funnels: Array<{ eventType: string; winRate: number }> }; currentWeights: object; proposedWeights: Record<string, number> }
  assert.deepEqual([body.report.closed, body.report.won], [24, 12])
  assert.equal(body.report.funnels.find(f => f.eventType === 'CAPACITY_EXPANSION')?.winRate, 0.833)
  assert.deepEqual(body.currentWeights, {})
  assert.ok(body.proposedWeights.CAPACITY_EXPANSION > 1 && body.proposedWeights.TENDER_OPPORTUNITY < 1)

  // off: nothing.
  assert.equal((await learnSignalCalibration(workspace.id, { mode: 'off' })).learned, false)
  assert.equal(await prisma.learningRecommendation.count({ where: { workspaceId: workspace.id } }), 0)

  // live: still PENDING — never applied without a human.
  const r = await learnSignalCalibration(workspace.id, { mode: 'live' })
  assert.deepEqual([r.closed, r.proposed], [24, 1])
  const rec = await prisma.learningRecommendation.findFirstOrThrow({ where: { workspaceId: workspace.id, type: 'EVENT_KIND_WEIGHT' } })
  assert.equal(rec.status, 'PENDING')
  assert.deepEqual(rec.currentValue, {})
  assert.deepEqual(rec.proposedValue, body.proposedWeights)
  // UQ-29: fitted on the older outcomes, it beat the current (neutral) weights on the newest ones.
  const heldOut = (rec.evidence as { heldOut: { verdict: string; holdoutSize: number; trainSize: number } }).heldOut
  assert.deepEqual([heldOut.verdict, heldOut.holdoutSize, heldOut.trainSize], ['IMPROVED', 10, 14])
  assert.equal(await prisma.scoringModel.count({ where: { workspaceId: workspace.id } }), 0)
  assert.deepEqual(await learnSignalCalibration(workspace.id, { mode: 'live' }), { learned: true, closed: 24, proposed: 0, superseded: 0 })

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

test('UQ-29: an untested or non-improving event-weight proposal cannot be approved, and an untested one is regenerated', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  // Twelve outcomes all closing together: too few to hold any back.
  for (let i = 0; i < 5; i++) await seedClosed(workspace.id, 'CAPACITY_EXPANSION', 'WON')
  await seedClosed(workspace.id, 'CAPACITY_EXPANSION', 'LOST')
  await seedClosed(workspace.id, 'TENDER_OPPORTUNITY', 'WON')
  for (let i = 0; i < 5; i++) await seedClosed(workspace.id, 'TENDER_OPPORTUNITY', 'LOST')
  await learnSignalCalibration(workspace.id, { mode: 'live' })
  const rec = await prisma.learningRecommendation.findFirstOrThrow({ where: { workspaceId: workspace.id, type: 'EVENT_KIND_WEIGHT', status: 'PENDING' } })
  assert.equal((rec.evidence as { heldOut: { verdict: string } }).heldOut.verdict, 'INSUFFICIENT')
  await assert.rejects(
    decideRecommendation({ workspaceId: workspace.id, recommendationId: rec.id, actorUserId: user.id, action: 'approve' }),
    (e: unknown) => (e as { status?: number }).status === 409 && /did not beat the current weights \(insufficient\)/.test((e as Error).message),
  )
  assert.equal(await prisma.scoringModel.count({ where: { workspaceId: workspace.id } }), 0, 'nothing applied')

  // A proposal from before held-out testing: refused, then replaced by a tested one.
  const evidence = { ...(rec.evidence as Record<string, unknown>) }
  delete evidence.heldOut
  await prisma.learningRecommendation.update({ where: { id: rec.id }, data: { evidence: evidence as object } })
  await assert.rejects(
    decideRecommendation({ workspaceId: workspace.id, recommendationId: rec.id, actorUserId: user.id, action: 'approve' }),
    (e: unknown) => (e as { status?: number }).status === 409 && /predates held-out testing/.test((e as Error).message),
  )
  const rerun = await learnSignalCalibration(workspace.id, { mode: 'live' })
  assert.deepEqual([rerun.proposed, rerun.superseded], [1, 1])
  const fresh = await prisma.learningRecommendation.findFirstOrThrow({ where: { workspaceId: workspace.id, type: 'EVENT_KIND_WEIGHT', status: 'PENDING' } })
  assert.ok((fresh.evidence as { heldOut?: unknown }).heldOut)
})
