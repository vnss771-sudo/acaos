import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateOffer, offerFromMission, offerFromRow, containsPhrase, type OfferRow } from '../packages/backend-core/src/lib/offerModel.ts'
import { scoreOfferFit } from '../packages/backend-core/src/lib/offerIntelligence.ts'
import { inferCommercialEvent } from '../packages/backend-core/src/lib/commercialEvent.ts'
import { toRawFromCanonical, type CanonicalSignal } from '../packages/backend-core/src/lib/signalIntelligence.ts'

const DAY = 86_400_000
let n = 0
function sig(type: CanonicalSignal['type'], title: string, description = ''): CanonicalSignal {
  return {
    id: `s${++n}`, type, source: 'test', observedAt: new Date(Date.now() - 2 * DAY), publishedAt: null,
    entity: { prospectId: 'p', companyName: 'Co' }, title, description, sourceUrl: null, rawValue: null,
    normalizedValue: 80, sourceReliability: 90, relevance: 90, evidence: null,
  }
}

function row(over: Partial<OfferRow> = {}): OfferRow {
  return {
    id: 'o1', missionId: null, name: 'Temporary field crews', problemSolved: 'Short-notice field labour for expanding contractors',
    targetCustomer: 'electrical contractors', targetBuyerTitles: ['Operations Manager'],
    triggeringEvents: ['CAPACITY_EXPANSION'], qualifyingKeywords: ['field technicians', 'new depot'],
    disqualifyingKeywords: [], geographies: [], minOpportunityValueCents: null, dealValueMinCents: 4_000_000,
    dealValueMaxCents: 8_000_000, urgencyIndicators: ['urgently'], proofPoints: [], recommendedActions: [],
    ...over,
  }
}

const expansion = [
  sig('EXPANSION', 'New depot opened in Brisbane', 'Expanded field operations'),
  sig('HIRING', 'Urgently hiring field technicians', '17 roles'),
]
const event = inferCommercialEvent(expansion.map(toRawFromCanonical))

test('a triggering event plus qualifying evidence is a high fit', () => {
  assert.equal(event.type, 'CAPACITY_EXPANSION')
  const e = evaluateOffer(offerFromRow(row()), { event, signals: expansion, prospect: {} })
  assert.equal(e.eventTriggered, true)
  assert.deepEqual(e.matchedQualifying.sort(), ['field technicians', 'new depot'])
  assert.deepEqual(e.urgencyMatched, ['urgently'])
  assert.equal(e.level, 'HIGH')
  assert.ok(e.reasons.some(r => r.includes('triggering event')))
})

test('an event the offer is not triggered by lowers the fit', () => {
  const triggered = evaluateOffer(offerFromRow(row()), { event, signals: expansion, prospect: {} })
  const other = evaluateOffer(offerFromRow(row({ triggeringEvents: ['ACTIVE_PROCUREMENT'] })), { event, signals: expansion, prospect: {} })
  assert.equal(other.eventTriggered, false)
  assert.equal(triggered.score - other.score, 35)
})

test('keywords match whole phrases only', () => {
  assert.equal(containsPhrase('new pool in liverpool', 'pool'), true)
  assert.equal(containsPhrase('liverpool office', 'pool'), false)
  assert.equal(containsPhrase('a new depot.', 'new depot'), true)
})

test('a disqualifier caps the fit however strong the match', () => {
  const e = evaluateOffer(offerFromRow(row({ disqualifyingKeywords: ['brisbane'] })), { event, signals: expansion, prospect: {} })
  assert.deepEqual(e.disqualifiedBy, ['brisbane'])
  assert.ok(e.score <= 10)
  assert.equal(e.level, 'LOW')
})

test('geography: outside caps the fit, unknown location is neutral', () => {
  const offer = offerFromRow(row({ geographies: ['NSW', 'Sydney'] }))
  const outside = evaluateOffer(offer, { event, signals: expansion, prospect: { location: 'Brisbane, QLD' } })
  const inside = evaluateOffer(offer, { event, signals: expansion, prospect: { location: 'Parramatta, NSW' } })
  const unknown = evaluateOffer(offer, { event, signals: expansion, prospect: { location: null } })
  assert.equal(outside.geoMatch, false)
  assert.ok(outside.score <= 20)
  assert.equal(inside.geoMatch, true)
  assert.equal(unknown.geoMatch, null)
  assert.ok(inside.score > unknown.score)
})

test('a mission free-text offer keeps the phase-3 lexical fit', () => {
  const mission = { id: 'm1', name: 'Grow', offer: 'temporary field crews for expanding operations', targetCustomer: 'electrical contractors' }
  const viaModel = evaluateOffer(offerFromMission(mission), { event, signals: expansion, prospect: {} })
  const direct = scoreOfferFit({ offer: mission.offer, targetCustomer: mission.targetCustomer }, event, expansion.map(toRawFromCanonical))
  assert.equal(viaModel.score, direct.score)
  assert.deepEqual(viaModel.reasons, direct.reasons)
  assert.equal(offerFromMission(mission).key, 'mission:m1')
})

test('offerFromRow drops unknown triggering events', () => {
  const def = offerFromRow(row({ triggeringEvents: ['CAPACITY_EXPANSION', 'NOT_A_THING', 'NO_CLEAR_EVENT'] }))
  assert.deepEqual(def.triggeringEvents, ['CAPACITY_EXPANSION'])
  assert.equal(def.key, 'offer:o1')
  assert.equal(def.structured, true)
})
