/**
 * Integration tests for workspace team-management and API-key endpoints:
 *
 *   POST   /api/workspaces/:id/members         — add member by email
 *   DELETE /api/workspaces/:id/members/:userId — remove member
 *   POST   /api/workspaces/:id/api-key/rotate  — generate new ingest key
 *   DELETE /api/workspaces/:id/api-key         — revoke ingest key
 *
 * The existing routes-workspaces.test.ts covers basic CRUD (GET, POST, PATCH).
 * This file focuses on the access-control matrix, input validation, and the
 * show-once API key contract.
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { workspaceRouter } from '../apps/api/src/routes/workspaces.ts'
import {
  createFakePrisma, installPrisma, resetPrisma, startTestServer, bearer,
  type TestServer,
} from './helpers/integration.ts'

const OWNER_ID  = 'user-owner'
const ADMIN_ID  = 'user-admin'
const MEMBER_ID = 'user-member'
const OTHER_ID  = 'user-other'
const WS_ID     = 'ws-1'

// ── Shared data ───────────────────────────────────────────────────────────────

type UserRecord = { id: string; email: string; name: null; emailVerified: boolean }

const USERS: Record<string, UserRecord> = {
  [OWNER_ID]:  { id: OWNER_ID,  email: 'owner@test.com',  name: null, emailVerified: true },
  [ADMIN_ID]:  { id: ADMIN_ID,  email: 'admin@test.com',  name: null, emailVerified: true },
  [MEMBER_ID]: { id: MEMBER_ID, email: 'member@test.com', name: null, emailVerified: true },
  [OTHER_ID]:  { id: OTHER_ID,  email: 'other@test.com',  name: null, emailVerified: true },
}

const EMAILS: Record<string, UserRecord> = Object.fromEntries(
  Object.values(USERS).map(u => [u.email, u])
)

/** Membership lookup that correctly handles both auth checks and role-gated checks. */
function membershipFor(
  a: any,
  extraMembers: Record<string, string> = {}
) {
  const { userId, workspaceId, role } = a?.where ?? {}
  if (workspaceId !== WS_ID) return null

  const allRoles: Record<string, string> = {
    [OWNER_ID]:  'owner',
    [ADMIN_ID]:  'admin',
    [MEMBER_ID]: 'member',
    ...extraMembers,
  }
  const callerRole = allRoles[userId]
  if (!callerRole) return null
  if (role?.in && !role.in.includes(callerRole)) return null
  if (typeof role === 'string' && role !== callerRole) return null
  return { id: `m-${userId}`, role: callerRole }
}

/** Standard user.findUnique: handles auth (by id) and invite (by email) lookups. */
function userLookup(a: any): UserRecord | null {
  if (a?.where?.id)    return USERS[a.where.id] ?? null
  if (a?.where?.email) return EMAILS[a.where.email] ?? null
  return null
}

function buildSpec(overrides: Record<string, any> = {}) {
  return {
    membership: {
      findFirst: async (a: any) => membershipFor(a),
      findMany: async () => [
        { id: 'm-owner', role: 'owner', createdAt: new Date(), user: USERS[OWNER_ID] },
        { id: 'm-admin', role: 'admin', createdAt: new Date(), user: USERS[ADMIN_ID] },
      ],
      create: async () => ({ id: 'm-new' }),
      delete: async () => ({ id: 'm-del' }),
      // Current seat count (free plan caps at 2) — below the cap by default so the
      // happy-path add-member tests pass; overridden per-test to hit the cap.
      count: async () => 1,
    },
    user: {
      findUnique: async (a: any) => userLookup(a),
    },
    workspace: {
      findUnique: async (a: any) => a?.where?.id === WS_ID
        ? { id: WS_ID, name: 'Acme', slug: 'acme', plan: 'free' }
        : null,
      update: async (a: any) => ({ id: WS_ID, ...a?.data }),
    },
    ...overrides,
  }
}

// ── Server lifecycle ──────────────────────────────────────────────────────────

let server: TestServer

before(async () => {
  server = await startTestServer('/api/workspaces', workspaceRouter)
})

beforeEach(() => {
  installPrisma(createFakePrisma(buildSpec()))
})

afterEach(() => {
  resetPrisma()
})

after(async () => {
  await server.close()
})

const ownerHeaders  = { Authorization: bearer(OWNER_ID),  'Content-Type': 'application/json' }
const adminHeaders  = { Authorization: bearer(ADMIN_ID),  'Content-Type': 'application/json' }
const memberHeaders = { Authorization: bearer(MEMBER_ID), 'Content-Type': 'application/json' }

