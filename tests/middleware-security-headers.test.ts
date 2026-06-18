// Unit tests for the securityHeaders middleware. For a JSON-only API the
// strictest CSP is safe, and HSTS must only be emitted over real TLS
// (production) — sending it on a plain-HTTP dev host would wrongly pin browsers
// to https. We assert both the always-on headers and the production-gated HSTS.

import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import type { Request, Response } from 'express'
import { securityHeaders } from '../apps/api/src/middleware/securityHeaders.ts'

// Capture setHeader calls; record next() invocation.
function run() {
  const headers: Record<string, string> = {}
  const res = { setHeader(k: string, v: string) { headers[k] = v } } as unknown as Response
  let nextCalled = false
  securityHeaders({} as Request, res, () => { nextCalled = true })
  return { headers, nextCalled }
}

const savedEnv = process.env.NODE_ENV
afterEach(() => { process.env.NODE_ENV = savedEnv })

test('sets the always-on hardening headers and calls next()', () => {
  process.env.NODE_ENV = 'test'
  const { headers, nextCalled } = run()
  assert.equal(headers['X-Content-Type-Options'], 'nosniff')
  assert.equal(headers['X-Frame-Options'], 'DENY')
  assert.equal(headers['Referrer-Policy'], 'no-referrer')
  assert.equal(headers['Cross-Origin-Opener-Policy'], 'same-origin')
  assert.equal(headers['X-DNS-Prefetch-Control'], 'off')
  assert.equal(nextCalled, true)
})

test('emits a locked-down CSP that forbids all sources and framing', () => {
  process.env.NODE_ENV = 'test'
  const { headers } = run()
  assert.match(headers['Content-Security-Policy'], /default-src 'none'/)
  assert.match(headers['Content-Security-Policy'], /frame-ancestors 'none'/)
})

test('does NOT send HSTS outside production', () => {
  process.env.NODE_ENV = 'development'
  const { headers } = run()
  assert.equal(headers['Strict-Transport-Security'], undefined)
})

test('sends a one-year includeSubDomains HSTS header in production', () => {
  process.env.NODE_ENV = 'production'
  const { headers } = run()
  assert.equal(headers['Strict-Transport-Security'], 'max-age=31536000; includeSubDomains')
})
