import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { callProvider, ProviderError } from '../apps/api/src/lib/providerClient.ts'
import { FetchTimeoutError } from '../apps/api/src/lib/fetchWithTimeout.ts'
import { resetMetrics, renderMetrics } from '../apps/api/src/lib/metrics.ts'
import { CircuitBreaker, CircuitOpenError } from '../packages/backend-core/src/lib/circuit.ts'

beforeEach(() => resetMetrics())

// Minimal Response stand-in — callProvider only touches ok/status/json/text.
function resp(status: number, body: unknown = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `status ${status}`,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response
}

// A fetchImpl driven by a queue of steps; each step is a Response or a thrown
// error. Tracks how many times it was called so we can assert retry counts.
function scriptedFetch(steps: Array<Response | Error>) {
  const state = { calls: 0 }
  const impl = async () => {
    const step = steps[Math.min(state.calls, steps.length - 1)]
    state.calls++
    if (step instanceof Error) throw step
    return step
  }
  return { impl, state }
}

const noSleep = async () => {}

test('returns the parsed body and meters a success on a 2xx', async () => {
  const { impl } = scriptedFetch([resp(200, { hello: 'world' })])
  const out = await callProvider<string>({
    provider: 'apollo', operation: 'enrich', url: 'https://x.test',
    fetchImpl: impl, sleepImpl: noSleep,
    onSuccess: async (r) => ((await r.json()) as { hello: string }).hello,
  })
  assert.equal(out, 'world')
  assert.match(renderMetrics(), /provider_calls_total\{provider="apollo",operation="enrich",outcome="success"\} 1/)
})

test('retries a 429 with backoff and then succeeds', async () => {
  const { impl, state } = scriptedFetch([resp(429), resp(200, { ok: true })])
  const out = await callProvider<boolean>({
    provider: 'apollo', operation: 'search', url: 'https://x.test',
    fetchImpl: impl, sleepImpl: noSleep,
    onSuccess: async (r) => ((await r.json()) as { ok: boolean }).ok,
  })
  assert.equal(out, true)
  assert.equal(state.calls, 2, 'should have retried exactly once')
})

test('exhausts retries on persistent 503 and throws a typed, retryable ProviderError', async () => {
  const { impl, state } = scriptedFetch([resp(503), resp(503)])
  await assert.rejects(
    () => callProvider({
      provider: 'hunter', operation: 'domain-search', url: 'https://x.test',
      retries: 1, fetchImpl: impl, sleepImpl: noSleep, onSuccess: () => 'unused',
    }),
    (err: unknown) => {
      assert.ok(err instanceof ProviderError)
      assert.equal((err as ProviderError).kind, 'server_error')
      assert.equal((err as ProviderError).providerStatus, 503)
      assert.equal((err as ProviderError).statusCode, 503, 'transient → 503 to the client')
      assert.equal((err as ProviderError).retryable, true)
      return true
    },
  )
  assert.equal(state.calls, 2)
  assert.match(renderMetrics(), /provider_calls_total\{provider="hunter",operation="domain-search",outcome="server_error"\} 1/)
})

test('classifies a timeout and retries it', async () => {
  const { impl, state } = scriptedFetch([new FetchTimeoutError('https://x.test', 10), new FetchTimeoutError('https://x.test', 10)])
  await assert.rejects(
    () => callProvider({
      provider: 'apollo', operation: 'enrich', url: 'https://x.test',
      retries: 1, fetchImpl: impl, sleepImpl: noSleep, onSuccess: () => 'unused',
    }),
    (err: unknown) => err instanceof ProviderError && (err as ProviderError).kind === 'timeout',
  )
  assert.equal(state.calls, 2)
})

test('classifies a non-timeout throw as a network error', async () => {
  const { impl } = scriptedFetch([new Error('ECONNRESET')])
  await assert.rejects(
    () => callProvider({
      provider: 'apollo', operation: 'enrich', url: 'https://x.test',
      retries: 0, fetchImpl: impl, sleepImpl: noSleep, onSuccess: () => 'unused',
    }),
    (err: unknown) => err instanceof ProviderError && (err as ProviderError).kind === 'network',
  )
})

test('a terminal 4xx throws a non-retryable client_error (502) by default', async () => {
  const { impl, state } = scriptedFetch([resp(404, 'not found')])
  await assert.rejects(
    () => callProvider({
      provider: 'apollo', operation: 'enrich', url: 'https://x.test',
      fetchImpl: impl, sleepImpl: noSleep, onSuccess: () => 'unused',
    }),
    (err: unknown) => {
      assert.ok(err instanceof ProviderError)
      assert.equal((err as ProviderError).kind, 'client_error')
      assert.equal((err as ProviderError).statusCode, 502)
      assert.equal((err as ProviderError).retryable, false)
      return true
    },
  )
  assert.equal(state.calls, 1, 'a 4xx must not be retried')
})

test('onClientError maps a terminal 4xx to a legitimate value instead of throwing', async () => {
  const { impl } = scriptedFetch([resp(404)])
  const out = await callProvider<string | null>({
    provider: 'hunter', operation: 'domain-search', url: 'https://x.test',
    fetchImpl: impl, sleepImpl: noSleep,
    onClientError: () => null,
    onSuccess: () => 'contact',
  })
  assert.equal(out, null)
  // Still metered as client_error so the rate stays visible to operators.
  assert.match(renderMetrics(), /provider_calls_total\{provider="hunter",operation="domain-search",outcome="client_error"\} 1/)
})

test('surfaces an already-open breaker as a circuit_open ProviderError', async () => {
  const openBreaker = { call: () => { throw new CircuitOpenError('apollo', 1000) } }
  const { impl, state } = scriptedFetch([resp(200)])
  await assert.rejects(
    () => callProvider({
      provider: 'apollo', operation: 'enrich', url: 'https://x.test',
      breaker: openBreaker, fetchImpl: impl, sleepImpl: noSleep, onSuccess: () => 'x',
    }),
    (err: unknown) => err instanceof ProviderError && (err as ProviderError).kind === 'circuit_open' && (err as ProviderError).statusCode === 503,
  )
  assert.equal(state.calls, 0, 'an open circuit must not call the provider')
  assert.match(renderMetrics(), /provider_calls_total\{provider="apollo",operation="enrich",outcome="circuit_open"\} 1/)
})

test('integrates with a real CircuitBreaker: repeated failures trip it open', async () => {
  const breaker = new CircuitBreaker('test-provider', 2, 60_000)
  const { impl } = scriptedFetch([resp(500)]) // always 500
  const callOnce = () => callProvider({
    provider: 'test', operation: 'op', url: 'https://x.test',
    retries: 0, breaker, fetchImpl: impl, sleepImpl: noSleep, onSuccess: () => 'x',
  })

  // Two server_error failures reach the threshold and trip the breaker.
  await assert.rejects(callOnce, (e: unknown) => e instanceof ProviderError && (e as ProviderError).kind === 'server_error')
  await assert.rejects(callOnce, (e: unknown) => e instanceof ProviderError && (e as ProviderError).kind === 'server_error')
  // The breaker is now OPEN, so the next call short-circuits without a fetch.
  await assert.rejects(callOnce, (e: unknown) => e instanceof ProviderError && (e as ProviderError).kind === 'circuit_open')
})
