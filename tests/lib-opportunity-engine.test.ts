import test from 'node:test'
import assert from 'node:assert/strict'
import { assessOpportunity, UNCORROBORATED_CONFIDENCE_CAP, type OpportunityProspect } from '../packages/backend-core/src/lib/opportunityEngine.ts'
import { offerFromRow, type OfferRow } from '../packages/backend-core/src/lib/offerModel.ts'
import type { CanonicalSignal } from '../packages/backend-core/src/lib/signalIntelligence.ts'

const DAY = 86_400_000
let n = 0
function sig(type: CanonicalSignal['type'], title: string, host: string, over: Partial<CanonicalSignal> = {}): CanonicalSignal {
  const url = `https://${host}/item-${++n}`
  return {
    id: `s${n}`, type, source: host, observedAt: new Date(Date.now() - 3 * DAY), publishedAt: null,
    entity: { prospectId: 'p1', companyName: 'ABC Electrical' }, title, description: `${title} — reported with 2 details`,
    sourceUrl: url, rawValue: null, normalizedValue: 85, sourceReliability: 90, relevance: 85,
    evidence: { provider: host, sourceType: 'news', sourceUrl: url, observedAt: new Date(Date.now() - 3 * DAY), confidence: 0.9 },
    ...over,
  }
}

const offerRow: OfferRow = {
  id: 'o1', missionId: null, name: 'Temporary field crews', problemSolved: 'Short-notice field labour for expanding contractors',
  targetCustomer: 'electrical contractors', targetBuyerTitles: ['Operations Manager'],
  triggeringEvents: ['CAPACITY_EXPANSION', 'ACTIVE_PROCUREMENT'], qualifyingKeywords: ['field technicians', 'new depot', 'project awarded'],
  disqualifyingKeywords: ['in liquidation'], geographies: [], minOpportunityValueCents: null,
  dealValueMinCents: 4_000_000, dealValueMaxCents: 8_000_000, urgencyIndicators: [], proofPoints: [], recommendedActions: [],
}
const offer = offerFromRow(offerRow)

const prospect: OpportunityProspect = {
  id: 'p1', companyName: 'ABC Electrical', industry: 'Electrical contractor', employeeCount: 120, location: 'Brisbane, QLD',
  contactName: 'Sam Lee', contactEmail: 'sam@abc.example', contactTitle: 'Operations Manager', domain: 'abc.example',
}

const corroborated = [
  sig('EXPANSION', 'New depot opened in Brisbane', 'news.example.org'),
  sig('HIRING', 'Hiring 17 field technicians', 'jobs.example.com'),
  sig('PROCUREMENT', '$4.2M project awarded', 'tenders.example.gov'),
]

test('no clear commercial event → no opportunity', () => {
  assert.equal(assessOpportunity({ prospect, signals: [], offer }), null)
  const stale = [sig('HIRING', 'Hiring', 'jobs.example.com', { observedAt: new Date(Date.now() - 120 * DAY), evidence: null })]
  assert.equal(assessOpportunity({ prospect, signals: stale, offer }), null)
})

test('corroborated, fresh evidence that fits the offer → contact now, with traceable evidence', () => {
  const a = assessOpportunity({ prospect, signals: corroborated, offer })
  assert.ok(a)
  assert.equal(a.eventType, 'ACTIVE_PROCUREMENT')
  assert.equal(a.gates.intelligenceTruth, true)
  assert.equal(a.gates.decisionTruth, true)
  assert.equal(a.independentSources, 3)
  assert.ok(a.confidence > UNCORROBORATED_CONFIDENCE_CAP, `confidence ${a.confidence}`)
  assert.equal(a.recommendedAction, 'CONTACT_NOW')
  assert.equal(a.recommendedBuyer, 'Operations Manager')
  assert.equal(a.buyingStage, 'EVALUATING_SOLUTIONS')
  assert.equal(a.estimatedValueMinCents, 4_000_000)
  assert.equal(a.evidence.length, 3)
  assert.ok(a.evidence.every(e => e.signalId && e.sourceUrl && e.trustworthy))
  assert.equal(a.offerKey, 'offer:o1')
  assert.ok(a.reasons.length >= 2)
})

test('gate 1: single-source evidence caps confidence and blocks contact-now', () => {
  const oneSource = corroborated.map(s => ({
    ...s, source: 'news.example.org', sourceUrl: 'https://news.example.org/a',
    evidence: { ...s.evidence!, provider: 'news', sourceUrl: 'https://news.example.org/a' },
  }))
  const a = assessOpportunity({ prospect, signals: oneSource, offer })
  assert.ok(a)
  assert.equal(a.independentSources, 1)
  assert.equal(a.gates.intelligenceTruth, false)
  assert.ok(a.confidence <= UNCORROBORATED_CONFIDENCE_CAP)
  assert.notEqual(a.recommendedAction, 'CONTACT_NOW')
  assert.ok(a.reasons.some(r => r.includes('Single-source')))
})

test('a disqualified offer produces no opportunity, however strong the event', () => {
  const signals = [...corroborated, sig('NEWS_MENTION', 'ABC Electrical in liquidation', 'news2.example.org')]
  assert.equal(assessOpportunity({ prospect, signals, offer }), null)
})

test('unusable evidence cannot manufacture an event', () => {
  const unreliable = corroborated.map(s => ({ ...s, sourceReliability: 10, evidence: { ...s.evidence!, confidence: 0.05 } }))
  assert.equal(assessOpportunity({ prospect, signals: unreliable, offer }), null)
})

test('no reachable buyer → enrich, not outreach', () => {
  const a = assessOpportunity({ prospect: { ...prospect, contactEmail: null, contactName: null, contactTitle: null }, signals: corroborated, offer })
  assert.ok(a)
  assert.equal(a.recommendedAction, 'ENRICH')
  assert.equal(a.contactability, 0)
})

test('priority = value × probability × urgency: a known deal value ranks above an unknown one', () => {
  const known = assessOpportunity({ prospect, signals: corroborated, offer })!
  const unknown = assessOpportunity({ prospect, signals: corroborated, offer: offerFromRow({ ...offerRow, dealValueMinCents: null, dealValueMaxCents: null }) })!
  assert.equal(known.probability, unknown.probability)
  assert.ok(known.priority > unknown.priority, `${known.priority} vs ${unknown.priority}`)
  assert.ok(known.priority > 0 && known.priority <= 100)
})

test('assessment is deterministic', () => {
  const now = Date.now()
  assert.deepEqual(
    assessOpportunity({ prospect, signals: corroborated, offer, now }),
    assessOpportunity({ prospect, signals: corroborated, offer, now }),
  )
})
