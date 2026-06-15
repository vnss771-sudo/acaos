// Unit tests for the Hunter.io contact-finder: response mapping + best-contact
// selection, exercised with a stubbed fetch (no network). Genuine logic that the
// service-less fast suite otherwise can't reach.

import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { findContactEmail, isHunterConfigured } from '../apps/api/src/services/hunter.ts'

const origFetch = globalThis.fetch
const origKey = process.env.HUNTER_API_KEY

afterEach(() => {
  globalThis.fetch = origFetch
  if (origKey === undefined) delete process.env.HUNTER_API_KEY
  else process.env.HUNTER_API_KEY = origKey
})

function stubFetch(payload: unknown, ok = true) {
  globalThis.fetch = (async () => ({ ok, json: async () => payload })) as unknown as typeof fetch
}

test('returns null and reports not-configured without an API key', async () => {
  delete process.env.HUNTER_API_KEY
  assert.equal(isHunterConfigured(), false)
  assert.equal(await findContactEmail('acme.test'), null)
})

test('selects the highest-confidence email at or above the threshold', async () => {
  process.env.HUNTER_API_KEY = 'k'
  stubFetch({ data: { emails: [
    { value: 'low@a.test', confidence: 55, first_name: 'Lo' },
    { value: 'best@a.test', confidence: 92, first_name: 'Be', last_name: 'St', position: 'CEO' },
    { value: 'weak@a.test', confidence: 20 },
  ] } })
  const c = await findContactEmail('a.test')
  assert.equal(c?.email, 'best@a.test')
  assert.equal(c?.confidence, 92)
  assert.equal(c?.position, 'CEO')
  assert.equal(c?.lastName, 'St')
})

test('returns null on a non-OK response', async () => {
  process.env.HUNTER_API_KEY = 'k'
  stubFetch({}, false)
  assert.equal(await findContactEmail('a.test'), null)
})

test('returns null when no email clears the confidence bar', async () => {
  process.env.HUNTER_API_KEY = 'k'
  stubFetch({ data: { emails: [{ value: 'x@a.test', confidence: 10 }] } })
  assert.equal(await findContactEmail('a.test'), null)
})
