import test from 'node:test'
import assert from 'node:assert/strict'
import { inferBuyingStage, STAGE_PLAYBOOK, BUYING_STAGES } from '../packages/backend-core/src/lib/buyingStage.ts'
import { assessOpportunity } from '../packages/backend-core/src/lib/opportunityEngine.ts'
import { offerFromRow } from '../packages/backend-core/src/lib/offerModel.ts'
import type { CommercialEventHypothesis, CommercialEventKind } from '../packages/backend-core/src/lib/commercialEventEngine.ts'
import type { CanonicalSignal } from '../packages/backend-core/src/lib/signalIntelligence.ts'

const ev = (kind: CommercialEventKind, confidence = 80, corroborated = true) =>
  ({ kind, family: 'CAPACITY_EXPANSION', title: kind, implication: '', whyNow: '', confidence, independentSources: corroborated ? 2 : 1, trustworthySignals: 1, corroborated, supportingTypes: [], evidence: [] }) as CommercialEventHypothesis

test('stage follows the strongest event; no event means no detectable need', () => {
  assert.equal(inferBuyingStage({ events: [] }).stage, 'NO_DETECTABLE_NEED')
  assert.equal(inferBuyingStage({ events: [ev('EARLY_TRIGGER', 50)] }).stage, 'EMERGING_TRIGGER')
  assert.equal(inferBuyingStage({ events: [ev('GEOGRAPHIC_EXPANSION')] }).stage, 'PROBLEM_LIKELY')
  assert.equal(inferBuyingStage({ events: [ev('GEOGRAPHIC_EXPANSION'), ev('CAPACITY_SHORTAGE')] }).stage, 'ACTIVE_REQUIREMENT')
  assert.equal(inferBuyingStage({ events: [ev('CAPACITY_SHORTAGE'), ev('TENDER_OPPORTUNITY')] }).stage, 'EVALUATING_SOLUTIONS')
  assert.equal(inferBuyingStage({ events: [ev('TENDER_OPPORTUNITY', 50)] }).stage, 'EMERGING_TRIGGER', 'low confidence only emerges')
})

test('gate 1: an uncorroborated event is held at "problem likely"', () => {
  const s = inferBuyingStage({ events: [ev('TENDER_OPPORTUNITY', 60, false)] })
  assert.equal(s.stage, 'PROBLEM_LIKELY')
  assert.ok(s.reasons.some(r => r.includes('Uncorroborated')))
  assert.equal(s.outreachAppropriate, false)
})

test('only recorded engagement reaches a buying decision or customer', () => {
  assert.equal(inferBuyingStage({ events: [ev('TENDER_OPPORTUNITY')], engagement: 'CONTACTED' }).stage, 'EVALUATING_SOLUTIONS')
  assert.equal(inferBuyingStage({ events: [], engagement: 'MEETING' }).stage, 'BUYING_DECISION')
  const proposal = inferBuyingStage({ events: [ev('EARLY_TRIGGER', 50)], engagement: 'PROPOSAL' })
  assert.equal(proposal.stage, 'BUYING_DECISION')
  assert.equal(proposal.play.stance, 'CLOSE')
  assert.equal(inferBuyingStage({ events: [ev('CAPACITY_SHORTAGE')], engagement: 'WON' }).stage, 'CUSTOMER')
})

test('every stage has a play; outreach fits from active requirement up to the decision', () => {
  for (const s of BUYING_STAGES) assert.ok(STAGE_PLAYBOOK[s].move.length > 0, s)
  assert.equal(STAGE_PLAYBOOK.EMERGING_TRIGGER.stance, 'NURTURE')
  assert.equal(STAGE_PLAYBOOK.EVALUATING_SOLUTIONS.stance, 'PROVE')
  const fits = (events: CommercialEventHypothesis[], engagement?: 'MEETING' | 'WON') => inferBuyingStage({ events, engagement }).outreachAppropriate
  assert.equal(fits([ev('GEOGRAPHIC_EXPANSION')]), false)
  assert.equal(fits([ev('CAPACITY_SHORTAGE')]), true)
  assert.equal(fits([ev('TENDER_OPPORTUNITY')]), true)
  assert.equal(fits([], 'MEETING'), true)
  assert.equal(fits([], 'WON'), false)
})

// ── Engine stage gate ───────────────────────────────────────────────────────
const DAY = 86_400_000
let n = 0
const sig = (type: CanonicalSignal['type'], title: string, host: string): CanonicalSignal => {
  const url = `https://${host}/i-${++n}`
  return {
    id: `s${n}`, type, source: host, observedAt: new Date(Date.now() - 2 * DAY), publishedAt: null,
    entity: { prospectId: 'p', companyName: 'Co' }, title, description: `${title} with 2 details`, sourceUrl: url, rawValue: null,
    normalizedValue: 85, sourceReliability: 90, relevance: 85,
    evidence: { provider: host, sourceType: 'news', sourceUrl: url, observedAt: new Date(Date.now() - 2 * DAY), confidence: 0.9 },
  }
}
const offer = offerFromRow({
  id: 'o', missionId: null, name: 'Depot fit-out', problemSolved: 'Fit-out for a new depot or site', targetCustomer: null,
  targetBuyerTitles: ['Operations Manager'], triggeringEvents: ['GEOGRAPHIC_EXPANSION'], qualifyingKeywords: ['new depot'],
  disqualifyingKeywords: [], geographies: [], minOpportunityValueCents: null, dealValueMinCents: 5_000_000, dealValueMaxCents: 9_000_000,
  urgencyIndicators: [], proofPoints: [], recommendedActions: [],
})
const signals = [sig('EXPANSION', 'Opens new depot in Townsville', 'news.example.org'), sig('NEWS_MENTION', 'Opens new depot in Townsville', 'local.example.com')]
const prospect = { id: 'p', companyName: 'Co', contactName: 'Sam', contactEmail: 's@x.example', contactTitle: 'Operations Manager' }

test('engine: strong evidence at "problem likely" qualifies rather than sells; a meeting unlocks contact', () => {
  const early = assessOpportunity({ prospect, signals, offer })!
  assert.equal(early.buyingStage, 'PROBLEM_LIKELY')
  assert.equal(early.recommendedAction, 'RESEARCH_CONTACT')
  assert.equal(early.actionLabel, STAGE_PLAYBOOK.PROBLEM_LIKELY.move)
  assert.ok(early.blockers.includes('Buying stage is before an active requirement'))

  const met = assessOpportunity({ prospect: { ...prospect, outcomeStage: 'MEETING' }, signals, offer })!
  assert.equal(met.buyingStage, 'BUYING_DECISION')
  assert.equal(met.recommendedAction, 'CONTACT_NOW')
})
