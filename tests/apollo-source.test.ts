// Unit tests for the Apollo discovery provider: request building, response
// mapping (apolloOrgToCandidate), and error handling — with a stubbed fetch.

import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { getSource } from '../apps/api/src/lib/prospectSources.ts'

const origFetch = globalThis.fetch
const origKey = process.env.APOLLO_API_KEY

afterEach(() => {
  globalThis.fetch = origFetch
  if (origKey === undefined) delete process.env.APOLLO_API_KEY
  else process.env.APOLLO_API_KEY = origKey
})

test('apollo maps organizations to candidates and drops nameless orgs', async () => {
  process.env.APOLLO_API_KEY = 'k'
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ({ organizations: [
      { id: '1', name: 'Acme', primary_domain: 'acme.com', industry: 'SaaS', estimated_num_employees: 50, current_jobs_count: 3, total_funding: 1_000_000, latest_funding_stage: 'Series A', short_description: 'desc', primary_address: { city: 'Austin', state: 'TX', country: 'USA' } },
      { id: '2' }, // no name -> filtered out
    ] }),
  })) as unknown as typeof fetch

  const src = getSource('apollo')!
  const out = await src.search({ industries: ['SaaS'], locations: ['TX'], keywords: ['crm'], minEmployees: 10, maxEmployees: 100, limit: 25 })
  assert.equal(out.length, 1)
  assert.equal(out[0].companyName, 'Acme')
  assert.equal(out[0].domain, 'acme.com')
  assert.equal(out[0].location, 'Austin, TX, USA')
  assert.equal(out[0].employeeCount, 50)
  assert.equal(out[0].hiringCount, 3)
  assert.equal(out[0].fundingStage, 'Series A')
})

test('apollo returns [] when not configured', async () => {
  delete process.env.APOLLO_API_KEY
  const src = getSource('apollo')!
  assert.deepEqual(await src.search({ limit: 10 }), [])
})

test('apollo throws a descriptive error on a non-OK response', async () => {
  process.env.APOLLO_API_KEY = 'k'
  globalThis.fetch = (async () => ({ ok: false, status: 429, statusText: 'rate', text: async () => 'too many requests' })) as unknown as typeof fetch
  const src = getSource('apollo')!
  await assert.rejects(() => src.search({ limit: 10 }), /Apollo search 429/)
})
