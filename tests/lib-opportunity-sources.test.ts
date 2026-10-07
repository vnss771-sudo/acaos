// Unit tests for the work-discovery source connectors, against recorded-shape
// fixtures (no network). Covers normalization, pagination, cursor/resume rules,
// and that an unexpected upstream shape fails loudly instead of returning [].
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  austenderSource, planningAlertsSource, austenderReleaseToCandidates, planningAlertsToCandidate, boundingBox,
  isAustenderNoRecords,
} from '../packages/backend-core/src/lib/opportunitySources.ts'
import type { DiscoveryProfileInput } from '../packages/backend-core/src/lib/opportunityTypes.ts'

const PROFILE: DiscoveryProfileInput = { trades: ['electrical'], keywords: [], baseLat: -27.4698, baseLng: 153.0251, radiusKm: 30, regions: ['QLD'], minValue: null }
const NOW = new Date('2026-09-25T09:00:00Z')

function release(cn: string, over: Record<string, unknown> = {}) {
  return {
    ocid: `prod-${cn}`,
    id: `${cn}-1`,
    date: '2026-09-22T03:00:00Z',
    parties: [
      { id: 'sup-1', name: 'Acme Electrical Pty Ltd', roles: ['supplier'], address: { locality: 'Brisbane', region: 'QLD', postalCode: '4000' }, additionalIdentifiers: [{ id: '12 345 678 901', scheme: 'AU-ABN' }], contactPoint: { email: 'tenders@acme.test', telephone: '07 5555 0000' } },
      { id: 'buy-1', name: 'Department of Example', roles: ['procuringEntity'], address: { locality: 'Canberra', region: 'ACT' } },
    ],
    awards: [{ id: `${cn}-award`, suppliers: [{ id: 'sup-1', name: 'Acme Electrical Pty Ltd' }] }],
    contracts: [{
      id: cn, awardID: `${cn}-award`, title: 'Electrical maintenance services', description: 'Switchboard upgrades and lighting',
      value: { amount: '425000.00', currency: 'AUD' }, dateSigned: '2026-09-21T00:00:00Z',
      items: [{ classification: { scheme: 'UNSPSC', id: '72151500', description: 'Electrical system services' } }],
    }],
    ...over,
  }
}

type Call = { url: string }

