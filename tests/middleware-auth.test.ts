import test from 'node:test'
import assert from 'node:assert/strict'
import { mock } from 'node:test'
import { requireAuth } from '../apps/api/src/middleware/auth.ts'
import { signJwt } from '../packages/backend-core/src/lib/jwt.ts'
import type { Request, Response, NextFunction } from 'express'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function noEnv<T>(fn: () => T): T {
  const saved = { NODE_ENV: process.env.NODE_ENV, JWT_SECRET: process.env.JWT_SECRET }
  delete process.env.NODE_ENV
  delete process.env.JWT_SECRET
  try { return fn() } finally { Object.assign(process.env, saved) }
}

function makeRes() {
  const json = mock.fn()
  const status = mock.fn((_code: number) => ({ json }))
  return { res: { status, json } as unknown as Response, status, json }
}

async function callAuth(req: Partial<Request>) {
  const { res, status, json } = makeRes()
  const next = mock.fn<NextFunction>()
  await requireAuth(req as Request, res, next)
  return {
    nextCalled: next.mock.callCount() > 0,
    nextArg: next.mock.calls[0]?.arguments[0],
    statusCode: status.mock.calls[0]?.arguments[0] as number | undefined,
    body: json.mock.calls[0]?.arguments[0] as Record<string, string> | undefined
  }
}

// ---------------------------------------------------------------------------
// Missing / malformed Authorization header
// ---------------------------------------------------------------------------
test('auth middleware: no Authorization header → 401 "Missing bearer token"', async () => {
  const result = await callAuth({ headers: {} })
  assert.equal(result.statusCode, 401)
  assert.equal(result.body?.error, 'Missing bearer token')
  assert.equal(result.nextCalled, false)
})

test('auth middleware: Authorization without Bearer prefix → 401', async () => {
  const result = await callAuth({ headers: { authorization: 'Basic dXNlcjpwYXNz' } })
  assert.equal(result.statusCode, 401)
  assert.equal(result.nextCalled, false)
})

test('auth middleware: Authorization header is only "Bearer " (empty token) → 401', async () => {
  const result = await callAuth({ headers: { authorization: 'Bearer ' } })
  assert.equal(result.statusCode, 401)
  assert.equal(result.nextCalled, false)
})

test('auth middleware: completely random token → 401 "Unauthorized"', async () => {
  const result = await callAuth({ headers: { authorization: 'Bearer notajwtatall' } })
  assert.equal(result.statusCode, 401)
  assert.equal(result.body?.error, 'Unauthorized')
  assert.equal(result.nextCalled, false)
})

test('auth middleware: three-part JWT signed with wrong secret → 401', async () => {
  const token = noEnv(() => signJwt({ userId: 'u_123' }))
  // Change the secret so verification fails
  const savedSecret = process.env.JWT_SECRET
  process.env.JWT_SECRET = 'a-completely-different-secret'
  delete process.env.NODE_ENV

  try {
    const result = await callAuth({ headers: { authorization: `Bearer ${token}` } })
    assert.equal(result.statusCode, 401)
    assert.equal(result.body?.error, 'Unauthorized')
  } finally {
    process.env.JWT_SECRET = savedSecret
  }
})

test('auth middleware: tampered payload → 401 "Unauthorized"', async () => {
  const token = noEnv(() => signJwt({ userId: 'legit' }))
  const [h, _p, s] = token.split('.')
  const tampered = `${h}.${Buffer.from(JSON.stringify({ userId: 'evil' })).toString('base64url')}.${s}`
  const result = await callAuth({ headers: { authorization: `Bearer ${tampered}` } })
  assert.equal(result.statusCode, 401)
})

test('auth middleware: SQL injection in auth header → 401', async () => {
  const result = await callAuth({
    headers: { authorization: "Bearer ' OR 1=1 --" }
  })
  assert.equal(result.statusCode, 401)
})

test('auth middleware: XSS payload in auth header → 401', async () => {
  const result = await callAuth({
    headers: { authorization: 'Bearer <script>alert(1)</script>' }
  })
  assert.equal(result.statusCode, 401)
})
