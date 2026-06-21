// Fast (no-DB) tests for the MFA / second-factor auth routes. These cover the
// branches that do NOT require a real DB transaction:
//   - login returns an MFA challenge (no access token) when totpEnabled
//   - /verify-totp rejects an invalid mfaToken
//   - /verify-totp rejects a valid mfaToken when MFA is not enabled
//   - zod validation on /verify-totp and /mfa/activate
//
// The full enroll happy-path (setup → activate with the real $transaction and
// encrypted-secret round-trip) is covered by tests-db/auth-mfa.test.ts and is
// intentionally NOT duplicated here.

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import bcrypt from 'bcryptjs'
import { authRouter } from '../apps/api/src/routes/auth.ts'
import { signMfaToken } from '../packages/backend-core/src/lib/jwt.ts'
import {
  createFakePrisma,
  installPrisma,
  resetPrisma,
  startTestServer,
  bearer,
  type FakePrisma,
  type TestServer,
} from './helpers/integration.ts'

// Mutable in-memory user store, keyed by id and email, so handlers that call
// user.findUnique({where:{email}}) (login) or {where:{id}} (requireAuth) both
// resolve. Only the fields each handler reads are modelled.
let users: any[]
let prisma: FakePrisma
let server: TestServer

function spec() {
  return {
    user: {
      findUnique: async (args: any) => {
        const w = args?.where ?? {}
        return (
          users.find((u) => (w.email ? u.email === w.email : u.id === w.id)) ?? null
        )
      },
      update: async (args: any) => {
        const u = users.find((x) => x.id === args.where.id)
        if (u) Object.assign(u, args.data)
        return u ? { id: u.id, email: u.email, name: u.name ?? null } : null
      },
    },
    // login's non-MFA path persists a refresh token; harmless for MFA cases but
    // present so the spec is complete.
    refreshToken: { create: async (args: any) => ({ id: 'rt-1', ...args.data }) },
  }
}

beforeEach(async () => {
  users = []
  prisma = createFakePrisma(spec())
  installPrisma(prisma)
  server = await startTestServer('/api/auth', authRouter)
})

afterEach(async () => {
  await server.close()
  resetPrisma()
})

// Unique source IP per request so the per-IP auth rate limiter never bleeds
// across independent cases.
let ipSeq = 0
const nextIp = () => `7.0.${Math.floor(ipSeq / 256) % 256}.${ipSeq++ % 256}`

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  server.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': nextIp(), ...headers },
    body: JSON.stringify(body),
  })

const PASS = 'Sup3rSecret!'

// ── login: MFA challenge ──────────────────────────────────────────────────────

test('login with totpEnabled returns {mfaRequired, mfaToken} and NO access token', async () => {
  const passwordHash = await bcrypt.hash(PASS, 10)
  users.push({ id: 'u-1', email: 'mfa@x.test', name: 'M', passwordHash, totpEnabled: true })

  const res = await post('/api/auth/login', { email: 'mfa@x.test', password: PASS })
  assert.equal(res.status, 200)
  assert.equal(res.body.mfaRequired, true)
  assert.ok(res.body.mfaToken, 'returns a scoped MFA token')
  assert.equal(res.body.token, undefined, 'no access token before the second factor')
  // The MFA challenge short-circuits before any refresh token is persisted.
  assert.equal(prisma.callsTo('refreshToken', 'create').length, 0)
})

test('login without MFA still issues an access token (control)', async () => {
  const passwordHash = await bcrypt.hash(PASS, 10)
  users.push({ id: 'u-2', email: 'plain@x.test', name: 'P', passwordHash, totpEnabled: false })

  const res = await post('/api/auth/login', { email: 'plain@x.test', password: PASS })
  assert.equal(res.status, 200)
  assert.ok(res.body.token)
  assert.equal(res.body.mfaRequired, undefined)
})

// ── /verify-totp ──────────────────────────────────────────────────────────────

test('verify-totp with an invalid mfaToken → 401', async () => {
  const res = await post('/api/auth/verify-totp', { mfaToken: 'not-a-real-token', code: '123456' })
  assert.equal(res.status, 401)
  // No user lookup should have happened — the token failed first.
  assert.equal(prisma.callsTo('user', 'findUnique').length, 0)
})

test('verify-totp with a valid mfaToken but MFA disabled → 401 (MFA not enabled)', async () => {
  users.push({ id: 'u-3', email: 'off@x.test', name: 'O', totpEnabled: false, totpSecret: null })
  const mfaToken = signMfaToken('u-3')

  const res = await post('/api/auth/verify-totp', { mfaToken, code: '123456' })
  assert.equal(res.status, 401)
  assert.match(res.body.error, /not enabled/i)
})

test('verify-totp rejects a missing code (zod 400)', async () => {
  const mfaToken = signMfaToken('u-3')
  const res = await post('/api/auth/verify-totp', { mfaToken })
  assert.equal(res.status, 400)
})

test('verify-totp rejects a too-short code (zod 400)', async () => {
  const mfaToken = signMfaToken('u-3')
  const res = await post('/api/auth/verify-totp', { mfaToken, code: '123' })
  assert.equal(res.status, 400)
})

test('verify-totp rejects a missing mfaToken (zod 400)', async () => {
  const res = await post('/api/auth/verify-totp', { code: '123456' })
  assert.equal(res.status, 400)
})

// ── /mfa/activate validation (behind requireAuth) ─────────────────────────────
// requireAuth looks up the user by id; provide a matching row so we reach the
// zod validation and exercise the 400 paths.

// /mfa/activate now requires fresh auth (step-up) ahead of zod validation, so
// these users carry a recent lastReauthAt to reach the validation paths.
test('mfa/activate rejects a missing code (zod 400)', async () => {
  users.push({ id: 'u-4', email: 'act@x.test', name: 'A', emailVerified: true, lastReauthAt: new Date() })
  const res = await post('/api/auth/mfa/activate', {}, { Authorization: bearer('u-4') })
  assert.equal(res.status, 400)
})

test('mfa/activate rejects a too-short code (zod 400)', async () => {
  users.push({ id: 'u-5', email: 'act2@x.test', name: 'A', emailVerified: true, lastReauthAt: new Date() })
  const res = await post('/api/auth/mfa/activate', { code: '12' }, { Authorization: bearer('u-5') })
  assert.equal(res.status, 400)
})

test('mfa/activate without a Bearer token → 401', async () => {
  const res = await post('/api/auth/mfa/activate', { code: '123456' })
  assert.equal(res.status, 401)
})
