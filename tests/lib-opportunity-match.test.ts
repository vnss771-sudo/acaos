// Unit tests for work-discovery matching: trade fit (explicit, classified,
// implied, custom keyword), service area (radius and regions), value floor,
// scoring bounds, and the plain-language reasons shown to the user.
import test from 'node:test'
import assert from 'node:assert/strict'
import { matchOpportunity, isRejection, haversineKm, formatAud, candidateContentHash, MIN_OPPORTUNITY_SCORE } from '../packages/backend-core/src/lib/opportunityMatch.ts'
import { findKeyword, keywordRegex } from '../packages/backend-core/src/lib/opportunityTaxonomy.ts'
import { parseAuRegion, normalizeAuRegion, type DiscoveryProfileInput, type OpportunityCandidate } from '../packages/backend-core/src/lib/opportunityTypes.ts'

const NOW = new Date('2026-09-25T00:00:00Z')
const BRISBANE = { lat: -27.4698, lng: 153.0251 }

function profile(over: Partial<DiscoveryProfileInput> = {}): DiscoveryProfileInput {
  return { trades: ['electrical'], keywords: [], baseLat: BRISBANE.lat, baseLng: BRISBANE.lng, radiusKm: 50, regions: ['QLD'], minValue: null, ...over }
}

function contract(over: Partial<OpportunityCandidate> = {}): OpportunityCandidate {
  return {
    externalId: 'CN1', kind: 'CONTRACT_AWARD', title: 'Electrical services — Brisbane office',
    region: 'QLD', locality: 'Brisbane', valueAmount: 850_000, publishedAt: new Date('2026-09-23T00:00:00Z'),
    classifications: [{ scheme: 'UNSPSC', id: '72151500', description: 'Electrical system services' }],
    counterparty: { name: 'Acme Builders Pty Ltd' }, buyer: { name: 'Department of Example' },
    ...over,
  }
}

function da(over: Partial<OpportunityCandidate> = {}): OpportunityCandidate {
  return {
    externalId: 'DA1', kind: 'DEVELOPMENT_APPLICATION', title: 'Material change of use — warehouse',
    description: 'Construction of a two storey industrial warehouse with office', address: '10 Example St, Eagle Farm QLD 4009',
    region: 'QLD', lat: -27.43, lng: 153.08, publishedAt: new Date('2026-09-20T00:00:00Z'),
    ...over,
  }
}

test('keyword matching is word-bounded and supports suffix wildcards', () => {
  assert.equal(findKeyword('Full rewiring of level 2', ['rewir*']), 'rewiring')
  assert.equal(findKeyword('Air-conditioning upgrade', ['air conditioning']), 'Air-conditioning')
  assert.equal(findKeyword('Graphic design services', ['sign']), null, '"sign" must not match inside "design"')
  assert.equal(keywordRegex([]), null)
})

test('Australian address parsing', () => {
  assert.deepEqual(parseAuRegion('10 Example St, Eagle Farm QLD 4009'), { region: 'QLD', postcode: '4009' })
  assert.equal(normalizeAuRegion('Queensland'), 'QLD')
  assert.equal(normalizeAuRegion('nsw'), 'NSW')
  assert.equal(normalizeAuRegion('Nowhere'), undefined)
})

test('a UNSPSC-classified electrical contract scores highest on trade fit, with reasons', () => {
  const m = matchOpportunity(contract(), profile(), NOW)
  assert.ok(!isRejection(m))
  assert.deepEqual(m.matchedTrades, ['electrical'])
  assert.ok(m.score >= 70, `score ${m.score}`)
  assert.match(m.reasons[0], /Classified as electrical work/)
  assert.ok(m.reasons.includes('In your service area (QLD, Brisbane)'))
  assert.ok(m.reasons.includes('Contract value $850k'))
  assert.ok(m.reasons.includes('Awarded 2 days ago'))
  assert.ok(m.reasons.includes('Head contractor: Acme Builders Pty Ltd'))
  assert.match(m.recommendedAction, /Contact Acme Builders Pty Ltd .* electrical subcontractors/)
})

test('a general building contract implies the subcontracted trades', () => {
  const m = matchOpportunity(contract({
    title: 'Refurbishment of regional office', classifications: [{ scheme: 'UNSPSC', id: '72121400', description: 'Specialized public building construction services' }],
  }), profile({ trades: ['electrical', 'plumbing', 'cleaning'] }), NOW)
  assert.ok(!isRejection(m))
  assert.deepEqual(m.matchedTrades, ['electrical', 'plumbing'], 'cleaning is not implied by a build')
  assert.match(m.reasons[0], /head contractors subcontract electrical, plumbing/)
})

