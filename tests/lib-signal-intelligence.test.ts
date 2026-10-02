import test from 'node:test'
import assert from 'node:assert/strict'
import {
  toCanonicalSignal, assessSignalQuality, signalVelocity, metricPoints, metricVelocity, sourceKey, eventDate,
  type CanonicalSignal,
} from '../packages/backend-core/src/lib/signalIntelligence.ts'

const DAY = 86_400_000
const NOW = Date.now()
const ago = (d: number) => new Date(NOW - d * DAY)

let n = 0
function sig(over: Partial<CanonicalSignal> = {}): CanonicalSignal {
  return {
    id: `s${++n}`, type: 'HIRING', source: 'apollo', observedAt: ago(1), publishedAt: null,
    entity: { prospectId: 'p1', companyName: 'ABC Electrical' },
    title: 'Hiring 17 field technicians', description: 'Seventeen new field positions advertised for the Brisbane depot',
    sourceUrl: 'https://jobs.example.com/abc', rawValue: null, normalizedValue: 80,
    sourceReliability: 85, relevance: 80,
    evidence: { provider: 'apollo', sourceType: 'job_posting', sourceUrl: 'https://jobs.example.com/abc', observedAt: ago(1), confidence: 0.9 },
    ...over,
  }
}

test('toCanonicalSignal maps a DB row and falls back to the evidence provider for source', () => {
  const c = toCanonicalSignal({
    id: 'x', type: 'FUNDING', strength: 70, sourceReliability: 80, industryRelevance: 60,
    detectedAt: ago(2), publishedAt: ago(5), source: null, title: 'Raised $4.2M', prospectId: 'p9',
    prospect: { companyName: 'Acme' }, rawData: { metric: 'funding', value: 4200000 },
    evidenceSource: { provider: 'news', sourceType: 'news', sourceUrl: 'https://news.example.com/a', observedAt: ago(2), confidence: 1.4 },
  })
  assert.equal(c.source, 'news')
  assert.equal(c.entity.companyName, 'Acme')
  assert.equal(c.sourceUrl, 'https://news.example.com/a')
  assert.equal(c.evidence?.confidence, 1, 'evidence confidence is clamped to 0..1')
  assert.equal(eventDate(c).getTime(), ago(5).getTime(), 'publishedAt dates the event when known')
  assert.equal(toCanonicalSignal({ type: 'HIRING', strength: 1, sourceReliability: 1, industryRelevance: 1, detectedAt: ago(0) }).source, 'unknown')
})

test('reliability is capped without provenance and blended with evidence confidence when present', () => {
  const noEvidence = sig({ evidence: null, sourceReliability: 95 })
  const q1 = assessSignalQuality(noEvidence, { all: [noEvidence], now: NOW })
  assert.equal(q1.reliability, 60)
  assert.ok(q1.reasons.some(r => r.includes('No evidence source')))

  const withEvidence = sig({ sourceReliability: 80, evidence: { ...sig().evidence!, confidence: 0.5 } })
  assert.equal(assessSignalQuality(withEvidence, { all: [withEvidence], now: NOW }).reliability, 68) // 80*.6 + 50*.4
})

test('freshness follows when the event happened, not when it was detected', () => {
  const freshlyDetectedOldNews = sig({ observedAt: ago(0), publishedAt: ago(200) })
  const q = assessSignalQuality(freshlyDetectedOldNews, { all: [freshlyDetectedOldNews], now: NOW })
  assert.ok(q.freshness < 20, `expected stale, got ${q.freshness}`)
  assert.equal(q.trustworthy, false)
})

test('specific, sourced detail scores higher than generic activity', () => {
  const specific = sig()
  const generic = sig({ type: 'NEWS_MENTION', title: null, description: null, sourceUrl: null, evidence: null })
  const qs = assessSignalQuality(specific, { all: [specific], now: NOW })
  const qg = assessSignalQuality(generic, { all: [generic], now: NOW })
  assert.ok(qs.specificity > qg.specificity + 30, `${qs.specificity} vs ${qg.specificity}`)
})

