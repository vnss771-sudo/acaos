import test from 'node:test'
import assert from 'node:assert/strict'
import { scoreOpportunity, valueScore, type ScorecardInput } from '../packages/backend-core/src/lib/opportunityScoring.ts'
import type { CommercialEventHypothesis, CommercialEventKind } from '../packages/backend-core/src/lib/commercialEventEngine.ts'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 9, 2)

function event(kind: CommercialEventKind, over: Partial<CommercialEventHypothesis> = {}): CommercialEventHypothesis {
  const family: CommercialEventHypothesis['family'] = kind === 'TENDER_OPPORTUNITY' ? 'ACTIVE_PROCUREMENT' : kind === 'EARLY_TRIGGER' ? 'EARLY_BUYING_TRIGGER' : 'CAPACITY_EXPANSION'
  return {
    kind, family, title: kind, implication: 'x', whyNow: 'y', confidence: 85, independentSources: 3, trustworthySignals: 2,
    corroborated: true, supportingTypes: ['HIRING'],
    evidence: [{ signalId: 's1', signalType: 'HIRING', claim: 'c', source: 's', sourceKey: 'host:s', sourceUrl: null, eventDate: new Date(NOW - 2 * DAY).toISOString(), quality: 80, grade: 'HIGH', trustworthy: true }],
    ...over,
  }
}

function input(over: Partial<ScorecardInput> = {}): ScorecardInput {
  return {
    event: event('CAPACITY_SHORTAGE'), confidence: 85, evidenceConfidence: 80,
    offerFit: { score: 80, reason: 'fits' }, signalIntent: 70, velocity: [], urgencyMatched: [],
    contact: { name: 'Sam', email: 'sam@x.example', title: 'Operations Manager', targetTitles: ['Operations Manager'] },
    deal: { minCents: 4_000_000, maxCents: 8_000_000, minimumCents: null },
    now: NOW,
    ...over,
  }
}

test('value is log-scaled from the deal value, with its basis', () => {
  assert.equal(valueScore(null), 0)
  assert.equal(valueScore(100_000), 25)       // $1k
  assert.equal(valueScore(1_000_000), 50)     // $10k
  assert.equal(valueScore(10_000_000), 75)    // $100k
  assert.equal(valueScore(100_000_000), 100)  // $1M

  const range = scoreOpportunity(input()).value
  assert.equal(range.basis, 'OFFER_RANGE')
  assert.equal(range.midCents, 6_000_000)
  assert.equal(range.reason, 'Typical deal $40k–$80k')
  const minimum = scoreOpportunity(input({ deal: { minCents: null, maxCents: null, minimumCents: 2_500_000 } })).value
  assert.equal(minimum.basis, 'OFFER_MINIMUM')
  assert.equal(minimum.midCents, 2_500_000)
  const unknown = scoreOpportunity(input({ deal: { minCents: null, maxCents: null, minimumCents: null } }))
  assert.equal(unknown.value.basis, 'UNKNOWN')
  assert.equal(unknown.expectedValueCents, null)
})

test('expected value = mid deal value × probability', () => {
  const s = scoreOpportunity(input())
  assert.equal(s.expectedValueCents, Math.round(6_000_000 * s.probability))
  assert.ok(s.probability > 0 && s.probability < 1)
})

test('competition: an open tender is harder to win than an early-spotted shortage, and lowers probability', () => {
  const tender = scoreOpportunity(input({ event: event('TENDER_OPPORTUNITY') }))
  const shortage = scoreOpportunity(input({ event: event('CAPACITY_SHORTAGE') }))
  assert.ok(tender.competition.score > shortage.competition.score)
  assert.match(tender.competition.reason, /tender/i)
  // Tender intent is higher (procurement family), yet competition outweighs it here.
  assert.ok(tender.intent.score > shortage.intent.score)
  assert.ok(tender.probability < shortage.probability, `${tender.probability} vs ${shortage.probability}`)
})

test('contactability: reaching the target buyer beats any contact, which beats none', () => {
  const target = scoreOpportunity(input())
  const other = scoreOpportunity(input({ contact: { name: 'Jo', email: 'jo@x.example', title: 'Receptionist', targetTitles: ['Operations Manager'] } }))
  const none = scoreOpportunity(input({ contact: { targetTitles: ['Operations Manager'] } }))
  assert.ok(target.contactability.score > other.contactability.score && other.contactability.score > none.contactability.score)
  assert.match(target.contactability.reason, /is the target buyer/)
  assert.match(none.contactability.reason, /find the decision maker/)
  assert.ok(target.probability > none.probability)
})

test('timing is measured from the assessment time, and urgency wording raises it', () => {
  const fresh = scoreOpportunity(input())
  assert.equal(fresh.timing.score, 100)
  assert.equal(fresh.urgency, 'HIGH')
  const old = event('CAPACITY_SHORTAGE', { evidence: [{ ...event('CAPACITY_SHORTAGE').evidence[0], eventDate: new Date(NOW - 40 * DAY).toISOString() }] })
  const aged = scoreOpportunity(input({ event: old }))
  assert.equal(aged.timing.score, 45)
  assert.equal(aged.urgency, 'LOW')
  assert.match(aged.timing.reason, /40 days old/)
  const urged = scoreOpportunity(input({ event: old, urgencyMatched: ['immediate start'] }))
  assert.equal(urged.timing.score, 55)
  assert.equal(urged.urgency, 'MEDIUM')
})

test('priority = value × probability × urgency', () => {
  const base = scoreOpportunity(input())
  const smaller = scoreOpportunity(input({ deal: { minCents: 100_000, maxCents: 200_000, minimumCents: null } }))
  const lessLikely = scoreOpportunity(input({ confidence: 50 }))
  const later = scoreOpportunity(input({ event: event('CAPACITY_SHORTAGE', { evidence: [{ ...event('CAPACITY_SHORTAGE').evidence[0], eventDate: new Date(NOW - 20 * DAY).toISOString() }] }) }))
  assert.ok(base.priority > smaller.priority, 'value')
  assert.ok(base.priority > lessLikely.priority, 'probability')
  assert.ok(base.priority > later.priority, 'urgency')
  assert.ok(base.priority <= 100 && smaller.priority >= 0)
})

test('every dimension carries a reason', () => {
  const s = scoreOpportunity(input({ velocity: [{ type: 'HIRING', windowDays: 30, recentCount: 22, priorCount: 5, changePct: 340, trend: 'ACCELERATING', summary: 'Hiring signals up 340% over 30 days (22 vs 5)' }] }))
  for (const k of ['value', 'intent', 'timing', 'offerFit', 'evidenceConfidence', 'contactability', 'competition'] as const) {
    assert.ok(s[k].reason.length > 0, k)
    assert.ok(s[k].score >= 0 && s[k].score <= 100, k)
  }
  assert.match(s.intent.reason, /hiring signals up 340%/)
  assert.match(scoreOpportunity(input({ event: event('EARLY_TRIGGER', { corroborated: false }) })).evidenceConfidence.reason, /Not yet corroborated/)
})

test('scoring is deterministic', () => {
  assert.deepEqual(scoreOpportunity(input()), scoreOpportunity(input()))
})
