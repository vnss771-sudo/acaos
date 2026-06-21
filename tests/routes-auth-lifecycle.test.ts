// Integration tests for the remaining /api/auth lifecycle endpoints that the
// core routes-auth suite does not exercise: password reset, profile updates,
// email verification, and workspace-invite acceptance. These hit the real
// route handlers through the fake-Prisma harness (no SMTP — isMailConfigured()
// is false in tests, so mail-sending falls through to the console branch).

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
  bearer,
  type FakePrisma,
  type TestServer,
} from './helpers/integration.ts'

type TokenRow = { id: string; userId: string; tokenHash: string; expiresAt: Date; usedAt: Date | null }
type InviteRow = {
  id: string; email: string; role: string; workspaceId: string
  tokenHash: string; expiresAt: Date; acceptedAt: Date | null
}

let users: any[]
let resetTokens: TokenRow[]
let verifyTokens: TokenRow[]
let invites: InviteRow[]
let memberships: any[]
let refreshTokens: any[]
let prisma: FakePrisma
let server: TestServer

// Shared updateMany over a single-use token store: revoke (set usedAt) only the
// matching, unused, unexpired row — mirroring the route's atomic conditional.
function consumeToken(store: TokenRow[], where: any, data: any) {
  let count = 0
  for (const t of store) {
    const tokenMatch = t.tokenHash === where.tokenHash
    const unused = where.usedAt === null ? t.usedAt === null : true
    const unexpired = where.expiresAt?.gt ? t.expiresAt > where.expiresAt.gt : true
    if (tokenMatch && unused && unexpired) { Object.assign(t, data); count++ }
  }
  return { count }
}

function spec() {
  return {
    user: {
      findUnique: async (args: any) =>
        users.find((u) => (args.where.email ? u.email === args.where.email : u.id === args.where.id)) ?? null,
      update: async (args: any) => {
        const u = users.find((x) => x.id === args.where.id)
        Object.assign(u, args.data)
        return { id: u.id, email: u.email, name: u.name ?? null }
      },
    },
    passwordResetToken: {
      create: async (args: any) => {
        const row = { id: `prt-${resetTokens.length + 1}`, usedAt: null, ...args.data }
        resetTokens.push(row); return row
      },
      updateMany: async (args: any) => consumeToken(resetTokens, args.where, args.data),
      findUnique: async (args: any) => resetTokens.find((t) => t.tokenHash === args.where.tokenHash) ?? null,
    },
    emailVerificationToken: {
      create: async (args: any) => {
        const row = { id: `evt-${verifyTokens.length + 1}`, usedAt: null, ...args.data }
        verifyTokens.push(row); return row
      },
      updateMany: async (args: any) => consumeToken(verifyTokens, args.where, args.data),
      findUnique: async (args: any) => verifyTokens.find((t) => t.tokenHash === args.where.tokenHash) ?? null,
    },
    workspaceInvite: {
      findUnique: async (args: any) => {
        const inv = invites.find((i) => i.tokenHash === args.where.tokenHash)
        if (!inv) return null
        // Support the include of workspace used by POST /invite/lookup
        return args.include?.workspace
          ? { ...inv, workspace: { id: inv.workspaceId, name: 'Acme Inc' } }
          : inv
      },
      update: async (args: any) => {
        const inv = invites.find((i) => i.id === args.where.id)
        Object.assign(inv!, args.data); return inv
      },
    },
    membership: {
      findFirst: async (args: any) =>
        memberships.find((m) => m.userId === args.where.userId && m.workspaceId === args.where.workspaceId) ?? null,
      create: async (args: any) => {
        const m = { id: `m-${memberships.length + 1}`, ...args.data }
        memberships.push(m); return m
      },
    },
    workspace: {
      findMany: async () => [
        { id: 'ws-1', name: 'Acme Inc', slug: 'acme', plan: 'free', subscriptionStatus: null, createdAt: new Date(), onboardingCompleted: false, _count: { leads: 2, campaigns: 1 } },
      ],
    },
    refreshToken: {
      updateMany: async (args: any) => {
        let count = 0
        for (const r of refreshTokens) {
          if (r.userId === args.where.userId && (args.where.revokedAt === null ? r.revokedAt === null : true)) {
            Object.assign(r, args.data); count++
          }
        }
        return { count }
      },
    },
  }
}

beforeEach(async () => {
  users = []
  resetTokens = []
  verifyTokens = []
  invites = []
  memberships = []
  refreshTokens = []
  prisma = createFakePrisma(spec())
  installPrisma(prisma)
  server = await startTestServer('/api/auth', authRouter)
})

afterEach(async () => {
  await server.close()
  resetPrisma()
})

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  server.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })

// ── me ────────────────────────────────────────────────────────────────────────

test('me returns the current user and their workspaces', async () => {
  users.push({ id: 'u-1', email: 'a@acme.test', name: 'A', emailVerified: true })
  const res = await server.request('/api/auth/me', { headers: { Authorization: bearer('u-1') } })
  assert.equal(res.status, 200)
  assert.equal(res.body.user.email, 'a@acme.test')
  assert.equal(res.body.workspaces.length, 1)
  assert.equal(res.body.workspaces[0].slug, 'acme')
})

