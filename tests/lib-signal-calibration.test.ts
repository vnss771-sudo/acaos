import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildCalibrationReport, eventKindWeight, proposeEventKindWeights, WEIGHT_MAX, WEIGHT_MIN,
  type CalibrationItem,
} from '../packages/backend-core/src/lib/signalCalibration.ts'
import { scoreOpportunity } from '../packages/backend-core/src/lib/opportunityScoring.ts'
import type { CommercialEventHypothesis } from '../packages/backend-core/src/lib/commercialEventEngine.ts'

let n = 0
function item(eventType: string, final: CalibrationItem['final'], over: Partial<CalibrationItem> = {}): CalibrationItem {
  const reached: CalibrationItem['reached'] = final === 'WON' ? ['DETECTED', 'SENT', 'REPLIED', 'MEETING', 'QUOTED', 'WON'] : final === 'LOST' ? ['DETECTED', 'SENT', 'LOST'] : ['DETECTED']
  return { opportunityId: `o${++n}`, eventType, eventKinds: [eventType], reached, final, revenueCents: final === 'WON' ? 1_000_000 : null, ...over }
}
const many = (count: number, f: () => CalibrationItem) => Array.from({ length: count }, f)

test('funnel per event kind: conversations, quotes, wins, revenue, raw and shrunk win rates', () => {
  const items = [
    ...many(6, () => item('TENDER_OPPORTUNITY', 'WON')),
    ...many(4, () => item('TENDER_OPPORTUNITY', 'LOST')),
    ...many(1, () => item('HIRING_SURGE', 'WON')),
    ...many(9, () => item('HIRING_SURGE', 'LOST')),
    item('HIRING_SURGE', null),
  ]
  const r = buildCalibrationReport(items)
  assert.deepEqual([r.closed, r.won, r.baselineWinRate], [20, 7, 0.35])
  const tender = r.funnels.find(f => f.eventType === 'TENDER_OPPORTUNITY')!
  assert.deepEqual([tender.opportunities, tender.conversations, tender.quotes, tender.closed, tender.won, tender.revenueCents], [10, 6, 6, 10, 6, 6_000_000])
  assert.equal(tender.winRate, 0.6)
  assert.equal(tender.conversationRate, 0.6)
  // Shrunk toward 0.35: (6 + 5×0.35) / (10 + 5)
  assert.equal(tender.adjustedWinRate, 0.517)
  const hiring = r.funnels.find(f => f.eventType === 'HIRING_SURGE')!
  assert.equal(hiring.opportunities, 11)
  assert.equal(hiring.winRate, 0.1)
  assert.equal(r.funnels[0].eventType, 'HIRING_SURGE', 'largest first')

  const empty = buildCalibrationReport([item('X', null)])
  assert.equal(empty.baselineWinRate, null)
  assert.equal(empty.funnels[0].winRate, null)
  assert.equal(empty.funnels[0].adjustedWinRate, null)
  assert.deepEqual(empty.combinations, [])
})

test('weights: bounded, shrunk, only for kinds with enough closed outcomes; none without a win', () => {
  const items = [
    ...many(6, () => item('TENDER_OPPORTUNITY', 'WON')), ...many(4, () => item('TENDER_OPPORTUNITY', 'LOST')),
    ...many(1, () => item('HIRING_SURGE', 'WON')), ...many(9, () => item('HIRING_SURGE', 'LOST')),
    ...many(2, () => item('NEW_PROJECT', 'WON')),
  ]
  const r = buildCalibrationReport(items)
  const w = proposeEventKindWeights(r)
  assert.deepEqual(Object.keys(w).sort(), ['HIRING_SURGE', 'TENDER_OPPORTUNITY'], 'NEW_PROJECT has only 2 closed')
  assert.ok(w.TENDER_OPPORTUNITY > 1 && w.TENDER_OPPORTUNITY <= WEIGHT_MAX)
  assert.ok(w.HIRING_SURGE < 1 && w.HIRING_SURGE >= WEIGHT_MIN)
  assert.equal(w.TENDER_OPPORTUNITY, 1.31, '(6 + 5×9/22) / 15 ÷ 9/22')

  // Extreme rates are clamped.
  const extreme = buildCalibrationReport([...many(40, () => item('A', 'WON')), ...many(200, () => item('B', 'LOST'))])
  assert.deepEqual(proposeEventKindWeights(extreme), { A: WEIGHT_MAX, B: WEIGHT_MIN })

  assert.deepEqual(proposeEventKindWeights(buildCalibrationReport(many(10, () => item('A', 'LOST')))), {})
  assert.deepEqual(proposeEventKindWeights(r, { minClosed: 11 }), {})
})

