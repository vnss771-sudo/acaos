// Integration tests for the /api/auth router (P3 — auth lifecycle).
//
// Covers signup (user + workspace + membership transaction), login credential
// verification, and the security-critical refresh-token rotation: a used
// refresh token is revoked and a fresh one issued, and a revoked/expired token
// is rejected.

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import bcrypt from 'bcryptjs'
import { authRouter } from '../apps/api/src/routes/auth.ts'
import { hashRefreshToken } from '../packages/backend-core/src/lib/jwt.ts'
import {
  createFakePrisma,
  installPrisma,
  resetPrisma,
  startTestServer,
  type FakePrisma,
  type TestServer,
} from './helpers/integration.ts'

// A mutable in-memory store so signup/login/refresh interact realistically.
type RefreshRow = {
  id: string
  userId: string
  tokenHash: string
  expiresAt: Date
  revokedAt: Date | null
}

let users: any[]
let refreshTokens: RefreshRow[]
let prisma: FakePrisma
let server: TestServer

function spec() {
  return {
    user: {
      findUnique: async (args: any) =>
        users.find((u) => (args.where.email ? u.email === args.where.email : u.id === args.where.id)) ?? null,
      create: async (args: any) => {
        const u = { id: `user-${users.length + 1}`, ...args.data }
        users.push(u)
        return { id: u.id, email: u.email, name: u.name ?? null }
      },
      update: async (args: any) => {
        const u = users.find((x) => x.id === args.where.id)
        Object.assign(u, args.data)
        return { id: u.id, email: u.email, name: u.name ?? null }
      },
    },
    workspace: {
      findUnique: async () => null, // slug never collides
      create: async (args: any) => ({ id: 'ws-1', ...args.data }),
      findMany: async () => [],
    },
    membership: { create: async () => ({ id: 'm-1' }) },
    refreshToken: {
      create: async (args: any) => {
        const row: RefreshRow = { id: `rt-${refreshTokens.length + 1}`, revokedAt: null, ...args.data }
        refreshTokens.push(row)
        return row
      },
      findUnique: async (args: any) =>
        refreshTokens.find((r) => r.tokenHash === args.where.tokenHash) ?? null,
      update: async (args: any) => {
        const r = refreshTokens.find((x) => x.id === args.where.id)
        Object.assign(r!, args.data)
        return r
      },
      updateMany: async (args: any) => {
        let count = 0
        for (const r of refreshTokens) {
          const tokenMatch = r.tokenHash === args.where.tokenHash
          const notRevoked = args.where.revokedAt === null ? r.revokedAt === null : true
          const notExpired = args.where.expiresAt?.gt ? r.expiresAt > args.where.expiresAt.gt : true
          if (tokenMatch && notRevoked && notExpired) {
            Object.assign(r, args.data)
            count++
          }
        }
        return { count }
      },
    },
  }
}

beforeEach(async () => {
  users = []
  refreshTokens = []
  prisma = createFakePrisma(spec())
  installPrisma(prisma)
  server = await startTestServer('/api/auth', authRouter)
})

afterEach(async () => {
  await server.close()
  resetPrisma()
})

// Each request gets a unique source IP (via X-Forwarded-For + trust proxy) so
// the per-IP auth rate limiter never bleeds across independent test cases.
let ipSeq = 0
const nextIp = () => `9.0.${Math.floor(ipSeq / 256) % 256}.${ipSeq++ % 256}`

const post = (path: string, body: unknown) =>
  server.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': nextIp() },
    body: JSON.stringify(body),
  })

// Refresh/logout authenticate via the HttpOnly cookie and require the CSRF
// header. This helper sends both.
const postWithRefreshCookie = (path: string, rawRefresh: string, opts: { csrf?: boolean } = {}) =>
  server.request(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': nextIp(),
      Cookie: `acaos_refresh=${rawRefresh}`,
      ...(opts.csrf === false ? {} : { 'X-CSRF-Protection': '1' }),
    },
  })

// Extract the acaos_refresh cookie value from a Set-Cookie header, if present.
function refreshCookieFrom(headers: Headers): string | null {
  const raw = headers.get('set-cookie')
  if (!raw) return null
  const m = raw.match(/acaos_refresh=([^;]+)/)
  return m ? m[1] : null
}

// --- signup ---

test('signup creates user + workspace + owner membership; refresh token only in an HttpOnly cookie', async () => {
  const res = await post('/api/auth/signup', { email: 'New@Acme.test ', password: 'sup3rsecret' })
  assert.equal(res.status, 201)
  assert.ok(res.body.token)
  // The refresh token must NOT be exposed to JS via the body...
  assert.equal(res.body.refreshToken, undefined)
  // ...it is delivered as an HttpOnly cookie instead.
  const setCookie = res.headers.get('set-cookie') ?? ''
  assert.match(setCookie, /acaos_refresh=/)
  assert.match(setCookie, /HttpOnly/i)
  assert.equal(res.body.user.email, 'new@acme.test') // normalized
  assert.equal(prisma.callsTo('membership', 'create').length, 1)
  assert.equal(prisma.callsTo('refreshToken', 'create').length, 1)
})

test('signup rejects a weak password', async () => {
  const res = await post('/api/auth/signup', { email: 'a@acme.test', password: 'short' })
  assert.equal(res.status, 400)
  assert.equal(prisma.callsTo('user', 'create').length, 0)
})