test('me requires authentication', async () => {
  const res = await server.request('/api/auth/me')
  assert.equal(res.status, 401)
})

// ── forgot-password ───────────────────────────────────────────────────────────

test('forgot-password returns ok and issues a reset token for a known account', async () => {
  users.push({ id: 'u-1', email: 'a@acme.test', passwordHash: 'x' })
  const res = await post('/api/auth/forgot-password', { email: 'A@acme.test' })
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.equal(resetTokens.length, 1)
})

test('forgot-password does not reveal that an email is unknown (no token created)', async () => {
  const res = await post('/api/auth/forgot-password', { email: 'ghost@acme.test' })
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.equal(resetTokens.length, 0)
})

// ── reset-password ──────────────────────────────────────────────────────────

test('reset-password sets a new password and revokes active sessions', async () => {
  users.push({ id: 'u-1', email: 'a@acme.test', passwordHash: 'old' })
  refreshTokens.push({ id: 'rt-1', userId: 'u-1', revokedAt: null })
  const raw = 'reset-token-value'
  resetTokens.push({ id: 'prt-1', userId: 'u-1', tokenHash: hashRefreshToken(raw), expiresAt: new Date(Date.now() + 60_000), usedAt: null })

  const res = await post('/api/auth/reset-password', { token: raw, password: 'brandnew1pass' })
  assert.equal(res.status, 200)
  assert.equal(resetTokens[0].usedAt instanceof Date, true)
  assert.ok(await bcrypt.compare('brandnew1pass', users[0].passwordHash))
  assert.ok(refreshTokens[0].revokedAt) // sessions invalidated
})

test('reset-password rejects an invalid or expired token', async () => {
  const res = await post('/api/auth/reset-password', { token: 'nope', password: 'brandnew1pass' })
  assert.equal(res.status, 400)
})

test('reset-password rejects a weak new password before touching the token', async () => {
  const res = await post('/api/auth/reset-password', { token: 'whatever', password: 'short' })
  assert.equal(res.status, 400)
  assert.equal(prisma.callsTo('passwordResetToken', 'updateMany').length, 0)
})

// ── profile ─────────────────────────────────────────────────────────────────

test('profile updates the display name', async () => {
  users.push({ id: 'u-1', email: 'a@acme.test', name: 'Old', passwordHash: 'x' })
  const res = await server.request('/api/auth/profile', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: bearer('u-1') },
    body: JSON.stringify({ name: 'New Name' }),
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.user.name, 'New Name')
})

test('profile rejects an over-long display name (>100 chars)', async () => {
  users.push({ id: 'u-1', email: 'a@acme.test', name: 'Old', passwordHash: 'x' })
  const res = await server.request('/api/auth/profile', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: bearer('u-1') },
    body: JSON.stringify({ name: 'x'.repeat(101) }),
  })
  assert.equal(res.status, 400)
})

test('profile changes the password when the current one is correct and revokes sessions', async () => {
  const passwordHash = await bcrypt.hash('currentpass1', 10)
  users.push({ id: 'u-1', email: 'a@acme.test', name: 'A', passwordHash })
  // An active session elsewhere must be invalidated on a credential change.
  refreshTokens.push({ id: 'rt-1', userId: 'u-1', revokedAt: null })
  const res = await server.request('/api/auth/profile', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: bearer('u-1') },
    body: JSON.stringify({ currentPassword: 'currentpass1', newPassword: 'replacement2' }),
  })
  assert.equal(res.status, 200)
  assert.ok(await bcrypt.compare('replacement2', users[0].passwordHash))
  assert.ok(refreshTokens[0].revokedAt) // sessions invalidated on password change
})

test('profile rejects a password change with the wrong current password', async () => {
  const passwordHash = await bcrypt.hash('currentpass1', 10)
  users.push({ id: 'u-1', email: 'a@acme.test', passwordHash })
  const res = await server.request('/api/auth/profile', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: bearer('u-1') },
    body: JSON.stringify({ currentPassword: 'wrong', newPassword: 'replacement2' }),
  })
  assert.equal(res.status, 401)
})

test('profile rejects an empty update', async () => {
  users.push({ id: 'u-1', email: 'a@acme.test', passwordHash: 'x' })
  const res = await server.request('/api/auth/profile', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: bearer('u-1') },
    body: JSON.stringify({}),
  })
  assert.equal(res.status, 400)
})

// ── email verification ────────────────────────────────────────────────────────

test('verify-email marks the user verified for a valid token', async () => {
  users.push({ id: 'u-1', email: 'a@acme.test', emailVerified: false })
  const raw = 'verify-token-value'
  verifyTokens.push({ id: 'evt-1', userId: 'u-1', tokenHash: hashRefreshToken(raw), expiresAt: new Date(Date.now() + 60_000), usedAt: null })

  const res = await post('/api/auth/verify-email', { token: raw })
  assert.equal(res.status, 200)
  assert.equal(users[0].emailVerified, true)
})