// ── POST /:id/members ─────────────────────────────────────────────────────────

describe('POST /:id/members — add a member', () => {
  it('owner can add a new user by email', async () => {
    const res = await server.request(`/api/workspaces/${WS_ID}/members`, {
      method: 'POST',
      headers: ownerHeaders,
      body: JSON.stringify({ email: 'other@test.com' }),
    })
    assert.equal(res.status, 201)
    assert.equal(res.body.member.email, 'other@test.com')
    assert.equal(res.body.member.role, 'member', 'Default role is member')
  })

  it('admin can add a new user', async () => {
    const res = await server.request(`/api/workspaces/${WS_ID}/members`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ email: 'other@test.com' }),
    })
    assert.equal(res.status, 201)
  })

  it('rejects adding a member at the plan seat cap (free = 2) with 403 + upgrade hint', async () => {
    // Workspace already at the free-plan seat cap.
    installPrisma(createFakePrisma(buildSpec({
      membership: {
        findFirst: async (a: any) => membershipFor(a),
        findMany: async () => [],
        create: async () => ({ id: 'm-new' }),
        count: async () => 2, // at the free cap
      },
    })))
    const res = await server.request(`/api/workspaces/${WS_ID}/members`, {
      method: 'POST',
      headers: ownerHeaders,
      body: JSON.stringify({ email: 'other@test.com' }),
    })
    assert.equal(res.status, 403)
    assert.match(String(res.body.error), /Seat limit reached/)
  })

  it('plain member cannot add — 403', async () => {
    const res = await server.request(`/api/workspaces/${WS_ID}/members`, {
      method: 'POST',
      headers: memberHeaders,
      body: JSON.stringify({ email: 'other@test.com' }),
    })
    assert.equal(res.status, 403)
  })

  it('missing email returns 400', async () => {
    const res = await server.request(`/api/workspaces/${WS_ID}/members`, {
      method: 'POST',
      headers: ownerHeaders,
      body: JSON.stringify({ role: 'admin' }),
    })
    assert.equal(res.status, 400)
  })

  it('empty string email returns 400', async () => {
    const res = await server.request(`/api/workspaces/${WS_ID}/members`, {
      method: 'POST',
      headers: ownerHeaders,
      body: JSON.stringify({ email: '   ' }),
    })
    assert.equal(res.status, 400)
  })

  it('unknown email (user not in system) returns 404', async () => {
    const res = await server.request(`/api/workspaces/${WS_ID}/members`, {
      method: 'POST',
      headers: ownerHeaders,
      body: JSON.stringify({ email: 'nobody@unknown.com' }),
    })
    assert.equal(res.status, 404)
  })

  it('trying to add yourself returns 400', async () => {
    // The invitee email resolves to the same user as the caller (owner)
    installPrisma(createFakePrisma(buildSpec({
      user: {
        findUnique: async (a: any) => {
          if (a?.where?.id) return USERS[a.where.id] ?? null
          // Email lookup for the invite: return the owner themselves
          if (a?.where?.email === 'owner@test.com') return USERS[OWNER_ID]
          return EMAILS[a?.where?.email] ?? null
        },
      },
    })))
    const res = await server.request(`/api/workspaces/${WS_ID}/members`, {
      method: 'POST',
      headers: ownerHeaders,
      body: JSON.stringify({ email: 'owner@test.com' }),
    })
    assert.equal(res.status, 400)
  })

  it('already a member returns 409', async () => {
    // OTHER_ID is already in the workspace so both the canManage check (for owner)
    // and the "is the invitee already in?" check must work correctly
    installPrisma(createFakePrisma(buildSpec({
      membership: {
        findFirst: async (a: any) => membershipFor(a, { [OTHER_ID]: 'member' }),
        create: async () => ({ id: 'm-new' }),
        delete: async () => ({ id: 'm-del' }),
      },
    })))
    const res = await server.request(`/api/workspaces/${WS_ID}/members`, {
      method: 'POST',
      headers: ownerHeaders,
      body: JSON.stringify({ email: 'other@test.com' }),
    })
    assert.equal(res.status, 409)
  })

  it('role=admin is accepted and echoed back', async () => {
    const res = await server.request(`/api/workspaces/${WS_ID}/members`, {
      method: 'POST',
      headers: ownerHeaders,
      body: JSON.stringify({ email: 'other@test.com', role: 'admin' }),
    })
    assert.equal(res.status, 201)
    assert.equal(res.body.member.role, 'admin')
  })

  it('invalid role defaults to member', async () => {
    const res = await server.request(`/api/workspaces/${WS_ID}/members`, {
      method: 'POST',
      headers: ownerHeaders,
      body: JSON.stringify({ email: 'other@test.com', role: 'superadmin' }),
    })
    assert.equal(res.status, 201)
    assert.equal(res.body.member.role, 'member', 'Unrecognized role must fall back to member')
  })

  it('email is trimmed and lowercased before lookup', async () => {
    let capturedEmail: string | undefined
    installPrisma(createFakePrisma(buildSpec({
      user: {
        findUnique: async (a: any) => {
          if (a?.where?.id) return USERS[a.where.id] ?? null
          capturedEmail = a?.where?.email
          return { id: OTHER_ID, email: a?.where?.email, name: null }
        },
      },
      membership: {
        findFirst: async (a: any) => membershipFor(a),
        create: async () => ({}),
        delete: async () => ({}),
      },
    })))
    await server.request(`/api/workspaces/${WS_ID}/members`, {
      method: 'POST',
      headers: ownerHeaders,
      body: JSON.stringify({ email: '  OTHER@Test.COM  ' }),
    })
    assert.equal(capturedEmail, 'other@test.com')
  })
})

