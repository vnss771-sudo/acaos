// Integration tests for /api/workspaces — listing, creation, role-gated update,
// billing portal, and members.

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { workspaceRouter } from '../apps/api/src/routes/workspaces.ts'
import {
  createFakePrisma, installPrisma, resetPrisma, startTestServer, bearer,
  type FakePrisma, type TestServer,
} from './helpers/integration.ts'

const USER = 'u1'
const WS = 'ws1'

// role lookup: USER is owner of WS; a separate 'admin-only' filter is honored.
function membershipFor(a: any) {
  const { userId, workspaceId, role } = a?.where ?? {}
  if (workspaceId !== WS || userId !== USER) return null
  if (role?.in && !role.in.includes('owner')) return null
  return { role: 'owner' }
}

function spec(extra: Record<string, any> = {}) {
  return {
    user: { findUnique: async () => ({ id: USER, email: 'u1@a.test', name: null }) },
    membership: { findFirst: async (a: any) => membershipFor(a), findMany: async () => [
      { id: 'm1', role: 'owner', createdAt: new Date(), user: { id: USER, email: 'u1@a.test', name: null } },
    ] },
    workspace: {
      findMany: async () => [{ id: WS, name: 'Acme', slug: 'acme', plan: 'free', _count: { leads: 2, campaigns: 1 } }],
      create: async (a: any) => ({ id: 'ws-new', ...a.data }),
      findUnique: async (a: any) => a?.where?.id === WS
        ? { id: WS, name: 'Acme', slug: 'acme', plan: 'free', stripeCustomerId: null, _count: { leads: 2, campaigns: 1 } }
        : null,
      update: async (a: any) => ({ id: WS, ...a.data }),
    },
    ...extra,
  }
}

let prisma: FakePrisma
let server: TestServer
beforeEach(async () => { prisma = createFakePrisma(spec()); installPrisma(prisma); server = await startTestServer('/api/workspaces', workspaceRouter) })
afterEach(async () => { await server.close(); resetPrisma() })

const auth = { Authorization: bearer(USER) }
const jsonAuth = { Authorization: bearer(USER), 'Content-Type': 'application/json' }

test('GET / lists the user\'s workspaces with counts', async () => {
  const res = await server.request('/api/workspaces', { headers: auth })
  assert.equal(res.status, 200)
  assert.equal(res.body.workspaces[0]._count.campaigns, 1)
})

test('POST / requires a name', async () => {
  const res = await server.request('/api/workspaces', { method: 'POST', headers: jsonAuth, body: JSON.stringify({}) })
  assert.equal(res.status, 400)
})

test('POST / creates a workspace with the caller as owner', async () => {
  const res = await server.request('/api/workspaces', { method: 'POST', headers: jsonAuth, body: JSON.stringify({ name: 'New Co' }) })
  assert.equal(res.status, 201)
  assert.equal(res.body.workspace.name, 'New Co')
})

test('GET /:id returns the workspace with the caller\'s role', async () => {
  const res = await server.request(`/api/workspaces/${WS}`, { headers: auth })
  assert.equal(res.status, 200)
  assert.equal(res.body.workspace.role, 'owner')
})

test('GET /:id denies a non-member', async () => {
  prisma = createFakePrisma(spec({ membership: { findFirst: async () => null } }))
  installPrisma(prisma)
  const res = await server.request(`/api/workspaces/${WS}`, { headers: auth })
  assert.equal(res.status, 403)
})

test('PATCH /:id updates name for an owner', async () => {
  const res = await server.request(`/api/workspaces/${WS}`, { method: 'PATCH', headers: jsonAuth, body: JSON.stringify({ name: 'Renamed' }) })
  assert.equal(res.status, 200)
  assert.equal(res.body.workspace.name, 'Renamed')
})

test('PATCH /:id rejects an empty update', async () => {
  const res = await server.request(`/api/workspaces/${WS}`, { method: 'PATCH', headers: jsonAuth, body: JSON.stringify({}) })
  assert.equal(res.status, 400)
})

test('PATCH /:id denies a non-owner/admin', async () => {
  prisma = createFakePrisma(spec({
    membership: { findFirst: async (a: any) => (a?.where?.role?.in ? null : { role: 'member' }) },
  }))
  installPrisma(prisma)
  const res = await server.request(`/api/workspaces/${WS}`, { method: 'PATCH', headers: jsonAuth, body: JSON.stringify({ name: 'X' }) })
  assert.equal(res.status, 403)
})

test('billing-portal fails when no Stripe customer exists', async () => {
  const res = await server.request(`/api/workspaces/${WS}/billing-portal`, { method: 'POST', headers: jsonAuth, body: '{}' })
  assert.equal(res.status, 400) // owner allowed, but no stripeCustomerId
})

test('GET /:id/members lists members for a member', async () => {
  const res = await server.request(`/api/workspaces/${WS}/members`, { headers: auth })
  assert.equal(res.status, 200)
  assert.equal(res.body.members[0].user.email, 'u1@a.test')
})
