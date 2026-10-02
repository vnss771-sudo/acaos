import test from 'node:test'
import assert from 'node:assert/strict'
import { inferCommercialEvent } from '../packages/backend-core/src/lib/commercialEvent.ts'
import { scoreOfferFit } from '../packages/backend-core/src/lib/offerFit.ts'
import { generateRuleBasedRecommendation } from '../packages/backend-core/src/lib/signalEngine.ts'
import type { RawSignal } from '../packages/backend-core/src/lib/signalEngine.ts'
import type { SignalType } from '@acaos/shared'

const NOW = new Date('2026-09-30T00:00:00Z').getTime()
const sig = (type: SignalType, days = 2, sourceReliability = 90, industryRelevance = 90): RawSignal => ({
  type, strength: 80, sourceReliability, industryRelevance,
  detectedAt: new Date(NOW - days * 86_400_000),
})

test('procurement is the strongest direct buying event', () => {
  const event = inferCommercialEvent([sig('PROCUREMENT'), sig('HIRING')], NOW)
  assert.equal(event.type, 'ACTIVE_PROCUREMENT')
  assert.ok(event.confidence >= 70)
})

test('expansion plus hiring becomes a capacity expansion hypothesis', () => {
  const event = inferCommercialEvent([sig('EXPANSION'), sig('HIRING')], NOW)
  assert.equal(event.type, 'CAPACITY_EXPANSION')
  assert.deepEqual(event.supportingTypes.sort(), ['EXPANSION', 'HIRING'])
})

test('stale or low-quality evidence cannot manufacture an event', () => {
  const event = inferCommercialEvent([sig('FUNDING', 60), sig('HIRING', 2, 20)], NOW)
  assert.equal(event.type, 'NO_CLEAR_EVENT')
  assert.equal(event.confidence, 0)
})

test('offer fit rewards direct evidence-to-offer matches', () => {
  const fit = scoreOfferFit('temporary field crews for electrical projects', 'New electrical project requires additional field crews')
  assert.ok(fit.score > 50)
  assert.ok(fit.matchedTerms.includes('electrical'))
})

test('offer fit does not manufacture relevance', () => {
  const fit = scoreOfferFit('temporary field crews', 'New office website launched')
  assert.equal(fit.score, 25)
  assert.deepEqual(fit.matchedTerms, [])
})


test('recommendations explain a corroborated commercial event', () => {
  const rec = generateRuleBasedRecommendation(
    { industry: 'construction', contactEmail: 'ops@example.com', contactName: 'Ops' },
    [sig('EXPANSION'), sig('HIRING')],
  )
  assert.match(rec.reasoning, /Commercial event: capacity expansion/) 
})
