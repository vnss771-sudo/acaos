import test from 'node:test'
import assert from 'node:assert/strict'
import { assessOpportunity, type OpportunityAssessment, type OpportunityProspect } from '../packages/backend-core/src/lib/opportunityEngine.ts'
import { offerFromRow, type OfferRow } from '../packages/backend-core/src/lib/offerModel.ts'
import { citeEvidence, recommendForOpportunity, type RecommendationInput } from '../packages/backend-core/src/lib/recommendationEngine.ts'
import type { CanonicalSignal } from '../packages/backend-core/src/lib/signalIntelligence.ts'
import { STAGE_PLAYBOOK, type BuyingStageV2 } from '../packages/backend-core/src/lib/buyingStage.ts'

const DAY = 86_400_000
const NOW = Date.parse('2026-10-01T00:00:00Z')
let n = 0
function sig(type: CanonicalSignal['type'], title: string, host: string, ageDays: number): CanonicalSignal {
  const url = `https://${host}/item-${++n}`
  const at = new Date(NOW - ageDays * DAY)
  return {
    id: `s${n}`, type, source: host, observedAt: at, publishedAt: null,
    entity: { prospectId: 'p1', companyName: 'ABC Electrical' }, title, description: `${title} — reported with 2 details`,
    sourceUrl: url, rawValue: null, normalizedValue: 85, sourceReliability: 90, relevance: 85,
    evidence: { provider: host, sourceType: 'news', sourceUrl: url, observedAt: at, confidence: 0.9 },
  }
}

const offerRow: OfferRow = {
  id: 'o1', missionId: null, name: 'Temporary field crews', problemSolved: 'Short-notice field labour for expanding contractors',
  targetCustomer: 'electrical contractors', targetBuyerTitles: ['Operations Manager'],
  triggeringEvents: ['CAPACITY_EXPANSION', 'ACTIVE_PROCUREMENT'], qualifyingKeywords: ['field technicians', 'new depot', 'project awarded'],
  disqualifyingKeywords: [], geographies: [], minOpportunityValueCents: null,
  dealValueMinCents: 4_000_000, dealValueMaxCents: 8_000_000, urgencyIndicators: [], proofPoints: [], recommendedActions: ['Offer a two-week trial crew'],
}
const offer = offerFromRow(offerRow)
const prospect: OpportunityProspect = {
  id: 'p1', companyName: 'ABC Electrical', industry: 'Electrical contractor', employeeCount: 120, location: 'Brisbane, QLD',
  contactName: 'Sam Lee', contactEmail: 'sam@abc.example', contactTitle: 'Operations Manager', domain: 'abc.example',
}
const signals = [
  sig('EXPANSION', 'New depot opened in Brisbane', 'news.example.org', 9),
  sig('HIRING', 'Hiring 17 field technicians', 'jobs.example.com', 3),
]

function base(): OpportunityAssessment {
  const a = assessOpportunity({ prospect, signals, offer, now: NOW })
  assert.ok(a)
  return a
}

/** The base assessment with some fields overridden (stage overrides carry their play). */
function input(over: Partial<OpportunityAssessment> = {}, extra: Partial<RecommendationInput> = {}): RecommendationInput {
  const a = { ...base(), ...over }
  if (over.buyingStage) a.buyingStageDetail = { ...a.buyingStageDetail, stage: over.buyingStage, play: STAGE_PLAYBOOK[over.buyingStage as BuyingStageV2] }
  return { assessment: a, offer, now: NOW, ...extra }
}

test('corroborated, fresh, contactable → contact now, citing the evidence with its age', () => {
  const a = base()
  assert.equal(a.recommendedAction, 'CONTACT_NOW')
  const r = a.recommendation
  assert.ok(r)
  assert.equal(r.kind, 'CONTACT_NOW')
  assert.equal(r.outreach, true)
  assert.equal(r.citations.length, 2)
  assert.equal(r.citations[0].claim, 'Hiring 17 field technicians')
  assert.equal(r.citations[0].ageDays, 3)
  assert.equal(r.headline, 'Contact now: hiring 17 field technicians 3 days ago, new depot opened in Brisbane 9 days ago')
  assert.equal(r.citations[1].ageDays, 9)
  assert.ok(r.why.includes(`New depot opened in Brisbane — 9 days ago (${r.citations[1].source})`))
  assert.ok(r.nextSteps.includes('Offer a two-week trial crew'))
  assert.equal(r.priority, a.priority)
  assert.deepEqual(r.basis, { buyingStage: 'ACTIVE_REQUIREMENT', stance: 'ENGAGE', nextBestAction: 'CONTACT_NOW' })
  // Deterministic.
  assert.deepEqual(recommendForOpportunity(input()), r)
})

test('gate 2: no evidence to cite → no outreach recommendation', () => {
  assert.equal(recommendForOpportunity(input({ evidence: [] })), null)
  assert.equal(recommendForOpportunity(input({ actionReason: '  ' })), null)
  // A non-outreach move can stand on its reasons alone.
  const r = recommendForOpportunity(input({ evidence: [], recommendedAction: 'MONITOR' }))
  assert.equal(r?.kind, 'MONITOR')
})

