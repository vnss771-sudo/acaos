// Unit tests for the prospect-source REGISTRY and request shaping. The
// per-provider response mapping is covered by apollo-source/google-source tests;
// here we pin the registry (getSource/listSources/getConfiguredSources), the
// always-available CSV + stubbed Hunter providers, and the outbound request
// bodies the providers build (employee-range defaults, per_page caps, the
// Google "industry in location" text query) — all with a stubbed fetch.

import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  getSource, listSources, getConfiguredSources,
} from '../apps/api/src/lib/prospectSources.ts'

const KEYS = ['APOLLO_API_KEY', 'HUNTER_API_KEY', 'GOOGLE_PLACES_API_KEY']
const origFetch = globalThis.fetch
const orig = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
afterEach(() => {
  globalThis.fetch = origFetch
  for (const k of KEYS) { if (orig[k] === undefined) delete process.env[k]; else process.env[k] = orig[k] }
})

// Capture the body of the next fetch call and return a canned ok response.
function captureFetch(json: unknown = {}) {
  const calls: { url: string; init: any }[] = []
  globalThis.fetch = (async (url: string, init: any) => {
    calls.push({ url, init })
    return { ok: true, status: 200, json: async () => json, text: async () => '' }
  }) as unknown as typeof fetch
  return calls
}

// ── Registry ─────────────────────────────────────────────────────────────────

test('listSources exposes every built-in provider with stable name/label', () => {
  const names = listSources().map((s) => s.name)
  assert.deepEqual(names.sort(), ['apollo', 'csv', 'google_places', 'hunter'])
  assert.equal(listSources().find((s) => s.name === 'csv')?.label, 'CSV Import')
})

test('listSources reflects configuration state from the environment', () => {
  delete process.env.APOLLO_API_KEY
  assert.equal(listSources().find((s) => s.name === 'apollo')?.isConfigured, false)
  process.env.APOLLO_API_KEY = 'k'
  assert.equal(listSources().find((s) => s.name === 'apollo')?.isConfigured, true)
})

test('getSource returns the provider by name, or undefined for an unknown source', () => {
  assert.equal(getSource('apollo')?.name, 'apollo')
  assert.equal(getSource('nope'), undefined)
})

test('getConfiguredSources always includes CSV and excludes unconfigured providers', () => {
  for (const k of KEYS) delete process.env[k]
  const names = getConfiguredSources().map((s) => s.name)
  assert.ok(names.includes('csv'), 'CSV import is always available')
  assert.ok(!names.includes('apollo'), 'apollo excluded without a key')
  assert.ok(!names.includes('google_places'))
})

test('getConfiguredSources includes a provider once its key is present', () => {
  process.env.APOLLO_API_KEY = 'k'
  assert.ok(getConfiguredSources().map((s) => s.name).includes('apollo'))
})

// ── CSV + Hunter providers ───────────────────────────────────────────────────

test('the CSV provider is always configured and returns no search results', async () => {
  const csv = getSource('csv')!
  assert.equal(csv.isConfigured, true)
  assert.deepEqual(await csv.search({ limit: 10 }), [])
})

test('Hunter is configured by key but returns [] (domain-lookup, not discovery)', async () => {
  process.env.HUNTER_API_KEY = 'k'
  const hunter = getSource('hunter')!
  assert.equal(hunter.isConfigured, true)
  assert.deepEqual(await hunter.search({ keywords: ['x'], limit: 10 }), [])
})

// ── Apollo request shaping ───────────────────────────────────────────────────

test('Apollo builds the search body with filters, default employee range, and a per_page cap', async () => {
  process.env.APOLLO_API_KEY = 'k'
  const calls = captureFetch({ organizations: [] })
  await getSource('apollo')!.search({
    industries: ['SaaS'], locations: ['TX'], keywords: ['crm', 'sales'],
    minEmployees: 10, // maxEmployees omitted → default 99999
    limit: 500,       // above the 50 cap
  })
  const body = JSON.parse(calls[0].init.body)
  assert.deepEqual(body.q_organization_industries, ['SaaS'])
  assert.deepEqual(body.q_organization_locations, ['TX'])
  assert.equal(body.q_keywords, 'crm sales')                       // keywords joined by space
  assert.deepEqual(body.organization_num_employees_ranges, ['10,99999']) // min set, max defaulted
  assert.equal(body.per_page, 50)                                  // capped at 50
  assert.equal(calls[0].init.headers['x-api-key'], 'k')
})

test('Apollo omits range/keyword fields when no such filters are supplied', async () => {
  process.env.APOLLO_API_KEY = 'k'
  const calls = captureFetch({ organizations: [] })
  await getSource('apollo')!.search({ limit: 5 })
  const body = JSON.parse(calls[0].init.body)
  assert.equal('q_keywords' in body, false)
  assert.equal('organization_num_employees_ranges' in body, false)
  assert.equal(body.per_page, 5)
})

// ── Google Places query shaping ──────────────────────────────────────────────

test('Google composes an "industry in location" text query and caps pageSize at 20', async () => {
  process.env.GOOGLE_PLACES_API_KEY = 'k'
  const calls = captureFetch({ places: [] })
  await getSource('google_places')!.search({ industries: ['electricians'], locations: ['Sydney'], limit: 100 })
  const body = JSON.parse(calls[0].init.body)
  assert.equal(body.textQuery, 'electricians in Sydney')
  assert.equal(body.pageSize, 20) // min(limit, 20)
})

test('Google falls back to the first keyword when no industry is given', async () => {
  process.env.GOOGLE_PLACES_API_KEY = 'k'
  const calls = captureFetch({ places: [] })
  await getSource('google_places')!.search({ keywords: ['plumbers'], locations: ['Perth'], limit: 5 })
  assert.equal(JSON.parse(calls[0].init.body).textQuery, 'plumbers in Perth')
})

test('Google short-circuits to [] (no fetch) when neither industry nor location is provided', async () => {
  process.env.GOOGLE_PLACES_API_KEY = 'k'
  const calls = captureFetch({ places: [] })
  const out = await getSource('google_places')!.search({ limit: 10 })
  assert.deepEqual(out, [])
  assert.equal(calls.length, 0, 'must not hit the network without a query')
})