test('corroboration counts independent sources only, within the window', () => {
  const a = sig({ sourceUrl: 'https://jobs.example.com/1', evidence: { ...sig().evidence!, sourceUrl: 'https://jobs.example.com/1' } })
  const sameHost = sig({ type: 'EXPANSION', sourceUrl: 'https://www.jobs.example.com/2', evidence: { ...sig().evidence!, sourceUrl: 'https://www.jobs.example.com/2' } })
  const otherHost = sig({ type: 'EXPANSION', sourceUrl: 'https://news.example.org/x', evidence: { ...sig().evidence!, provider: 'news', sourceUrl: 'https://news.example.org/x' } })
  const tooOld = sig({ type: 'FUNDING', observedAt: ago(90), sourceUrl: 'https://register.example.net/y', evidence: null })

  assert.equal(sourceKey(a), sourceKey(sameHost), 'www. and path differences are the same source')
  const qa = assessSignalQuality(a, { all: [a, sameHost, otherHost, tooOld], now: NOW })
  assert.equal(qa.independentSources, 1)
  assert.equal(qa.corroboration, 60)
  assert.equal(assessSignalQuality(a, { all: [a, sameHost], now: NOW }).independentSources, 0)
})

test('offer fit is null without an offer and rises with matching offer terms', () => {
  const s = sig()
  assert.equal(assessSignalQuality(s, { all: [s], now: NOW }).offerFit, null)
  const matched = assessSignalQuality(s, { all: [s], offerTerms: ['field', 'technicians'], now: NOW })
  const unmatched = assessSignalQuality(s, { all: [s], offerTerms: ['accounting'], now: NOW })
  assert.equal(matched.offerFit, 80)
  assert.equal(unmatched.offerFit, 30)
})

test('unreliable evidence is UNUSABLE whatever else it scores', () => {
  const s = sig({ sourceReliability: 10, evidence: { ...sig().evidence!, confidence: 0.1 } })
  const q = assessSignalQuality(s, { all: [s], now: NOW })
  assert.equal(q.grade, 'UNUSABLE')
  assert.equal(q.trustworthy, false)
})

test('a fresh, sourced, corroborated signal is trustworthy', () => {
  const a = sig()
  const b = sig({ type: 'EXPANSION', title: 'Brisbane depot opened', sourceUrl: 'https://news.example.org/depot', evidence: { ...sig().evidence!, provider: 'news', sourceUrl: 'https://news.example.org/depot' } })
  const q = assessSignalQuality(a, { all: [a, b], now: NOW })
  assert.equal(q.trustworthy, true)
  assert.ok(q.grade === 'HIGH' || q.grade === 'MEDIUM')
})

test('velocity reports change, not just state', () => {
  const recent = Array.from({ length: 22 }, (_, i) => sig({ observedAt: ago(1 + (i % 25)) }))
  const prior = Array.from({ length: 5 }, (_, i) => sig({ observedAt: ago(35 + i) }))
  const newType = [sig({ type: 'PROCUREMENT', observedAt: ago(3) })]
  const dormant = [sig({ type: 'FUNDING', observedAt: ago(45) })]
  const slowing = [sig({ type: 'EXPANSION', observedAt: ago(2) }), ...Array.from({ length: 4 }, (_, i) => sig({ type: 'EXPANSION', observedAt: ago(40 + i) }))]
  const v = signalVelocity([...recent, ...prior, ...newType, ...dormant, ...slowing], { now: NOW })
  const by = Object.fromEntries(v.map(x => [x.type, x]))

  assert.equal(by.HIRING.changePct, 340)
  assert.equal(by.HIRING.trend, 'ACCELERATING')
  assert.match(by.HIRING.summary, /Hiring signals up 340% over 30 days \(22 vs 5\)/)
  assert.equal(by.PROCUREMENT.trend, 'NEW')
  assert.equal(by.PROCUREMENT.changePct, null)
  assert.equal(by.FUNDING.trend, 'DORMANT')
  assert.equal(by.EXPANSION.trend, 'DECELERATING')
})

test('metric velocity: headcount +23% over 30 days', () => {
  const series = [
    sig({ observedAt: ago(60), rawValue: { metric: 'headcount', value: 90 } }),
    sig({ observedAt: ago(31), rawValue: { metric: 'headcount', value: 100 } }),
    sig({ observedAt: ago(2), rawValue: { metric: 'headcount', value: 123 } }),
    sig({ observedAt: ago(1), rawValue: { metric: 'revenue', value: 5 } }),
  ]
  const pts = metricPoints(series, 'headcount')
  assert.equal(pts.length, 3)
  const v = metricVelocity('headcount', pts, { now: NOW })
  assert.ok(v)
  assert.equal(v.changePct, 23)
  assert.equal(v.summary, 'headcount +23% over 30 days (100 → 123)')
  assert.equal(metricVelocity('headcount', pts.slice(2), { now: NOW }), null, 'no point before the window')
})
