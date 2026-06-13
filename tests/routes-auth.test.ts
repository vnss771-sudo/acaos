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
import { hashRefreshToken } from '../apps/api/src/lib/jwt.ts'
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
          if (r.tokenHash === args.where.tokenHash && r.revokedAt === null) {
            r.revokedAt = new Date()
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

const post = (path: string, body: unknown) =>
  server.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

// --- signup ---

test('signup creates user + workspace + owner membership and returns tokens', async () => {
  const res = await post('/api/auth/signup', { email: 'New@Acme.test ', password: 'sup3rsecret' })
  assert.equal(res.status, 201)
  assert.ok(res.body.token)
  assert.ok(res.body.refreshToken)
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

test('login succeeds with correct credentials', async () => {
  const passwordHash = await bcrypt.hash('sup3rsecret', 10)
  users.push({ id: 'u-1', email: 'a@acme.test', name: 'A', passwordHash })
  const res = await post('/api/auth/login', { email: 'A@acme.test', password: 'sup3rsecret' })
  assert.equal(res.status, 200)
  assert.ok(res.body.token)
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

test('refresh rotates the token: old is revoked, a new one is issued', async () => {
  users.push({ id: 'u-1', email: 'a@acme.test', name: null })
  const raw = 'plain-refresh-token-value'
  refreshTokens.push({
    id: 'rt-1',
    userId: 'u-1',
    tokenHash: hashRefreshToken(raw),
    expiresAt: new Date(Date.now() + 60_000),
    revokedAt: null,
  })

  const res = await post('/api/auth/refresh', { refreshToken: raw })
  assert.equal(res.status, 200)
  assert.ok(res.body.token)
  assert.notEqual(res.body.refreshToken, raw)
  // Old token revoked, new token persisted.
  assert.ok(refreshTokens.find((r) => r.id === 'rt-1')!.revokedAt)
  assert.equal(refreshTokens.length, 2)
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
  const res = await post('/api/auth/refresh', { refreshToken: raw })
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
  const res = await post('/api/auth/refresh', { refreshToken: raw })
  assert.equal(res.status, 401)
})

test('logout revokes the supplied refresh token', async () => {
  const raw = 'logout-token'
  refreshTokens.push({
    id: 'rt-1',
    userId: 'u-1',
    tokenHash: hashRefreshToken(raw),
    expiresAt: new Date(Date.now() + 60_000),
    revokedAt: null,
  })
  const res = await post('/api/auth/logout', { refreshToken: raw })
  assert.equal(res.status, 200)
  assert.ok(refreshTokens[0].revokedAt)
})
