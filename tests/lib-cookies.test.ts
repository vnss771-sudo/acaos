import test from 'node:test'
import assert from 'node:assert/strict'
import { mock } from 'node:test'
import type { Request, Response, NextFunction } from 'express'
import {
  REFRESH_COOKIE,
  setRefreshCookie,
  clearRefreshCookie,
  readCookie,
  requireCsrfHeader,
} from '../apps/api/src/lib/cookies.ts'

// Unit tests for the refresh-cookie helpers and the CSRF header guard. These are
// security primitives (HttpOnly session cookie + layered CSRF defense), so we pin
// the cookie attributes (HttpOnly/Secure/SameSite/path/maxAge), the env-driven
// overrides, the header cookie parser, and the 403-on-missing-header behavior.

// Run fn with a patched env, always restoring the prior values.
function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
  const keys = Object.keys(env)
  const saved: Record<string, string | undefined> = {}
  for (const k of keys) { saved[k] = process.env[k] }
  for (const k of keys) {
    if (env[k] === undefined) delete process.env[k]
    else process.env[k] = env[k]
  }
  try { fn() } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  }
}

function makeRes() {
  const cookie = mock.fn()
  const clearCookie = mock.fn()
  const json = mock.fn()
  const status = mock.fn((_code: number) => ({ json }))
  return { res: { cookie, clearCookie, status, json } as unknown as Response, cookie, clearCookie, status, json }
}

// ---------------------------------------------------------------------------
// setRefreshCookie
// ---------------------------------------------------------------------------
test('setRefreshCookie: HttpOnly, scoped to /api/auth, lax+insecure by default (non-prod)', () => {
  withEnv({ NODE_ENV: 'test', COOKIE_SAMESITE: undefined, COOKIE_SECURE: undefined, REFRESH_TOKEN_DAYS: undefined }, () => {
    const { res, cookie } = makeRes()
    setRefreshCookie(res, 'tok-abc')
    const [name, value, opts] = cookie.mock.calls[0].arguments as [string, string, any]
    assert.equal(name, REFRESH_COOKIE)
    assert.equal(value, 'tok-abc')
    assert.equal(opts.httpOnly, true)
    assert.equal(opts.path, '/api/auth')
    assert.equal(opts.sameSite, 'lax')
    assert.equal(opts.secure, false)
    assert.equal(opts.maxAge, 30 * 24 * 60 * 60 * 1000, 'defaults to 30 days')
  })
})

test('setRefreshCookie: REFRESH_TOKEN_DAYS drives maxAge', () => {
  withEnv({ REFRESH_TOKEN_DAYS: '7' }, () => {
    const { res, cookie } = makeRes()
    setRefreshCookie(res, 'tok')
    const opts = cookie.mock.calls[0].arguments[2] as any
    assert.equal(opts.maxAge, 7 * 24 * 60 * 60 * 1000)
  })
})

test('setRefreshCookie: Secure in production', () => {
  withEnv({ NODE_ENV: 'production', COOKIE_SECURE: undefined, COOKIE_SAMESITE: undefined }, () => {
    const { res, cookie } = makeRes()
    setRefreshCookie(res, 'tok')
    assert.equal((cookie.mock.calls[0].arguments[2] as any).secure, true)
  })
})

test('setRefreshCookie: SameSite=None forces Secure even outside production', () => {
  withEnv({ NODE_ENV: 'test', COOKIE_SAMESITE: 'none', COOKIE_SECURE: undefined }, () => {
    const { res, cookie } = makeRes()
    setRefreshCookie(res, 'tok')
    const opts = cookie.mock.calls[0].arguments[2] as any
    assert.equal(opts.sameSite, 'none')
    assert.equal(opts.secure, true, 'browsers reject SameSite=None without Secure')
  })
})

test('setRefreshCookie: COOKIE_SECURE override wins over NODE_ENV', () => {
  withEnv({ NODE_ENV: 'production', COOKIE_SECURE: 'false' }, () => {
    const { res, cookie } = makeRes()
    setRefreshCookie(res, 'tok')
    assert.equal((cookie.mock.calls[0].arguments[2] as any).secure, false)
  })
})

test('setRefreshCookie: invalid SameSite falls back to lax', () => {
  withEnv({ COOKIE_SAMESITE: 'bogus' }, () => {
    const { res, cookie } = makeRes()
    setRefreshCookie(res, 'tok')
    assert.equal((cookie.mock.calls[0].arguments[2] as any).sameSite, 'lax')
  })
})

// ---------------------------------------------------------------------------
// clearRefreshCookie
// ---------------------------------------------------------------------------
test('clearRefreshCookie: clears with the same name/path/attributes (so the browser drops it)', () => {
  withEnv({ NODE_ENV: 'test', COOKIE_SAMESITE: undefined, COOKIE_SECURE: undefined }, () => {
    const { res, clearCookie } = makeRes()
    clearRefreshCookie(res)
    const [name, opts] = clearCookie.mock.calls[0].arguments as [string, any]
    assert.equal(name, REFRESH_COOKIE)
    assert.equal(opts.httpOnly, true)
    assert.equal(opts.path, '/api/auth')
    assert.equal(opts.sameSite, 'lax')
  })
})

// ---------------------------------------------------------------------------
// readCookie
// ---------------------------------------------------------------------------
test('readCookie: returns null when there is no Cookie header', () => {
  assert.equal(readCookie({ headers: {} } as Request, REFRESH_COOKIE), null)
})

test('readCookie: extracts the named cookie among several', () => {
  const req = { headers: { cookie: 'a=1; acaos_refresh=tok-xyz; b=2' } } as unknown as Request
  assert.equal(readCookie(req, REFRESH_COOKIE), 'tok-xyz')
  assert.equal(readCookie(req, 'a'), '1')
  assert.equal(readCookie(req, 'b'), '2')
})

test('readCookie: URL-decodes the value and returns null for an absent name', () => {
  const req = { headers: { cookie: 'tok=a%20b%3Dc' } } as unknown as Request
  assert.equal(readCookie(req, 'tok'), 'a b=c')
  assert.equal(readCookie(req, 'missing'), null)
})

// ---------------------------------------------------------------------------
// requireCsrfHeader
// ---------------------------------------------------------------------------
function callCsrf(headers: Record<string, unknown>) {
  const { res, status, json } = makeRes()
  const next = mock.fn<NextFunction>()
  requireCsrfHeader({ headers } as unknown as Request, res, next)
  return {
    nextCalled: next.mock.callCount() > 0,
    statusCode: status.mock.calls[0]?.arguments[0] as number | undefined,
    body: json.mock.calls[0]?.arguments[0] as { error?: string } | undefined,
  }
}

test('requireCsrfHeader: passes through when x-csrf-protection is "1"', () => {
  const r = callCsrf({ 'x-csrf-protection': '1' })
  assert.equal(r.nextCalled, true)
  assert.equal(r.statusCode, undefined)
})

test('requireCsrfHeader: 403 when the header is missing', () => {
  const r = callCsrf({})
  assert.equal(r.nextCalled, false)
  assert.equal(r.statusCode, 403)
  assert.match(r.body?.error ?? '', /CSRF/)
})

test('requireCsrfHeader: 403 when the header has the wrong value', () => {
  const r = callCsrf({ 'x-csrf-protection': 'yes' })
  assert.equal(r.nextCalled, false)
  assert.equal(r.statusCode, 403)
})
