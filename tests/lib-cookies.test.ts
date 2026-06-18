// Unit tests for lib/cookies — the HttpOnly refresh-cookie helpers and the CSRF
// header guard. These encode security-sensitive defaults (HttpOnly always on,
// Secure in production / whenever SameSite=None, scoped Path), so the
// env-driven attribute logic is worth pinning precisely.

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import type { Request, Response } from 'express'
import {
  REFRESH_COOKIE, setRefreshCookie, clearRefreshCookie, readCookie, requireCsrfHeader,
} from '../apps/api/src/lib/cookies.ts'

// Minimal Response stub recording cookie()/clearCookie() options.
function fakeRes() {
  const calls: { name: string; value?: string; opts: any }[] = []
  const res = {
    cookie(name: string, value: string, opts: any) { calls.push({ name, value, opts }); return res },
    clearCookie(name: string, opts: any) { calls.push({ name, opts }); return res },
  }
  return { res: res as unknown as Response, calls }
}

const COOKIE_ENV = ['COOKIE_SAMESITE', 'COOKIE_SECURE', 'REFRESH_TOKEN_DAYS', 'NODE_ENV']
let saved: Record<string, string | undefined>
beforeEach(() => { saved = Object.fromEntries(COOKIE_ENV.map((k) => [k, process.env[k]])) })
afterEach(() => {
  for (const k of COOKIE_ENV) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

// ── Attribute defaults ───────────────────────────────────────────────────────

test('setRefreshCookie is always HttpOnly, scoped to /api/auth, with a maxAge', () => {
  delete process.env.NODE_ENV; delete process.env.COOKIE_SECURE; delete process.env.COOKIE_SAMESITE
  const { res, calls } = fakeRes()
  setRefreshCookie(res, 'tok')
  assert.equal(calls[0].name, REFRESH_COOKIE)
  assert.equal(calls[0].value, 'tok')
  assert.equal(calls[0].opts.httpOnly, true)
  assert.equal(calls[0].opts.path, '/api/auth')
  assert.equal(calls[0].opts.sameSite, 'lax') // default
  assert.ok(calls[0].opts.maxAge > 0)
})

test('Secure defaults to false in development and true in production', () => {
  delete process.env.COOKIE_SECURE; delete process.env.COOKIE_SAMESITE

  process.env.NODE_ENV = 'development'
  let f = fakeRes(); setRefreshCookie(f.res, 't')
  assert.equal(f.calls[0].opts.secure, false)

  process.env.NODE_ENV = 'production'
  f = fakeRes(); setRefreshCookie(f.res, 't')
  assert.equal(f.calls[0].opts.secure, true)
})

test('an explicit COOKIE_SECURE override wins over NODE_ENV', () => {
  process.env.NODE_ENV = 'production'
  process.env.COOKIE_SECURE = 'false'
  const f = fakeRes(); setRefreshCookie(f.res, 't')
  assert.equal(f.calls[0].opts.secure, false)
})

test('SameSite=None forces Secure even outside production', () => {
  delete process.env.NODE_ENV; delete process.env.COOKIE_SECURE
  process.env.COOKIE_SAMESITE = 'none'
  const f = fakeRes(); setRefreshCookie(f.res, 't')
  assert.equal(f.calls[0].opts.sameSite, 'none')
  assert.equal(f.calls[0].opts.secure, true) // browsers reject None without Secure
})

test('an unrecognised COOKIE_SAMESITE falls back to lax', () => {
  process.env.COOKIE_SAMESITE = 'bogus'
  const f = fakeRes(); setRefreshCookie(f.res, 't')
  assert.equal(f.calls[0].opts.sameSite, 'lax')
})

test('REFRESH_TOKEN_DAYS controls the cookie maxAge', () => {
  process.env.REFRESH_TOKEN_DAYS = '7'
  const f = fakeRes(); setRefreshCookie(f.res, 't')
  assert.equal(f.calls[0].opts.maxAge, 7 * 24 * 60 * 60 * 1000)
})

test('clearRefreshCookie mirrors the path and HttpOnly attributes', () => {
  const { res, calls } = fakeRes()
  clearRefreshCookie(res)
  assert.equal(calls[0].name, REFRESH_COOKIE)
  assert.equal(calls[0].opts.httpOnly, true)
  assert.equal(calls[0].opts.path, '/api/auth')
})

// ── Cookie parsing ───────────────────────────────────────────────────────────

test('readCookie extracts a named value and URL-decodes it', () => {
  const req = { headers: { cookie: `a=1; ${REFRESH_COOKIE}=ab%20cd; b=2` } } as unknown as Request
  assert.equal(readCookie(req, REFRESH_COOKIE), 'ab cd')
  assert.equal(readCookie(req, 'a'), '1')
})

test('readCookie returns null when the cookie or header is absent', () => {
  assert.equal(readCookie({ headers: {} } as Request, 'x'), null)
  assert.equal(readCookie({ headers: { cookie: 'other=1' } } as unknown as Request, 'x'), null)
})

// ── CSRF guard ───────────────────────────────────────────────────────────────

test('requireCsrfHeader rejects requests without the custom header', () => {
  let statusCode = 0; let payload: any
  const res = { status(c: number) { statusCode = c; return res }, json(p: any) { payload = p } } as unknown as Response
  let nextCalled = false
  requireCsrfHeader({ headers: {} } as Request, res, () => { nextCalled = true })
  assert.equal(statusCode, 403)
  assert.match(payload.error, /CSRF/)
  assert.equal(nextCalled, false)
})

test('requireCsrfHeader passes when x-csrf-protection: 1 is present', () => {
  const res = { status() { return res }, json() {} } as unknown as Response
  let nextCalled = false
  requireCsrfHeader({ headers: { 'x-csrf-protection': '1' } } as unknown as Request, res, () => { nextCalled = true })
  assert.equal(nextCalled, true)
})
