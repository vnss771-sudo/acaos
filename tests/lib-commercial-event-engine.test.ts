import test from 'node:test'
import assert from 'node:assert/strict'
import {
  detectCommercialEvents, eventMatchesTriggers, toCommercialEvent, SINGLE_SOURCE_CONFIDENCE_CAP,
  type CommercialEventKind,
} from '../packages/backend-core/src/lib/commercialEventEngine.ts'
import type { CanonicalSignal } from '../packages/backend-core/src/lib/signalIntelligence.ts'

const DAY = 86_400_000
let n = 0
function sig(type: CanonicalSignal['type'], title: string, host = `src${++n}.example.com`, over: Partial<CanonicalSignal> = {}): CanonicalSignal {
  const url = `https://${host}/item-${++n}`
  return {
    id: `s${n}`, type, source: host, observedAt: new Date(Date.now() - 3 * DAY), publishedAt: null,
    entity: { prospectId: 'p1', companyName: 'ABC Electrical' }, title, description: null, sourceUrl: url, rawValue: null,
    normalizedValue: 80, sourceReliability: 90, relevance: 85,
    evidence: { provider: host, sourceType: 'news', sourceUrl: url, observedAt: new Date(Date.now() - 3 * DAY), confidence: 0.9 },
    ...over,
  }
}
const kinds = (signals: CanonicalSignal[]) => detectCommercialEvents(signals).map(e => e.kind).sort()

test('each event kind is recognised from its signal type and wording', () => {
  const cases: Array<[CommercialEventKind, CanonicalSignal]> = [
    ['TENDER_OPPORTUNITY', sig('PROCUREMENT', 'Request for tender: electrical maintenance panel')],
    ['CONTRACT_OPPORTUNITY', sig('PROCUREMENT', 'Purchasing switchboard components')],
    ['PROCUREMENT_CHANGE', sig('NEWS_MENTION', 'Council launches supplier review for facilities')],
    ['NEW_PROJECT', sig('NEWS_MENTION', 'ABC awarded $4.2M hospital contract')],
    ['CAPACITY_SHORTAGE', sig('HIRING', 'Electricians needed urgently, immediate start')],
    ['HIRING_SURGE', sig('HIRING', 'Hiring 17 field technicians')],
    ['GEOGRAPHIC_EXPANSION', sig('EXPANSION', 'Opens new depot in Townsville')],
    ['FUNDING_DEPLOYMENT', sig('FUNDING', 'Raises $12M Series A')],
    ['TECHNOLOGY_REPLACEMENT', sig('TECH_ADOPTION', 'Migrating from legacy job management to a new platform')],
    ['REGULATORY_CHANGE', sig('NEWS_MENTION', 'New compliance requirements for switchboard testing')],
    ['OPERATIONAL_DISRUPTION', sig('NEWS_MENTION', 'Storm damage forces depot shutdown')],
    ['LEADERSHIP_RESET', sig('LEADERSHIP_CHANGE', 'Appoints new chief operating officer')],
  ]
  for (const [kind, s] of cases) {
    assert.ok(kinds([s]).includes(kind), `${kind} not detected from "${s.title}" (got ${kinds([s]).join(', ')})`)
  }
})

test('one company can have several events at once, strongest first', () => {
  const events = detectCommercialEvents([
    sig('EXPANSION', 'Opens new depot in Brisbane', 'news.example.org'),
    sig('HIRING', 'Hiring 17 field technicians', 'jobs.example.com'),
    sig('FUNDING', 'Raises $12M to expand', 'funding.example.net'),
  ])
  const k = events.map(e => e.kind)
  for (const want of ['CAPACITY_EXPANSION', 'GEOGRAPHIC_EXPANSION', 'HIRING_SURGE', 'FUNDING_DEPLOYMENT'] as const) assert.ok(k.includes(want), want)
  for (let i = 1; i < events.length; i++) assert.ok(events[i - 1].confidence >= events[i].confidence)
  assert.equal(events[0].kind, 'CAPACITY_EXPANSION', 'the only corroborated event leads')
})

