import test from 'node:test'
import assert from 'node:assert/strict'
import { inferCommercialEvent } from '../packages/backend-core/src/lib/commercialEvent.ts'
import { scoreOfferFit } from '../packages/backend-core/src/lib/offerIntelligence.ts'
import { chooseNextBestAction } from '../packages/backend-core/src/lib/nextBestAction.ts'

const signal = (type: any, title: string, description: string, daysAgo = 2) => ({
  type, strength: 80, sourceReliability: 90, industryRelevance: 90,
  detectedAt: new Date(Date.now() - daysAgo * 86_400_000), title, description,
})

test('offer fit rewards explicit evidence matching the mission offer', () => {
  const signals = [signal('EXPANSION', 'New depot', 'Expanded field operations and capacity') , signal('HIRING', 'Hiring crews', 'Hiring field technicians')]
  const event = inferCommercialEvent(signals)
  const fit = scoreOfferFit({ offer: 'temporary field crews for expanding operations', targetCustomer: 'electrical contractors' }, event, signals)
  assert.equal(event.type, 'CAPACITY_EXPANSION')
  assert.ok(fit.score >= 55)
  assert.ok(fit.matchedTerms.length > 0)
})

test('offer fit stays conservative when evidence does not match', () => {
  const signals = [signal('WEBSITE_CHANGE', 'Website refresh', 'New brand colours and pages')]
  const event = inferCommercialEvent(signals)
  const fit = scoreOfferFit({ offer: 'industrial electrical maintenance', targetCustomer: 'manufacturers' }, event, signals)
  assert.ok(fit.score < 55)
})

test('next-best-action enriches before outreach when contact is missing', () => {
  const signals = [signal('EXPANSION', 'New site', 'Operations expansion'), signal('HIRING', 'Hiring', 'Field workforce growth')]
  const event = inferCommercialEvent(signals)
  const fit = scoreOfferFit({ offer: 'field workforce support' }, event, signals)
  const action = chooseNextBestAction({ event, offerFit: fit, signals, hasContact: false, hasEmail: false, opportunityScore: 90 })
  assert.equal(action.action, 'ENRICH')
})

test('next-best-action can contact now only with strong, fresh evidence', () => {
  const signals = [signal('PROCUREMENT', 'Tender', 'Active procurement for external supplier'), signal('HIRING', 'Hiring', 'Operations team expanding')]
  const event = inferCommercialEvent(signals)
  const fit = scoreOfferFit({ offer: 'procurement support and supplier services' }, event, signals)
  const action = chooseNextBestAction({ event, offerFit: fit, signals, hasContact: true, hasEmail: true, opportunityScore: 85 })
  assert.equal(action.action, 'CONTACT_NOW')
})