test('signup rejects a duplicate email', async () => {
  users.push({ id: 'u-existing', email: 'dupe@acme.test', passwordHash: 'x' })
  const res = await post('/api/auth/signup', { email: 'dupe@acme.test', password: 'sup3rsecret' })
  assert.equal(res.status, 409)
})

// --- login ---

test('login succeeds with correct credentials and sets the refresh cookie (not the body)', async () => {
  const passwordHash = await bcrypt.hash('sup3rsecret', 10)
  users.push({ id: 'u-1', email: 'a@acme.test', name: 'A', passwordHash })
  const res = await post('/api/auth/login', { email: 'A@acme.test', password: 'sup3rsecret' })
  assert.equal(res.status, 200)
  assert.ok(res.body.token)
  assert.equal(res.body.refreshToken, undefined)
  assert.match(res.headers.get('set-cookie') ?? '', /acaos_refresh=.*HttpOnly/i)
})

test('login rejects a wrong password without leaking which field failed', async () => {
  const passwordHash = await bcrypt.hash('sup3rsecret', 10)
  users.push({ id: 'u-1', email: 'a@acme.test', passwordHash })
  const res = await post('/api/auth/login', { email: 'a@acme.test', password: 'wrong' })
  assert.equal(res.status, 401)
  assert.equal(res.body.error, 'Invalid credentials')
})

test('login rejects an unknown email with the same generic error', async () => {
  const res = await post('/api/auth/login', { email: 'ghost@acme.test', password: 'whatever1' })
  assert.equal(res.status, 401)
  assert.equal(res.body.error, 'Invalid credentials')
})

// --- refresh-token rotation ---

test('refresh rotates the token: old is revoked, a new one is issued in a fresh cookie', async () => {
  users.push({ id: 'u-1', email: 'a@acme.test', name: null })
  const raw = 'plain-refresh-token-value'
  refreshTokens.push({
    id: 'rt-1',
    userId: 'u-1',
    tokenHash: hashRefreshToken(raw),
    expiresAt: new Date(Date.now() + 60_000),
    revokedAt: null,
  })

  const res = await postWithRefreshCookie('/api/auth/refresh', raw)
  assert.equal(res.status, 200)
  assert.ok(res.body.token)
  // New refresh token comes back as a rotated cookie, never in the body.
  assert.equal(res.body.refreshToken, undefined)
  const rotated = refreshCookieFrom(res.headers)
  assert.ok(rotated && rotated !== raw, 'a new refresh cookie should be set')
  // Old token revoked, new token persisted.
  assert.ok(refreshTokens.find((r) => r.id === 'rt-1')!.revokedAt)
  assert.equal(refreshTokens.length, 2)
})

test('refresh without the CSRF header is rejected (403) before any token work', async () => {
  const raw = 'csrf-missing-token'
  refreshTokens.push({
    id: 'rt-1', userId: 'u-1', tokenHash: hashRefreshToken(raw),
    expiresAt: new Date(Date.now() + 60_000), revokedAt: null,
  })
  const res = await postWithRefreshCookie('/api/auth/refresh', raw, { csrf: false })
  assert.equal(res.status, 403)
  // Token must not have been touched.
  assert.equal(refreshTokens[0].revokedAt, null)
})

test('refresh with no cookie returns 401', async () => {
  const res = await server.request('/api/auth/refresh', {
    method: 'POST',
    headers: { 'X-CSRF-Protection': '1', 'X-Forwarded-For': nextIp() },
  })
  assert.equal(res.status, 401)
})

test('refresh rejects an already-revoked token', async () => {
  const raw = 'revoked-token'
  refreshTokens.push({
    id: 'rt-1',
    userId: 'u-1',
    tokenHash: hashRefreshToken(raw),
    expiresAt: new Date(Date.now() + 60_000),
    revokedAt: new Date(),
  })
  const res = await postWithRefreshCookie('/api/auth/refresh', raw)
  assert.equal(res.status, 401)
})

test('refresh rejects an expired token', async () => {
  const raw = 'expired-token'
  refreshTokens.push({
    id: 'rt-1',
    userId: 'u-1',
    tokenHash: hashRefreshToken(raw),
    expiresAt: new Date(Date.now() - 60_000),
    revokedAt: null,
  })
  const res = await postWithRefreshCookie('/api/auth/refresh', raw)
  assert.equal(res.status, 401)
})

test('logout revokes the cookie token and clears the cookie', async () => {
  const raw = 'logout-token'
  refreshTokens.push({
    id: 'rt-1',
    userId: 'u-1',
    tokenHash: hashRefreshToken(raw),
    expiresAt: new Date(Date.now() + 60_000),
    revokedAt: null,
  })
  const res = await postWithRefreshCookie('/api/auth/logout', raw)
  assert.equal(res.status, 200)
  assert.ok(refreshTokens[0].revokedAt)
  // The cookie is cleared (expired) on logout.
  assert.match(res.headers.get('set-cookie') ?? '', /acaos_refresh=/)
})

test('logout without the CSRF header is rejected (403)', async () => {
  const raw = 'logout-csrf-token'
  refreshTokens.push({
    id: 'rt-1', userId: 'u-1', tokenHash: hashRefreshToken(raw),
    expiresAt: new Date(Date.now() + 60_000), revokedAt: null,
  })
  const res = await postWithRefreshCookie('/api/auth/logout', raw, { csrf: false })
  assert.equal(res.status, 403)
  assert.equal(refreshTokens[0].revokedAt, null)
})
