import test from 'node:test'
import assert from 'node:assert/strict'
import { parseSentryDsn, buildSentryEvent } from '../packages/backend-core/src/lib/sentryTransport.ts'

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
