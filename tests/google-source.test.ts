// Unit tests for the Google Places discovery provider: response mapping and —
// importantly — that failures THROW (so the discover route records a FAILED
// DiscoveryRun) rather than being swallowed into an empty result.

import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { getSource } from '../packages/backend-core/src/lib/prospectSources.ts'
import { _resetProviderQuotaForTest } from '../packages/backend-core/src/lib/providerQuota.ts'

const origFetch = globalThis.fetch
const origKey = process.env.GOOGLE_PLACES_API_KEY
const origQuotaEnv = process.env.PROVIDER_QUOTA_GOOGLE_PLACES_PER_HOUR

afterEach(() => {
  globalThis.fetch = origFetch
  if (origKey === undefined) delete process.env.GOOGLE_PLACES_API_KEY
  else process.env.GOOGLE_PLACES_API_KEY = origKey
  if (origQuotaEnv === undefined) delete process.env.PROVIDER_QUOTA_GOOGLE_PLACES_PER_HOUR
  else process.env.PROVIDER_QUOTA_GOOGLE_PLACES_PER_HOUR = origQuotaEnv
  _resetProviderQuotaForTest()
})

test('google maps places to candidates and drops permanently-closed/nameless ones', async () => {
  process.env.GOOGLE_PLACES_API_KEY = 'k'
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ({ places: [
      { id: '1', displayName: { text: 'Acme Electric' }, formattedAddress: 'Sydney NSW', websiteUri: 'https://www.acme.com.au/x', types: ['electrician', 'point_of_interest'], businessStatus: 'OPERATIONAL' },
      { id: '2', displayName: { text: 'Closed Co' }, businessStatus: 'CLOSED_PERMANENTLY' },
    ] }),
  })) as unknown as typeof fetch

  const out = await getSource('google_places')!.search({ industries: ['electricians'], locations: ['Sydney'], limit: 10 })
  assert.equal(out.length, 1)
  assert.equal(out[0].companyName, 'Acme Electric')
  assert.equal(out[0].domain, 'acme.com.au')
})

test('google throws on a non-OK response (surfaced as a FAILED discovery run)', async () => {
  process.env.GOOGLE_PLACES_API_KEY = 'k'
  globalThis.fetch = (async () => ({ ok: false, status: 429, statusText: 'rate', text: async () => 'quota exceeded' })) as unknown as typeof fetch
  await assert.rejects(
    () => getSource('google_places')!.search({ industries: ['x'], locations: ['y'], limit: 10 }),
    /google_places places:searchText 429/,
  )
})

test('google returns [] when not configured', async () => {
  delete process.env.GOOGLE_PLACES_API_KEY
  assert.deepEqual(await getSource('google_places')!.search({ limit: 10 }), [])
})

test('google enforces the platform-wide provider quota before calling out', async () => {
  process.env.GOOGLE_PLACES_API_KEY = 'k'
  process.env.PROVIDER_QUOTA_GOOGLE_PLACES_PER_HOUR = '1'
  let fetchCalls = 0
  globalThis.fetch = (async () => {
    fetchCalls++
    return { ok: true, json: async () => ({ places: [] }) }
  }) as unknown as typeof fetch

  const src = getSource('google_places')!
  await src.search({ industries: ['x'], locations: ['y'], limit: 10 }) // 1st: under quota
  await assert.rejects(
    () => src.search({ industries: ['x'], locations: ['y'], limit: 10 }), // 2nd: exhausted
    (err: any) => {
      assert.equal(err.statusCode, 429)
      assert.match(err.message, /Platform-wide hourly quota for google_places reached/)
      return true
    },
  )
  assert.equal(fetchCalls, 1, 'the provider must not be called once the quota is exhausted')
})