test('evaluating solutions: proof point → case study; contested without proof → research the incumbent', () => {
  const withProof = recommendForOpportunity(input({ buyingStage: 'EVALUATING_SOLUTIONS' }, { offer: { ...offer, proofPoints: ['Crewed the Logan depot build in 10 days'] } }))
  assert.equal(withProof?.kind, 'SEND_CASE_STUDY')
  assert.equal(withProof?.proofPoint, 'Crewed the Logan depot build in 10 days')
  assert.ok(withProof?.nextSteps.includes('Proof point: Crewed the Logan depot build in 10 days'))

  const contested = recommendForOpportunity(input({ buyingStage: 'EVALUATING_SOLUTIONS', competition: 70 }))
  assert.equal(contested?.kind, 'RESEARCH_INCUMBENT')
  assert.equal(contested?.outreach, false)
  assert.equal(recommendForOpportunity(input({ buyingStage: 'EVALUATING_SOLUTIONS', competition: 30 }))?.kind, 'CONTACT_NOW')
})

test('wait N days: already contacted, or only an emerging trigger', () => {
  const contacted = recommendForOpportunity(input({}, { engagement: 'CONTACTED' }))
  assert.equal(contacted?.kind, 'WAIT')
  assert.equal(contacted?.waitDays, 7)
  assert.equal(contacted?.label, 'Wait 7 days')
  assert.equal(contacted?.revisitAt, new Date(NOW + 7 * DAY).toISOString())
  assert.equal(contacted?.urgency, 'LOW')
  assert.ok((contacted?.priority ?? 100) <= 30)

  const early = recommendForOpportunity(input({ buyingStage: 'EMERGING_TRIGGER' }))
  assert.equal(early?.kind, 'WAIT')
  assert.equal(early?.waitDays, 14)
})

test('engagement and stage: lost, customer, buying decision, no need', () => {
  assert.equal(recommendForOpportunity(input({}, { engagement: 'LOST' }))?.kind, 'RE_ENGAGE')
  const lostWeak = recommendForOpportunity(input({ buyingStage: 'PROBLEM_LIKELY' }, { engagement: 'LOST' }))
  assert.equal(lostWeak?.kind, 'DONT_CONTACT')
  assert.equal(lostWeak?.outreach, false)

  assert.equal(recommendForOpportunity(input({ buyingStage: 'CUSTOMER' }))?.kind, 'RE_ENGAGE')
  assert.equal(recommendForOpportunity(input({ buyingStage: 'CUSTOMER', urgency: 'LOW' }))?.kind, 'MONITOR')

  const deciding = recommendForOpportunity(input({ buyingStage: 'BUYING_DECISION' }, { engagement: 'PROPOSAL' }))
  assert.equal(deciding?.kind, 'ESCALATE')
  assert.equal(deciding?.outreach, false)
  assert.match(deciding?.why[0] ?? '', /proposal/)
  assert.match(recommendForOpportunity(input({ buyingStage: 'BUYING_DECISION' }, { engagement: 'MEETING' }))?.why[0] ?? '', /meeting/)

  assert.equal(recommendForOpportunity(input({ buyingStage: 'NO_DETECTABLE_NEED' }))?.kind, 'DONT_CONTACT')
})

test('next-best-action drives find-the-buyer, monitor and qualifying moves', () => {
  const enrich = recommendForOpportunity(input({ recommendedAction: 'ENRICH', actionReason: 'No reachable buyer yet.' }))
  assert.equal(enrich?.kind, 'FIND_BUYER')
  assert.ok(enrich?.why.includes(base().scorecard.contactability.reason))
  assert.equal(recommendForOpportunity(input({ recommendedAction: 'HOLD' }))?.kind, 'MONITOR')

  const research = { recommendedAction: 'RESEARCH_CONTACT' as const, actionReason: 'Confirm the evidence first.' }
  assert.equal(recommendForOpportunity(input({ ...research, trustworthySignals: 0 }))?.kind, 'MONITOR')
  assert.equal(recommendForOpportunity(input({ ...research, competition: 80 }))?.kind, 'RESEARCH_INCUMBENT')
  // Uncorroborated: never research-the-incumbent on a rumour — qualify instead.
  const uncorroborated = recommendForOpportunity(input({ ...research, competition: 80, gates: { intelligenceTruth: false, decisionTruth: true } }))
  assert.equal(uncorroborated?.kind, 'ASK_QUALIFYING_QUESTION')
  assert.equal(uncorroborated?.outreach, true)
})

test('single-source evidence never becomes contact now', () => {
  const one = signals.map(s => ({ ...s, source: 'news.example.org', sourceUrl: 'https://news.example.org/a', evidence: { ...s.evidence!, provider: 'news.example.org', sourceUrl: 'https://news.example.org/a' } }))
  const a = assessOpportunity({ prospect, signals: one, offer, now: NOW })
  assert.ok(a)
  assert.notEqual(a.recommendation?.kind, 'CONTACT_NOW')
  assert.notEqual(a.recommendation?.kind, 'SEND_CASE_STUDY')
})

test('citeEvidence: trustworthy first, then newest; capped at three', () => {
  const claim = (id: string, trustworthy: boolean, age: number) => ({
    signalId: id, signalType: 'HIRING' as const, claim: id, source: 'src', sourceKey: '', sourceUrl: null,
    eventDate: new Date(NOW - age * DAY).toISOString(), quality: 80, grade: 'HIGH' as const, trustworthy,
  })
  const cited = citeEvidence([claim('a', false, 1), claim('b', true, 10), claim('c', true, 2), claim('d', true, 5)], NOW)
  assert.deepEqual(cited.map(c => c.claim), ['c', 'd', 'b'])
  assert.equal(cited[0].source, 'src')
  assert.equal(citeEvidence([claim('x', true, -1)], NOW)[0].ageDays, 0)
})