test('specialist work for another trade does not imply yours', () => {
  const m = matchOpportunity(contract(), profile({ trades: ['plumbing'] }), NOW)
  assert.ok(isRejection(m), 'an electrical services contract is not a plumbing lead')
})

test('a large development application implies trades; a minor one does not', () => {
  const big = matchOpportunity(da(), profile(), NOW)
  assert.ok(!isRejection(big))
  assert.match(big.reasons[0], /New .* development — it will need electrical/)
  assert.ok(big.distanceKm! > 0 && big.distanceKm! < 15)
  assert.match(big.reasons[1], /km from your base/)

  const pool = matchOpportunity(da({ title: 'Swimming pool', description: 'Construction of a swimming pool and fence' }), profile(), NOW)
  assert.ok(isRejection(pool))
})

test('unrelated work is rejected; custom keywords rescue it', () => {
  const it = contract({ title: 'Software licences', classifications: [{ scheme: 'UNSPSC', id: '43230000', description: 'Software' }] })
  assert.ok(isRejection(matchOpportunity(it, profile(), NOW)))
  const m = matchOpportunity(contract({ title: 'Switchroom upgrade works', classifications: [] }), profile({ trades: [], keywords: ['switchroom'] }), NOW)
  assert.ok(!isRejection(m))
  assert.match(m.reasons[0], /your keyword “Switchroom”/)
})

test('service area: outside the radius or regions is rejected; unknown location is kept but flagged', () => {
  const far = matchOpportunity(da({ lat: -33.87, lng: 151.21, region: 'NSW' }), profile(), NOW)
  assert.ok(isRejection(far) && /km away/.test(far.reason))

  const otherState = matchOpportunity(contract({ region: 'VIC' }), profile(), NOW)
  assert.ok(isRejection(otherState) && /outside your regions/.test(otherState.reason))

  const unknown = matchOpportunity(contract({ region: undefined, locality: undefined }), profile(), NOW)
  assert.ok(!isRejection(unknown))
  assert.ok(unknown.reasons.includes('Location not stated — check it’s in your area'))
})

test('value floor rejects small contracts', () => {
  const m = matchOpportunity(contract({ valueAmount: 20_000 }), profile({ minValue: 50_000 }), NOW)
  assert.ok(isRejection(m))
  assert.match(m.reason, /\$20k is below your \$50k minimum/)
})

test('scores stay in 0–100; stale and weak items are rejected', () => {
  const best = matchOpportunity(contract({ valueAmount: 50_000_000, publishedAt: NOW }), profile(), NOW)
  assert.ok(!isRejection(best) && best.score <= 100)

  const stale = matchOpportunity(contract({ publishedAt: new Date('2025-01-01T00:00:00Z') }), profile(), NOW)
  assert.ok(isRejection(stale))
  assert.match(stale.reason, /Too old \(632 days\)/)

  // Weak but kept: body-only trade mention (24) + unknown location (8) + unknown size (6) + no date (5) = 43.
  const weak = matchOpportunity(contract({ title: 'Minor works', description: 'includes some lighting', classifications: [], valueAmount: undefined, region: undefined, publishedAt: undefined }), profile(), NOW)
  assert.ok(!isRejection(weak))
  assert.equal(weak.score, 43)
  // Implied trade (20) + unknown location (8) + $12k (1) + 100 days old (0) = 29 → below the floor.
  const weaker = matchOpportunity(contract({ title: 'Office refurbishment', description: undefined, classifications: [], valueAmount: 12_000, region: undefined, publishedAt: new Date('2026-06-17T00:00:00Z') }), profile(), NOW)
  assert.ok(isRejection(weaker))
  assert.equal(weaker.reason, `Score 29 below ${MIN_OPPORTUNITY_SCORE}`)
})

test('helpers', () => {
  assert.ok(Math.abs(haversineKm(-27.4698, 153.0251, -33.8688, 151.2093) - 732) < 10)
  assert.equal(formatAud(1_250_000), '$1.3M')
  assert.equal(formatAud(12_000_000), '$12M')
  assert.equal(formatAud(4_500), '$5k')
  assert.equal(candidateContentHash(contract()), candidateContentHash(contract({ raw: { x: 1 } })), 'raw payload does not change the hash')
  assert.notEqual(candidateContentHash(contract()), candidateContentHash(contract({ valueAmount: 900_000 })))
})