test('combination lift: the base kind with others vs the base kind alone', () => {
  const combo = (final: CalibrationItem['final']) => item('HIRING_SURGE', final, { eventKinds: ['HIRING_SURGE', 'NEW_PROJECT', 'CAPACITY_EXPANSION'] })
  const items = [
    ...many(5, () => combo('WON')), ...many(1, () => combo('LOST')),
    ...many(1, () => item('HIRING_SURGE', 'WON')), ...many(9, () => item('HIRING_SURGE', 'LOST')),
  ]
  const r = buildCalibrationReport(items)
  assert.equal(r.combinations.length, 1)
  const c = r.combinations[0]
  assert.deepEqual(c.kinds, ['CAPACITY_EXPANSION', 'HIRING_SURGE', 'NEW_PROJECT'])
  assert.equal(c.base, 'HIRING_SURGE')
  assert.deepEqual([c.closed, c.won, c.winRate, c.baseAloneWinRate], [6, 5, 0.833, 0.1])
  assert.ok(c.lift > 2, `lift ${c.lift}`)
  // Below the sample bar, no combination is reported.
  assert.deepEqual(buildCalibrationReport(items, { minClosed: 7 }).combinations, [])
})

test('scoring applies the approved weight to probability, bounded, and says so', () => {
  assert.equal(eventKindWeight(null, 'A'), 1)
  assert.equal(eventKindWeight({ A: 1.2 }, 'A'), 1.2)
  assert.equal(eventKindWeight({ A: 9 }, 'A'), WEIGHT_MAX)
  assert.equal(eventKindWeight({ A: Number.NaN }, 'A'), 1)

  const event = {
    kind: 'TENDER_OPPORTUNITY', family: 'ACTIVE_PROCUREMENT', title: 'Tender', implication: '', whyNow: '', confidence: 85,
    independentSources: 3, trustworthySignals: 3, corroborated: true, evidence: [],
  } as unknown as CommercialEventHypothesis
  const input = {
    event, confidence: 85, evidenceConfidence: 80, offerFit: { score: 80, reason: 'fit' }, signalIntent: 70, velocity: [],
    urgencyMatched: [], contact: { name: 'Sam', email: 's@x.example', title: 'Ops', targetTitles: ['Ops'] },
    deal: { minCents: 1_000_000, maxCents: 2_000_000, minimumCents: null }, now: Date.parse('2026-10-01T00:00:00Z'),
  }
  const base = scoreOpportunity(input)
  assert.deepEqual(base.calibration, { weight: 1, reason: 'No calibrated weight for this event kind' })
  const up = scoreOpportunity({ ...input, eventKindWeight: 1.3 })
  assert.ok(up.probability > base.probability)
  assert.match(up.calibration.reason, /tender opportunity has outperformed in this workspace \(×1\.3\)/)
  const down = scoreOpportunity({ ...input, eventKindWeight: 0.5 })
  assert.ok(down.probability < base.probability)
  assert.match(down.calibration.reason, /underperformed/)
  assert.ok(scoreOpportunity({ ...input, confidence: 100, offerFit: { score: 100, reason: '' }, eventKindWeight: 1.5 }).probability <= 1)
})
