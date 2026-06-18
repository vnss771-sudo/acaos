// Unit tests for the Hunter.io email-verifier wrapper: verdict/score mapping and
// fail-soft behaviour (no key / non-OK → null). Stubbed fetch, no network.

import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { verifyEmail } from '../apps/api/src/services/hunter.ts'

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

test('returns null without an API key (no network call)', async () => {
  delete process.env.HUNTER_API_KEY
  assert.equal(await verifyEmail('a@b.test'), null)
})

test('maps a deliverable verdict and score', async () => {
  process.env.HUNTER_API_KEY = 'k'
  stubFetch({ data: { result: 'deliverable', score: 97 } })
  assert.deepEqual(await verifyEmail('a@b.test'), { result: 'deliverable', score: 97 })
})

test('maps a risky verdict', async () => {
  process.env.HUNTER_API_KEY = 'k'
  stubFetch({ data: { result: 'risky', score: 55 } })
  assert.deepEqual(await verifyEmail('a@b.test'), { result: 'risky', score: 55 })
})

test('maps an undeliverable verdict', async () => {
  process.env.HUNTER_API_KEY = 'k'
  stubFetch({ data: { result: 'undeliverable', score: 0 } })
  assert.deepEqual(await verifyEmail('a@b.test'), { result: 'undeliverable', score: 0 })
})

test('falls back to status / unknown when result is absent', async () => {
  process.env.HUNTER_API_KEY = 'k'
  stubFetch({ data: { status: 'accept_all' } })
  assert.deepEqual(await verifyEmail('a@b.test'), { result: 'accept_all', score: 0 })
})

test('returns null on a non-OK response', async () => {
  process.env.HUNTER_API_KEY = 'k'
  stubFetch({}, false)
  assert.equal(await verifyEmail('a@b.test'), null)
})

test('returns null for an empty email', async () => {
  process.env.HUNTER_API_KEY = 'k'
  assert.equal(await verifyEmail(''), null)
})