function fakeFetch(routes: (url: URL) => unknown, calls: Call[] = []) {
  return async (url: string | URL) => {
    const u = new URL(String(url))
    calls.push({ url: u.toString() })
    const body = routes(u)
    if (body instanceof Response) return body
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
}

test('AusTender: a contract notice normalizes to a contract-award candidate', () => {
  const [c] = austenderReleaseToCandidates(release('CN100') as never)
  assert.equal(c.externalId, 'CN100')
  assert.equal(c.kind, 'CONTRACT_AWARD')
  assert.equal(c.title, 'Electrical maintenance services')
  assert.equal(c.valueAmount, 425000)
  assert.equal(c.region, 'QLD')
  assert.equal(c.locality, 'Brisbane')
  assert.deepEqual(c.counterparty, { name: 'Acme Electrical Pty Ltd', abn: '12345678901', email: 'tenders@acme.test', phone: '07 5555 0000' })
  assert.deepEqual(c.buyer, { name: 'Department of Example' })
  assert.deepEqual(c.classifications, [{ scheme: 'UNSPSC', id: '72151500', description: 'Electrical system services' }])
  assert.equal(c.publishedAt?.toISOString(), '2026-09-21T00:00:00.000Z')
})

test('AusTender: reads whole days oldest-first, follows pagination, never marks today done', async () => {
  const calls: Call[] = []
  const fetchImpl = fakeFetch((u) => {
    if (u.searchParams.get('page') === '2') return { releases: [release('CN202')], links: {} }
    if (u.pathname.includes('contractPublished/2026-09-23T00:00:00Z/')) return { releases: [release('CN201')], links: { next: `${u.origin}${u.pathname}?page=2` } }
    return { releases: [], links: {} }
  }, calls)
  const r = await austenderSource.fetch({ cursor: '2026-09-22T00:00:00.000Z', profile: PROFILE, now: NOW, fetchImpl })
  assert.deepEqual(r.items.map(i => i.externalId), ['CN201', 'CN202'])
  // 22nd and 23rd and 24th are complete days; the 25th (today) is not read.
  assert.equal(r.nextCursor, '2026-09-25T00:00:00.000Z')
  assert.ok(calls.every(c => !c.url.includes('2026-09-25T00:00:00Z/2026-09-26')))
  assert.equal(r.warning, undefined)
})

test('AusTender: a day over the page cap is kept but not marked done', async () => {
  let n = 0
  const fetchImpl = fakeFetch((u) => ({ releases: [release(`CN3${n++}`)], links: { next: `${u.origin}${u.pathname}?page=${n + 1}` } }))
  const r = await austenderSource.fetch({ cursor: '2026-09-24T00:00:00.000Z', profile: PROFILE, now: NOW, fetchImpl })
  assert.equal(r.items.length, 40)
  assert.equal(r.nextCursor, '2026-09-24T00:00:00.000Z', 'cursor stays at the unfinished day')
  assert.match(r.warning ?? '', /more than 40 pages/)
})

// What AusTender returns for a day with no notices (seen in production for
// Saturday 26 Sep 2026): a 400, not an empty list.
const noRecords = (day: string, next: string) => new Response(
  JSON.stringify({ errorCode: 100, message: `No Records found for Date Range ['${day}T00:00:00Z'-'${next}T00:00:00Z']` }),
  { status: 400, headers: { 'Content-Type': 'application/json' } },
)

test('AusTender: a day with no notices (400 "No Records found") is an empty day, and the cursor moves past it', async () => {
  const fetchImpl = fakeFetch((u) => {
    if (u.pathname.includes('contractPublished/2026-09-22T00:00:00Z/')) return noRecords('2026-09-22', '2026-09-23')
    if (u.pathname.includes('contractPublished/2026-09-23T00:00:00Z/')) return { releases: [release('CN401')], links: {} }
    if (u.pathname.includes('contractPublished/2026-09-24T00:00:00Z/')) return noRecords('2026-09-24', '2026-09-25')
    return { releases: [], links: {} }
  })
  const r = await austenderSource.fetch({ cursor: '2026-09-22T00:00:00.000Z', profile: PROFILE, now: NOW, fetchImpl })
  assert.deepEqual(r.items.map(i => i.externalId), ['CN401'])
  assert.equal(r.nextCursor, '2026-09-25T00:00:00.000Z')
})

test('AusTender: any other client error still fails the run', async () => {
  const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ errorCode: 7, message: 'Invalid date' }), { status: 400 }))
  await assert.rejects(
    austenderSource.fetch({ cursor: '2026-09-24T00:00:00.000Z', profile: PROFILE, now: NOW, fetchImpl }),
    /austender findByDates\/contractPublished 400: .*Invalid date/,
  )
})

test('isAustenderNoRecords: only a 400 that says there are no records', () => {
  assert.equal(isAustenderNoRecords(400, JSON.stringify({ errorCode: 100, message: 'No Records found for Date Range' })), true)
  assert.equal(isAustenderNoRecords(400, JSON.stringify({ message: 'No Records found for Date Range' })), true)
  assert.equal(isAustenderNoRecords(400, JSON.stringify({ errorCode: 7, message: 'Invalid date' })), false)
  assert.equal(isAustenderNoRecords(404, JSON.stringify({ errorCode: 100 })), false)
  assert.equal(isAustenderNoRecords(400, '<html>Bad Request</html>'), false)
})

test('AusTender: an unexpected payload fails loudly', async () => {
  const fetchImpl = fakeFetch(() => ({ results: [] }))
  await assert.rejects(austenderSource.fetch({ cursor: '2026-09-24T00:00:00.000Z', profile: PROFILE, now: NOW, fetchImpl }), /unexpected response shape — releases/)
})

const PA_ROW = {
  application: {
    id: 5001, council_reference: 'A006123456', address: '10 Example St, Eagle Farm QLD 4009',
    description: 'Material Change of Use - Warehouse. Two storey industrial warehouse with office.',
    info_url: 'https://council.example/da/A006123456', lat: -27.43, lng: 153.08,
    date_received: '2026-09-20', date_scraped: '2026-09-21T05:00:00Z', authority: { full_name: 'Brisbane City Council' },
  },
}

