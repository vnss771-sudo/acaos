// Regression tests for the Australian-readiness audit defects D1, D3, D4, D5, D6.
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { FetchTimeoutError, redactUrl } from '../packages/backend-core/src/lib/fetchWithTimeout.ts'
import { callProvider, parseRetryAfterMs, ProviderError } from '../packages/backend-core/src/lib/providerClient.ts'
import { hasConsent, bulkCheckConsent } from '../packages/backend-core/src/lib/consent.ts'
import { retentionWindows, OUTREACH_SENT_MIN_DAYS } from '../packages/backend-core/src/lib/retention.ts'
import { downgradeUnverifiedEvidence } from '../packages/backend-core/src/lib/leadEvidence.ts'
import { createFakePrisma, installPrisma, resetPrisma } from './helpers/integration.ts'

afterEach(() => resetPrisma())

// ── D1 ────────────────────────────────────────────────────────────────────────
test('D1: FetchTimeoutError message never contains the query string', () => {
  const err = new FetchTimeoutError('https://www.planningalerts.org.au/api/applications.json?key=secret&page=1', 1000)
  assert.ok(!err.message.includes('secret'))
  assert.ok(!err.message.includes('key='))
  assert.match(err.message, /planningalerts\.org\.au\/api\/applications\.json/)
})

test('D1: redactUrl strips userinfo, query and fragment; tolerates junk', () => {
  assert.equal(redactUrl('https://u:p@x.com/a/b?key=1#f'), 'https://x.com/a/b')
  assert.equal(redactUrl('not a url?key=1'), 'not a url')
})

// ── D3 ────────────────────────────────────────────────────────────────────────
test('D3: hasConsent and bulkCheckConsent only query qualifying bases', async () => {
  const seen: any[] = []
  installPrisma(createFakePrisma({
    consentRecord: {
      findFirst: async (a: any) => { seen.push(a.where.basis); return null },
      findMany: async (a: any) => { seen.push(a.where.basis); return [] },
    },
  }))
  await hasConsent('ws1', 'a@x.com')
  await bulkCheckConsent('ws1', ['a@x.com'])
  for (const b of seen) {
    assert.deepEqual(b.in, ['express_consent', 'implied_consent'])
    assert.ok(!b.in.includes('legitimate_interest'))
  }
})

// ── D4 ────────────────────────────────────────────────────────────────────────
test('D4: confirmed evidence is downgraded to inferred with no sourceUrl when nothing was fetched', () => {
  const out = downgradeUnverifiedEvidence([
    { signal: 'Offers 24/7 callouts', type: 'confirmed', confidence: 'high', sourceUrl: 'https://acme.example/x' },
    { signal: 'Seen in notes', type: 'observed', confidence: 'medium' },
  ] as any)
  assert.equal(out[0].type, 'inferred')
  assert.equal((out[0] as any).sourceUrl, undefined)
  assert.equal(out[1].type, 'observed')
  assert.equal(out.filter((e) => e.type === 'confirmed').length, 0)
})

test('D4: confirmed is kept when fetched content covers that host', () => {
  const [e] = downgradeUnverifiedEvidence(
    [{ signal: 's', type: 'confirmed', confidence: 'high', sourceUrl: 'https://acme.example/x' }] as any,
    ['https://acme.example/'],
  )
  assert.equal(e.type, 'confirmed')
})

// ── D5 ────────────────────────────────────────────────────────────────────────
test('D5: outreach-sent retention is floored at 60 days', () => {
  const prev = process.env.RETENTION_OUTREACH_SENT_DAYS
  const warn = console.warn
  console.warn = () => {}
  try {
    process.env.RETENTION_OUTREACH_SENT_DAYS = '7'
    assert.equal(retentionWindows().outreachSentDays, OUTREACH_SENT_MIN_DAYS)
    process.env.RETENTION_OUTREACH_SENT_DAYS = '900'
    assert.equal(retentionWindows().outreachSentDays, 900)
    delete process.env.RETENTION_OUTREACH_SENT_DAYS
    assert.equal(retentionWindows().outreachSentDays, 548)
  } finally {
    console.warn = warn
    if (prev === undefined) delete process.env.RETENTION_OUTREACH_SENT_DAYS
    else process.env.RETENTION_OUTREACH_SENT_DAYS = prev
  }
})

// ── D6 ────────────────────────────────────────────────────────────────────────
const res = (status: number, headers: Record<string, string> = {}) => new Response('x', { status, headers })

test('D6: parseRetryAfterMs handles seconds, dates and junk', () => {
  assert.equal(parseRetryAfterMs('2'), 2000)
  assert.equal(parseRetryAfterMs(new Date(10_000).toUTCString(), 4_000), 6000)
  assert.equal(parseRetryAfterMs('soon'), null)
  assert.equal(parseRetryAfterMs(null), null)
})

test('D6: 429 with Retry-After waits that long (capped) instead of the fixed backoff', async () => {
  const waits: number[] = []
  const responses = [res(429, { 'retry-after': '2' }), res(200)]
  const out = await callProvider({
    provider: 'p', operation: 'o', url: 'https://x.test',
    fetchImpl: async () => responses.shift()!,
    sleepImpl: async (ms) => { waits.push(ms) },
    onSuccess: () => 'ok',
  })
  assert.equal(out, 'ok')
  assert.deepEqual(waits, [2000])

  const capped: number[] = []
  const r2 = [res(429, { 'retry-after': '3600' }), res(200)]
  await callProvider({
    provider: 'p', operation: 'o', url: 'https://x.test', maxBackoffMs: 5000,
    fetchImpl: async () => r2.shift()!, sleepImpl: async (ms) => { capped.push(ms) }, onSuccess: () => 'ok',
  })
  assert.deepEqual(capped, [5000])
})

test('D6: backoff is jittered within [0, base*2^i]', async () => {
  const waits: number[] = []
  const r = [res(503), res(503), res(200)]
  await callProvider({
    provider: 'p', operation: 'o', url: 'https://x.test', baseBackoffMs: 200, randomImpl: () => 0.5,
    fetchImpl: async () => r.shift()!, sleepImpl: async (ms) => { waits.push(ms) }, onSuccess: () => 'ok',
  })
  assert.deepEqual(waits, [100, 200])
})

test('D6: POST timeout is not retried unless retryUnsafe', async () => {
  const { FetchTimeoutError: Timeout } = await import('../packages/backend-core/src/lib/fetchWithTimeout.ts')
  let calls = 0
  const base = {
    provider: 'p', operation: 'o', url: 'https://x.test', init: { method: 'POST' },
    fetchImpl: async () => { calls++; throw new Timeout('https://x.test', 1) },
    sleepImpl: async () => {}, onSuccess: () => 'ok',
  }
  await assert.rejects(callProvider(base), ProviderError)
  assert.equal(calls, 1)
  calls = 0
  await assert.rejects(callProvider({ ...base, retryUnsafe: true }), ProviderError)
  assert.equal(calls, 3)
})