// ── DELETE /:id/members/:userId ───────────────────────────────────────────────

describe('DELETE /:id/members/:userId — remove a member', () => {
  it('owner can remove another member', async () => {
    installPrisma(createFakePrisma(buildSpec({
      membership: {
        findFirst: async (a: any) => {
          const { userId, workspaceId, role } = a?.where ?? {}
          if (workspaceId !== WS_ID) return null
          if (userId === OWNER_ID && (role === 'owner' || !role)) return { id: 'm-owner', role: 'owner' }
          if (userId === MEMBER_ID && !role) return { id: 'm-member', role: 'member' }
          return null
        },
        delete: async () => ({ id: 'm-member' }),
      },
    })))
    const res = await server.request(`/api/workspaces/${WS_ID}/members/${MEMBER_ID}`, {
      method: 'DELETE',
      headers: ownerHeaders,
    })
    assert.equal(res.status, 200)
    assert.equal(res.body.ok, true)
  })

  it('cannot remove yourself — 400', async () => {
    const res = await server.request(`/api/workspaces/${WS_ID}/members/${OWNER_ID}`, {
      method: 'DELETE',
      headers: ownerHeaders,
    })
    assert.equal(res.status, 400)
  })

  it('non-owner gets 403', async () => {
    installPrisma(createFakePrisma(buildSpec({
      membership: {
        findFirst: async (a: any) => {
          const { userId, workspaceId, role } = a?.where ?? {}
          if (workspaceId !== WS_ID) return null
          // Admin is not an owner; the "Only owners can remove members" check uses role: 'owner'
          if (userId === ADMIN_ID && role === 'owner') return null
          if (userId === ADMIN_ID) return { id: 'm-admin', role: 'admin' }
          return null
        },
        delete: async () => ({}),
      },
    })))
    const res = await server.request(`/api/workspaces/${WS_ID}/members/${MEMBER_ID}`, {
      method: 'DELETE',
      headers: adminHeaders,
    })
    assert.equal(res.status, 403)
  })

  it('target not in workspace → 404', async () => {
    installPrisma(createFakePrisma(buildSpec({
      membership: {
        findFirst: async (a: any) => {
          const { userId, workspaceId } = a?.where ?? {}
          if (workspaceId !== WS_ID) return null
          if (userId === OWNER_ID) return { id: 'm-owner', role: 'owner' }
          // Other users are NOT in the workspace
          return null
        },
        delete: async () => ({}),
      },
    })))
    const res = await server.request(`/api/workspaces/${WS_ID}/members/${OTHER_ID}`, {
      method: 'DELETE',
      headers: ownerHeaders,
    })
    assert.equal(res.status, 404)
  })
})

// ── POST /:id/api-key/rotate ──────────────────────────────────────────────────

