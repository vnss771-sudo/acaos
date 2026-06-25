import test from 'node:test'
import assert from 'node:assert/strict'
import { parseSentryDsn, buildSentryEvent, createReportGate, errorSignature } from '../packages/backend-core/src/lib/sentryTransport.ts'

function fakeClock(start = 0) {
  let t = start
  return { now: () => t, advance: (ms: number) => { t += ms } }
}

test('errorSignature is stable for the same error and distinguishes different ones', () => {
  assert.equal(errorSignature(new TypeError('boom')), 'TypeError:boom')
  assert.equal(errorSignature(new TypeError('boom')), errorSignature(new TypeError('boom')))
  assert.notEqual(errorSignature(new Error('a')), errorSignature(new Error('b')))
  assert.equal(errorSignature('a string'), 'a string')
  assert.equal(errorSignature(42), 'non-error')
})

test('createReportGate dedups identical errors within the window', () => {
  const clock = fakeClock()
  const gate = createReportGate({ burst: 100, ratePerMin: 6000, dedupMs: 5000, now: clock.now })
  assert.equal(gate.allow('E:x'), true)   // first passes
  assert.equal(gate.allow('E:x'), false)  // duplicate within window suppressed
  assert.equal(gate.allow('E:y'), true)   // a different error still passes
  clock.advance(5000)
  assert.equal(gate.allow('E:x'), true)   // window elapsed → allowed again
})

test('createReportGate caps a burst via the token bucket', () => {
  const clock = fakeClock()
  // burst of 3, slow refill; use distinct signatures so dedup never fires.
  const gate = createReportGate({ burst: 3, ratePerMin: 1, dedupMs: 0, now: clock.now })
  assert.equal(gate.allow('s1'), true)
  assert.equal(gate.allow('s2'), true)
  assert.equal(gate.allow('s3'), true)
  assert.equal(gate.allow('s4'), false) // bucket empty → dropped
  // After 60s, ratePerMin=1 refills exactly one token.
  clock.advance(60_000)
  assert.equal(gate.allow('s5'), true)
  assert.equal(gate.allow('s6'), false)
})

test('parseSentryDsn builds the store endpoint + public key', () => {
  const t = parseSentryDsn('https://abc123@o42.ingest.sentry.io/777')
  assert.deepEqual(t, { ingestUrl: 'https://o42.ingest.sentry.io/api/777/store/', publicKey: 'abc123' })
})

test('parseSentryDsn handles a path prefix', () => {
  const t = parseSentryDsn('https://key@sentry.example.com/base/12')
  assert.equal(t?.ingestUrl, 'https://sentry.example.com/base/api/12/store/')
})

test('parseSentryDsn returns null for malformed input', () => {
  for (const bad of ['not-a-url', 'https://sentry.io/0' /* no key */, 'https://key@sentry.io/' /* no project */]) {
    assert.equal(parseSentryDsn(bad), null, bad)
  }
})

test('buildSentryEvent captures type/message and stack in extra', () => {
  const err = new TypeError('boom')
  const ev = buildSentryEvent(err, { route: '/x' }, { environment: 'production', release: '1.2.3' })
  assert.equal(ev.level, 'error')
  assert.equal(ev.exception.values[0].type, 'TypeError')
  assert.equal(ev.exception.values[0].value, 'boom')
  assert.equal(ev.extra.route, '/x')
  assert.ok(typeof ev.extra.stack === 'string')
  assert.equal(ev.environment, 'production')
  assert.match(ev.event_id, /^[0-9a-f]{32}$/)
})

test('buildSentryEvent tolerates a non-Error thrown value', () => {
  const ev = buildSentryEvent('just a string', undefined)
  assert.equal(ev.exception.values[0].value, 'just a string')
})
