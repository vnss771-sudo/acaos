import { describe, test, expect } from 'vitest'
import { parseSentryDsn, buildBrowserEvent, createBrowserReportGate, isErrorReportingEnabled, reportError } from './errorReporting.js'

describe('parseSentryDsn', () => {
  test('builds the store URL with the key in the query string', () => {
    const t = parseSentryDsn('https://abc123@o42.ingest.sentry.io/4507')
    expect(t?.ingestUrl).toBe('https://o42.ingest.sentry.io/api/4507/store/?sentry_version=7&sentry_client=acaos-web%2F1.0&sentry_key=abc123')
  })
  test('keeps a path prefix for self-hosted Sentry', () => {
    expect(parseSentryDsn('https://k@sentry.example.com/sub/7')?.ingestUrl).toMatch(/^https:\/\/sentry\.example\.com\/sub\/api\/7\/store\/\?/)
  })
  test('rejects missing, malformed, keyless and non-HTTPS DSNs', () => {
    expect(parseSentryDsn(undefined)).toBeNull()
    expect(parseSentryDsn('')).toBeNull()
    expect(parseSentryDsn('not a url')).toBeNull()
    expect(parseSentryDsn('https://o42.ingest.sentry.io/4507')).toBeNull()
    expect(parseSentryDsn('http://k@o42.ingest.sentry.io/4507')).toBeNull()
  })
})

describe('buildBrowserEvent', () => {
  test('reports the page path without its query string or fragment', () => {
    window.history.pushState({}, '', '/reset-password?token=secret#frag')
    const event = buildBrowserEvent(new TypeError('boom'), { source: 'test' }, { environment: 'production', release: 'abc' })
    expect(event.request?.url).toBe(`${window.location.origin}/reset-password`)
    expect(JSON.stringify(event)).not.toContain('secret')
    expect(event.exception.values[0]).toEqual({ type: 'TypeError', value: 'boom' })
    expect(event.extra.source).toBe('test')
    expect(event.release).toBe('abc')
    expect(event.event_id).toMatch(/^[0-9a-f]{32}$/)
  })
  test('wraps non-Error values', () => {
    expect(buildBrowserEvent('plain', undefined).exception.values[0].value).toBe('plain')
    expect(buildBrowserEvent({ x: 1 }, undefined).exception.values[0].value).toBe('Non-error thrown')
  })
})

describe('createBrowserReportGate', () => {
  test('reports each distinct error once, up to the cap', () => {
    const gate = createBrowserReportGate(2)
    expect(gate.allow('a')).toBe(true)
    expect(gate.allow('a')).toBe(false)
    expect(gate.allow('b')).toBe(true)
    expect(gate.allow('c')).toBe(false)
  })
})

test('is a no-op without VITE_SENTRY_DSN', () => {
  expect(isErrorReportingEnabled()).toBe(false)
  expect(() => reportError(new Error('x'))).not.toThrow()
})
