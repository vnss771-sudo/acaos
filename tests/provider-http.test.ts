// Unit tests for the shared provider HTTP client: transient retry, non-retryable
// passthrough, retry-exhaustion, network/timeout normalization, response-size
// bound, and circuit-breaker integration. Stubbed global fetch; no network.

import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { providerFetch, ProviderHttpError } from '../packages/backend-core/src/lib/providerHttp.ts'
import { CircuitBreaker, CircuitOpenError } from '../packages/backend-core/src/lib/circuit.ts'

const origFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = origFetch })

// Queue of responses/errors; each fetch call shifts the next. A function entry
// is invoked (to throw); a Response entry is returned. Tracks the call count.
function stub(seq: Array<Response | (() => never)>) {
  let calls = 0
  globalThis.fetch = (async () => {
    const next = seq[Math.min(calls, seq.length - 1)]
    calls++
    if (typeof next === 'function') return next()
    return next
  }) as unknown as typeof fetch
  return { calls: () => calls }
}

const FAST = { provider: 'test', timeoutMs: 100, retries: 2 } as const

test('returns a 2xx response on the first attempt', async () => {
  const s = stub([new Response('{}', { status: 200 })])
  const res = await providerFetch('https://x.test', {}, FAST)
  assert.equal(res.status, 200)
  assert.equal(s.calls(), 1)
})

test('returns a non-retryable 4xx immediately without retrying', async () => {
  const s = stub([new Response('bad', { status: 400 })])
  const res = await providerFetch('https://x.test', {}, FAST)
  assert.equal(res.status, 400)
  assert.equal(s.calls(), 1)
})

test('retries a 429 then returns the eventual 200', async () => {
  const s = stub([new Response('', { status: 429 }), new Response('{}', { status: 200 })])
  const res = await providerFetch('https://x.test', {}, FAST)
  assert.equal(res.status, 200)
  assert.equal(s.calls(), 2)
})

test('returns the final response after exhausting retries on persistent 503', async () => {
  const s = stub([new Response('', { status: 503 })])
  const res = await providerFetch('https://x.test', {}, { provider: 'test', timeoutMs: 100, retries: 2 })
  assert.equal(res.status, 503)
  assert.equal(s.calls(), 3) // 1 + 2 retries
})

test('throws a normalized network error after retries', async () => {
  stub([() => { throw new Error('ECONNRESET') }])
  await assert.rejects(
    providerFetch('https://x.test', {}, FAST),
    (e: unknown) => e instanceof ProviderHttpError && e.kind === 'network',
  )
})

test('classifies an abort/timeout as kind=timeout', async () => {
  stub([() => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }) }])
  await assert.rejects(
    providerFetch('https://x.test', {}, FAST),
    (e: unknown) => e instanceof ProviderHttpError && e.kind === 'timeout',
  )
})

test('rejects an over-large response by Content-Length', async () => {
  stub([new Response('x', { status: 200, headers: { 'content-length': '99999999' } })])
  await assert.rejects(
    providerFetch('https://x.test', {}, { provider: 'test', maxBytes: 1000 }),
    (e: unknown) => e instanceof ProviderHttpError && e.kind === 'oversize',
  )
})

test('an open circuit breaker short-circuits before fetching', async () => {
  const breaker = new CircuitBreaker('test-cb', 1, 60_000)
  await breaker.call(() => Promise.reject(new Error('boom'))).catch(() => {}) // trip OPEN
  const s = stub([new Response('{}', { status: 200 })])
  await assert.rejects(
    providerFetch('https://x.test', {}, { provider: 'test', breaker }),
    CircuitOpenError,
  )
  assert.equal(s.calls(), 0) // never reached fetch
})