test('PlanningAlerts: an application normalizes to a development-application candidate', () => {
  const c = planningAlertsToCandidate(PA_ROW.application)
  assert.equal(c.externalId, '5001')
  assert.equal(c.kind, 'DEVELOPMENT_APPLICATION')
  assert.equal(c.title, 'Material Change of Use - Warehouse.')
  assert.equal(c.region, 'QLD')
  assert.equal(c.postcode, '4009')
  assert.equal(c.authority, 'Brisbane City Council')
  assert.equal(c.sourceUrl, 'https://council.example/da/A006123456')
})

test('PlanningAlerts: needs a key and a base location', async () => {
  const saved = process.env.PLANNINGALERTS_API_KEY
  delete process.env.PLANNINGALERTS_API_KEY
  try {
    assert.equal(planningAlertsSource.isConfigured, false)
    assert.match(planningAlertsSource.unavailableReason({ ...PROFILE, baseLat: null, baseLng: null }) ?? '', /base location/)
    assert.equal(planningAlertsSource.unavailableReason(PROFILE), null)
  } finally {
    if (saved !== undefined) process.env.PLANNINGALERTS_API_KEY = saved
  }
})

test('PlanningAlerts: queries a bounding box after since_id and advances to the highest id', async () => {
  process.env.PLANNINGALERTS_API_KEY = 'test-key'
  const calls: Call[] = []
  const fetchImpl = fakeFetch(() => [PA_ROW, { application: { ...PA_ROW.application, id: 4999 } }, { application: { ...PA_ROW.application, id: 5003, address: '1 Other Rd, Nundah QLD 4012' } }], calls)
  const r = await planningAlertsSource.fetch({ cursor: '5000', profile: PROFILE, now: NOW, fetchImpl })
  assert.deepEqual(r.items.map(i => i.externalId), ['5001', '5003'], 'ids at or below the cursor are skipped')
  assert.equal(r.nextCursor, '5003')
  const u = new URL(calls[0].url)
  assert.equal(u.searchParams.get('since_id'), '5000')
  assert.equal(u.searchParams.get('key'), 'test-key')
  const box = boundingBox(PROFILE.baseLat!, PROFILE.baseLng!, PROFILE.radiusKm)
  assert.equal(u.searchParams.get('bottom_left_lat'), box.bottomLeftLat.toFixed(5))
  assert.ok(Number(u.searchParams.get('top_right_lng')) > PROFILE.baseLng!)
})

test('PlanningAlerts: stops at the page cap with a warning; bad shape fails loudly', async () => {
  process.env.PLANNINGALERTS_API_KEY = 'test-key'
  let id = 10_000
  const full = fakeFetch(() => Array.from({ length: 100 }, () => ({ application: { ...PA_ROW.application, id: id-- } })))
  const r = await planningAlertsSource.fetch({ cursor: null, profile: PROFILE, now: NOW, fetchImpl: full })
  assert.equal(r.items.length, 1000)
  assert.equal(r.nextCursor, '10000')
  assert.match(r.warning ?? '', /only the newest were read/)

  const bad = fakeFetch(() => ({ applications: [] }))
  await assert.rejects(planningAlertsSource.fetch({ cursor: null, profile: PROFILE, now: NOW, fetchImpl: bad }), /planningalerts: unexpected response shape/)
})

test('request keys: the national feed is shared, the local one is per area', () => {
  const a = austenderSource.requestKey({ cursor: 'x', profile: PROFILE, now: NOW })
  const b = austenderSource.requestKey({ cursor: 'x', profile: { ...PROFILE, baseLat: -33 }, now: NOW })
  assert.equal(a, b)
  const c = planningAlertsSource.requestKey({ cursor: 'x', profile: PROFILE, now: NOW })
  const d = planningAlertsSource.requestKey({ cursor: 'x', profile: { ...PROFILE, baseLat: -33 }, now: NOW })
  assert.notEqual(c, d)
})