test('gate 1: a single-source event is capped; independent confirmation lifts it', () => {
  const [single] = detectCommercialEvents([sig('PROCUREMENT', 'Request for tender: maintenance', 'tenders.example.gov')])
  assert.equal(single.kind, 'TENDER_OPPORTUNITY')
  assert.equal(single.corroborated, false)
  assert.ok(single.confidence <= SINGLE_SOURCE_CONFIDENCE_CAP)
  assert.match(single.whyNow, /^Single-source/)

  const corroborated = detectCommercialEvents([
    sig('PROCUREMENT', 'Request for tender: maintenance', 'tenders.example.gov'),
    sig('NEWS_MENTION', 'Council issues tender for electrical maintenance', 'news.example.org'),
  ]).find(e => e.kind === 'TENDER_OPPORTUNITY')!
  assert.equal(corroborated.corroborated, true)
  assert.equal(corroborated.independentSources, 2)
  assert.ok(corroborated.confidence > SINGLE_SOURCE_CONFIDENCE_CAP)
})

test('stale, unreliable or irrelevant evidence cannot create an event', () => {
  assert.deepEqual(detectCommercialEvents([]), [])
  assert.deepEqual(kinds([sig('PROCUREMENT', 'Request for tender', undefined, { observedAt: new Date(Date.now() - 45 * DAY) })]), [])
  assert.deepEqual(kinds([sig('PROCUREMENT', 'Request for tender', undefined, { sourceReliability: 10, evidence: null })]), [])
  assert.deepEqual(kinds([sig('PROCUREMENT', 'Request for tender', undefined, { relevance: 20 })]), [])
})

test('recent activity matching no rule is only an early trigger, capped below a buying event', () => {
  const events = detectCommercialEvents([sig('NEWS_MENTION', 'ABC Electrical sponsors local football club')])
  assert.equal(events.length, 1)
  assert.equal(events[0].kind, 'EARLY_TRIGGER')
  assert.equal(events[0].family, 'EARLY_BUYING_TRIGGER')
  assert.ok(events[0].confidence <= 68)
})

test('a hiring surge is detected from velocity alone', () => {
  const recent = Array.from({ length: 4 }, (_, i) => sig('HIRING', 'Hiring', 'jobs.example.com', { observedAt: new Date(Date.now() - (1 + i) * DAY) }))
  assert.ok(kinds(recent).includes('HIRING_SURGE'))
  assert.ok(!kinds(recent.slice(0, 1)).includes('HIRING_SURGE'), 'one unremarkable hiring signal is not a surge')
})

test('every claim traces to a signal, best evidence first', () => {
  const a = sig('PROCUREMENT', 'Request for tender: maintenance', 'tenders.example.gov')
  const b = sig('NEWS_MENTION', 'Council issues tender for maintenance', 'news.example.org', { sourceReliability: 60, evidence: null })
  const e = detectCommercialEvents([a, b]).find(x => x.kind === 'TENDER_OPPORTUNITY')!
  assert.deepEqual(e.evidence.map(c => c.signalId), [a.id, b.id])
  assert.equal(e.evidence[0].claim, 'Request for tender: maintenance')
  assert.equal(e.evidence[0].sourceKey, 'host:tenders.example.gov')
  assert.ok(e.evidence[0].quality >= e.evidence[1].quality)
})

test('offer triggers match a kind or its family; the coarse event keeps the family', () => {
  const [e] = detectCommercialEvents([sig('PROCUREMENT', 'Request for tender: maintenance')])
  assert.equal(eventMatchesTriggers(e, ['TENDER_OPPORTUNITY']), true)
  assert.equal(eventMatchesTriggers(e, ['ACTIVE_PROCUREMENT']), true)
  assert.equal(eventMatchesTriggers(e, ['HIRING_SURGE', 'CAPACITY_EXPANSION']), false)
  const coarse = toCommercialEvent(e)
  assert.equal(coarse.type, 'ACTIVE_PROCUREMENT')
  assert.equal(coarse.confidence, e.confidence)
})
