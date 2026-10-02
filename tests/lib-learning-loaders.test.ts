// The DB-bound learning loaders (outcome graph, causes, calibration, network)
// against the fake Prisma client: shape and wiring. The full behaviour runs
// against Postgres in tests-db/.
import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createFakePrisma, installPrisma, resetPrisma } from './helpers/integration.ts'
import { loadOutcomeChain, loadOutcomeSummary } from '../packages/backend-core/src/lib/outcomeGraphStore.ts'
import { learnFromOutcomes } from '../packages/backend-core/src/lib/outcomeLearning.ts'
import { loadCalibration, learnSignalCalibration } from '../packages/backend-core/src/lib/calibrationLearning.ts'
import { computeNetworkBenchmarks } from '../packages/backend-core/src/lib/networkIntelligence.ts'

afterEach(() => resetPrisma())

const DAY = 86_400_000
const NOW = new Date('2026-10-01T00:00:00Z')
const opp = (id: string, status: string, eventType = 'CAPACITY_EXPANSION') => ({
  id, prospectId: `p-${id}`, status, statusChangedAt: new Date(NOW.getTime() - DAY), firstDetectedAt: new Date(NOW.getTime() - 20 * DAY),
  eventTitle: eventType, eventType, offerKey: 'offer:a', buyingStage: 'ACTIVE_REQUIREMENT', competition: 30, contactability: 80,
  intelligenceGate: true, evidence: [{ eventDate: new Date(NOW.getTime() - 25 * DAY).toISOString() }, { eventDate: 'not a date' }],
  commercialEvent: { status: 'ACTIVE' },
})

function install(opps: ReturnType<typeof opp>[], extra: Record<string, unknown> = {}) {
  const f = createFakePrisma({
    commercialOpportunity: {
      findMany: async () => opps,
      findFirst: async (args: { where: { id: string } }) => opps.find(o => o.id === args.where.id) ?? null,
    },
    recommendation: { findMany: async () => [{ id: 'r1', createdAt: new Date(NOW.getTime() - 19 * DAY), actionText: 'Contact now', commercialOpportunityId: 'o1' }] },
    outreachIntent: { findMany: async () => [{ id: 'i1', status: 'SENT', createdAt: new Date(NOW.getTime() - 18 * DAY), approvedAt: new Date(NOW.getTime() - 18 * DAY), commercialOpportunityId: 'o1', grounding: { grounded: true } }] },
    outreachSent: { findMany: async () => [{ id: 's1', outreachIntentId: 'i1', status: 'SENT', sentAt: new Date(NOW.getTime() - 30 * DAY), repliedAt: null, replyIntent: null, replyIsAutoReply: null }] },
    prospectOutcome: { findMany: async () => [] },
    commercialEvent: { findMany: async () => opps.map(o => ({ prospectId: o.prospectId, kind: o.eventType, firstDetectedAt: o.firstDetectedAt })) },
    scoringModel: { findUnique: async () => null },
    learningRecommendation: { findMany: async () => [], create: async () => ({}), updateMany: async () => ({ count: 0 }) },
    workspace: { findMany: async () => [] },
    networkBenchmark: { deleteMany: async () => ({ count: 0 }), createMany: async () => ({ count: 0 }) },
    ...extra,
  } as never)
  ;(f as unknown as { $transaction: (fn: (tx: unknown) => unknown) => unknown }).$transaction = (fn) => fn(f)
  installPrisma(f)
  return f
}

test('outcome chain and summary: a stalled send is attributed to a cause', async () => {
  install([opp('o1', 'OPEN'), opp('o2', 'LOST', 'TENDER_OPPORTUNITY')])
  const one = await loadOutcomeChain('w1', 'o1', { now: NOW })
  assert.ok(one)
  assert.deepEqual(new Set(one.chain.nodes.map(n => n.stage)), new Set(['DETECTED', 'RECOMMENDED', 'PROPOSED', 'APPROVED', 'SENT']))
  assert.equal(one.cause?.cause, 'BAD_MESSAGE')
  assert.equal(await loadOutcomeChain('w1', 'missing', { now: NOW }), null)

  const sum = await loadOutcomeSummary('w1', { now: NOW, since: new Date(0) })
  assert.equal(sum.opportunities, 2)
  assert.deepEqual([sum.causes.BAD_MESSAGE, sum.causes.UNKNOWN], [1, 1])
  assert.equal(sum.truncated, false)
})

test('learning loaders: off writes nothing; shadow proposes from what clears the bars', async () => {
  let f = install([opp('o1', 'OPEN'), opp('o2', 'LOST', 'TENDER_OPPORTUNITY')])
  assert.equal((await learnFromOutcomes('w1', { mode: 'off' })).learned, false)
  assert.equal((await learnSignalCalibration('w1', { mode: 'off' })).learned, false)

  const causes = await learnFromOutcomes('w1', { mode: 'shadow', now: NOW, minSample: 1 })
  assert.equal(causes.attributed, 2)
  assert.equal(causes.proposed, 1)
  assert.equal(f.callsTo('learningRecommendation', 'create').length, 1)

  // Calibration: one closed loss and no win — a report, but nothing to propose.
  f = install([opp('o1', 'OPEN'), opp('o2', 'LOST', 'TENDER_OPPORTUNITY')])
  const cal = await loadCalibration('w1', { now: NOW })
  assert.deepEqual([cal.report.closed, cal.report.won], [1, 0])
  assert.deepEqual(cal.proposedWeights, {})
  assert.deepEqual(await learnSignalCalibration('w1', { mode: 'shadow', now: NOW }), { learned: true, closed: 1, proposed: 0, superseded: 0 })
  assert.equal(f.callsTo('learningRecommendation', 'create').length, 0)

  // Enough closed outcomes with a win: weights are proposed.
  const many = [...Array.from({ length: 5 }, (_, i) => opp(`w${i}`, 'WON')), ...Array.from({ length: 5 }, (_, i) => opp(`l${i}`, 'LOST', 'TENDER_OPPORTUNITY'))]
  f = install(many)
  const r = await learnSignalCalibration('w1', { mode: 'shadow', now: NOW })
  assert.deepEqual([r.closed, r.proposed], [10, 1])
  assert.equal(f.callsTo('learningRecommendation', 'create').length, 1)
})

test('network recompute pools each opted-in workspace in its own context', async () => {
  const f = install([opp('o1', 'WON')], { workspace: { findMany: async () => [{ id: 'w1' }, { id: 'w2' }] } })
  const r = await computeNetworkBenchmarks({ now: NOW })
  assert.deepEqual(r, { workspaces: 2, published: 0, withheld: 1 }, 'two workspaces are below the floor of five')
  assert.equal(f.callsTo('networkBenchmark', 'createMany').length, 0)
})