describe('POST /:id/api-key/rotate — generate new ingest key', () => {
  it('owner receives a raw key and a warning message', async () => {
    const res = await server.request(`/api/workspaces/${WS_ID}/api-key/rotate`, {
      method: 'POST',
      headers: ownerHeaders,
    })
    assert.equal(res.status, 200)
    assert.equal(typeof res.body.apiKey, 'string', 'Raw key must be a string')
    assert.equal(typeof res.body.warning, 'string', 'Warning message must be present')
  })

  it('returned key is a 64-character hex string (32 random bytes)', async () => {
    const res = await server.request(`/api/workspaces/${WS_ID}/api-key/rotate`, {
      method: 'POST',
      headers: ownerHeaders,
    })
    assert.match(res.body.apiKey, /^[0-9a-f]{64}$/, 'Key must be lowercase hex, 64 chars')
  })

  it('admin can also rotate the key', async () => {
    const res = await server.request(`/api/workspaces/${WS_ID}/api-key/rotate`, {
      method: 'POST',
      headers: adminHeaders,
    })
    assert.equal(res.status, 200)
    assert.ok(res.body.apiKey)
  })

  it('plain member cannot rotate — 403', async () => {
    const res = await server.request(`/api/workspaces/${WS_ID}/api-key/rotate`, {
      method: 'POST',
      headers: memberHeaders,
    })
    assert.equal(res.status, 403)
  })

  it('raw key is not the stored hash (hash ≠ raw key)', async () => {
    let storedHash: string | undefined
    installPrisma(createFakePrisma(buildSpec({
      workspace: {
        update: async (a: any) => { storedHash = a?.data?.ingestApiKey; return { id: WS_ID } },
        findUnique: async () => ({ id: WS_ID, name: 'Acme', slug: 'acme', plan: 'free' }),
      },
    })))
    const res = await server.request(`/api/workspaces/${WS_ID}/api-key/rotate`, {
      method: 'POST',
      headers: ownerHeaders,
    })
    assert.ok(storedHash, 'Hash must have been written to the workspace')
    assert.notEqual(res.body.apiKey, storedHash, 'Stored hash must differ from raw key')
    assert.match(storedHash!, /^[0-9a-f]{64}$/, 'Stored value should be SHA-256 hex')
  })

  it('each rotation produces a unique key', async () => {
    const [r1, r2] = await Promise.all([
      server.request(`/api/workspaces/${WS_ID}/api-key/rotate`, { method: 'POST', headers: ownerHeaders }),
      server.request(`/api/workspaces/${WS_ID}/api-key/rotate`, { method: 'POST', headers: ownerHeaders }),
    ])
    assert.notEqual(r1.body.apiKey, r2.body.apiKey, 'Two rotations must produce different keys')
  })
})

// ── DELETE /:id/api-key ───────────────────────────────────────────────────────

describe('DELETE /:id/api-key — revoke ingest key', () => {
  it('owner can revoke the key', async () => {
    const res = await server.request(`/api/workspaces/${WS_ID}/api-key`, {
      method: 'DELETE',
      headers: ownerHeaders,
    })
    assert.equal(res.status, 200)
    assert.equal(res.body.ok, true)
  })

  it('admin can revoke the key', async () => {
    const res = await server.request(`/api/workspaces/${WS_ID}/api-key`, {
      method: 'DELETE',
      headers: adminHeaders,
    })
    assert.equal(res.status, 200)
  })

  it('plain member cannot revoke — 403', async () => {
    const res = await server.request(`/api/workspaces/${WS_ID}/api-key`, {
      method: 'DELETE',
      headers: memberHeaders,
    })
    assert.equal(res.status, 403)
  })

  it('revoke sets ingestApiKey to null in the database', async () => {
    let updateArg: any
    installPrisma(createFakePrisma(buildSpec({
      workspace: {
        update: async (a: any) => { updateArg = a; return { id: WS_ID } },
        findUnique: async () => ({ id: WS_ID, name: 'Acme', slug: 'acme', plan: 'free' }),
      },
    })))
    await server.request(`/api/workspaces/${WS_ID}/api-key`, {
      method: 'DELETE',
      headers: ownerHeaders,
    })
    assert.equal(updateArg?.data?.ingestApiKey, null, 'ingestApiKey must be set to null')
  })
})

// ── Unauthenticated requests ──────────────────────────────────────────────────

describe('unauthenticated requests are rejected', () => {
  it('POST /members without auth → 401', async () => {
    const res = await server.request(`/api/workspaces/${WS_ID}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'other@test.com' }),
    })
    assert.equal(res.status, 401)
  })

  it('DELETE /members/:id without auth → 401', async () => {
    const res = await server.request(`/api/workspaces/${WS_ID}/members/${MEMBER_ID}`, {
      method: 'DELETE',
    })
    assert.equal(res.status, 401)
  })

  it('POST /api-key/rotate without auth → 401', async () => {
    const res = await server.request(`/api/workspaces/${WS_ID}/api-key/rotate`, {
      method: 'POST',
    })
    assert.equal(res.status, 401)
  })

  it('DELETE /api-key without auth → 401', async () => {
    const res = await server.request(`/api/workspaces/${WS_ID}/api-key`, {
      method: 'DELETE',
    })
    assert.equal(res.status, 401)
  })
})