test('verify-email rejects an invalid token', async () => {
  const res = await post('/api/auth/verify-email', { token: 'bogus' })
  assert.equal(res.status, 400)
})

test('resend-verification is a no-op for an already-verified user', async () => {
  users.push({ id: 'u-1', email: 'a@acme.test', emailVerified: true })
  const res = await post('/api/auth/resend-verification', {}, { Authorization: bearer('u-1') })
  assert.equal(res.status, 200)
  assert.equal(verifyTokens.length, 0)
})

test('resend-verification issues a fresh token for an unverified user', async () => {
  users.push({ id: 'u-1', email: 'a@acme.test', emailVerified: false })
  const res = await post('/api/auth/resend-verification', {}, { Authorization: bearer('u-1') })
  assert.equal(res.status, 200)
  assert.equal(verifyTokens.length, 1)
})

// ── workspace invites ──────────────────────────────────────────────────────────

test('POST invite/lookup returns the invite details for a valid token', async () => {
  const raw = 'invite-token-value'
  invites.push({ id: 'inv-1', email: 'invitee@acme.test', role: 'member', workspaceId: 'ws-1', tokenHash: hashRefreshToken(raw), expiresAt: new Date(Date.now() + 60_000), acceptedAt: null })
  const res = await post('/api/auth/invite/lookup', { token: raw })
  assert.equal(res.status, 200)
  assert.equal(res.body.invite.email, 'invitee@acme.test')
  assert.equal(res.body.invite.workspaceName, 'Acme Inc')
})

test('POST invite/lookup rejects an expired invite', async () => {
  const raw = 'expired-invite'
  invites.push({ id: 'inv-1', email: 'x@acme.test', role: 'member', workspaceId: 'ws-1', tokenHash: hashRefreshToken(raw), expiresAt: new Date(Date.now() - 60_000), acceptedAt: null })
  const res = await post('/api/auth/invite/lookup', { token: raw })
  assert.equal(res.status, 400)
})

test('POST invite/lookup rejects a missing token (400, no path param)', async () => {
  const res = await post('/api/auth/invite/lookup', {})
  assert.equal(res.status, 400)
})

test('accepting an invite creates a membership and marks it accepted', async () => {
  // Invite acceptance now requires a verified email (proof of mailbox control).
  users.push({ id: 'u-1', email: 'invitee@acme.test', emailVerified: true })
  const raw = 'accept-token-value'
  invites.push({ id: 'inv-1', email: 'invitee@acme.test', role: 'member', workspaceId: 'ws-1', tokenHash: hashRefreshToken(raw), expiresAt: new Date(Date.now() + 60_000), acceptedAt: null })
  const res = await post('/api/auth/invite/accept', { token: raw }, { Authorization: bearer('u-1') })
  assert.equal(res.status, 200)
  assert.equal(res.body.workspaceId, 'ws-1')
  assert.equal(memberships.length, 1)
  assert.ok(invites[0].acceptedAt)
})

test('accepting an invite rejects a signed-in user with a different email', async () => {
  // Verified so we exercise the email-mismatch 403, not the verified-email gate.
  users.push({ id: 'u-1', email: 'someone-else@acme.test', emailVerified: true })
  const raw = 'mismatch-token'
  invites.push({ id: 'inv-1', email: 'invitee@acme.test', role: 'member', workspaceId: 'ws-1', tokenHash: hashRefreshToken(raw), expiresAt: new Date(Date.now() + 60_000), acceptedAt: null })
  const res = await post('/api/auth/invite/accept', { token: raw }, { Authorization: bearer('u-1') })
  assert.equal(res.status, 403)
  assert.equal(memberships.length, 0)
})

test('accepting an invite does not duplicate an existing membership', async () => {
  users.push({ id: 'u-1', email: 'invitee@acme.test', emailVerified: true })
  memberships.push({ id: 'm-existing', userId: 'u-1', workspaceId: 'ws-1', role: 'member' })
  const raw = 'already-member-token'
  invites.push({ id: 'inv-1', email: 'invitee@acme.test', role: 'member', workspaceId: 'ws-1', tokenHash: hashRefreshToken(raw), expiresAt: new Date(Date.now() + 60_000), acceptedAt: null })
  const res = await post('/api/auth/invite/accept', { token: raw }, { Authorization: bearer('u-1') })
  assert.equal(res.status, 200)
  assert.equal(memberships.length, 1) // no duplicate created
  assert.ok(invites[0].acceptedAt)
})

test('accepting an invite is blocked for an unverified email (403)', async () => {
  users.push({ id: 'u-1', email: 'invitee@acme.test', emailVerified: false })
  const raw = 'unverified-accept-token'
  invites.push({ id: 'inv-1', email: 'invitee@acme.test', role: 'member', workspaceId: 'ws-1', tokenHash: hashRefreshToken(raw), expiresAt: new Date(Date.now() + 60_000), acceptedAt: null })
  const res = await post('/api/auth/invite/accept', { token: raw }, { Authorization: bearer('u-1') })
  assert.equal(res.status, 403)
  assert.equal(memberships.length, 0) // workspace not granted
  assert.equal(invites[0].acceptedAt, null)
})
