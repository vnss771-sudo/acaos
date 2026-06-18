// Integration tests for the /api/signals router.
//
// These focus on workspace authorization — the highest-risk gap, since the
// signals endpoints are scoped by a client-supplied workspaceId / signal id.
// A user must only ever read, create, or delete signals in a workspace they
// are a member of.

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { signalsRouter } from '../apps/api/src/routes/signals.ts'
import {
  createFakePrisma,
  installPrisma,
  resetPrisma,
  startTestServer,
  bearer,
  type FakePrisma,
  type TestServer,
} from './helpers/integration.ts'

// World: user `u1` is a member of `ws1` only. `ws2` belongs to someone else.
const MEMBER = 'u1'
const OWNED_WS = 'ws1'
const OTHER_WS = 'ws2'

function membershipFor(userId: string, workspaceId: string) {
  return userId === MEMBER && workspaceId === OWNED_WS ? { id: 'm1', role: 'admin' } : null
}

function baseSpec() {
  return {
    user: {
      findUnique: async () => ({ id: MEMBER, email: 'u1@acme.test', name: null }),
    },
    membership: {
      findFirst: async (args: any) =>
        membershipFor(args?.where?.userId, args?.where?.workspaceId),
    },
    signal: {
      findMany: async (args: any) => {
        const ws = args?.where?.workspaceId
        return [
          {
            id: 'sig-1',
            workspaceId: ws,
            prospectId: args?.where?.prospectId ?? 'p1',
            type: 'FUNDING',
            strength: 80,
            sourceReliability: 70,
            industryRelevance: 50,
            detectedAt: new Date(),
          },
        ]
      },
      findUnique: async (args: any) => {
        const id = args?.where?.id
        if (id === 'sig-owned') return { id, workspaceId: OWNED_WS, prospectId: 'p1' }
        if (id === 'sig-other') return { id, workspaceId: OTHER_WS, prospectId: 'p2' }
        return null
      },
      create: async (args: any) => ({ id: 'sig-new', ...args.data }),
      upsert: async (args: any) => ({ id: 'sig-new', ...args.create }),
      delete: async (args: any) => ({ id: args?.where?.id }),
    },
    prospect: {
      findUnique: async (args: any) => {
        const id = args?.where?.id
        if (id === 'p1') {
          return {
            id,
            workspaceId: OWNED_WS,
            industry: 'construction',
            employeeCount: 50,
            contactEmail: 'c@x.test',
            contactName: 'C',
            domain: 'x.test',
          }
        }
        if (id === 'p-other') {
          return { id, workspaceId: OTHER_WS, industry: 'retail', employeeCount: 10 }
        }
        return null
      },
      update: async (args: any) => ({ id: args?.where?.id, ...args?.data }),
    },
  }
}

let prisma: FakePrisma
let server: TestServer

beforeEach(async () => {
  prisma = createFakePrisma(baseSpec())
  installPrisma(prisma)
  server = await startTestServer('/api/signals', signalsRouter)
})

afterEach(async () => {
  await server.close()
  resetPrisma()
})

// --- GET /api/signals ---

test('GET requires authentication', async () => {
  const res = await server.request(`/api/signals?workspaceId=${OWNED_WS}`)
  assert.equal(res.status, 401)
})

test('GET requires a workspaceId', async () => {
  const res = await server.request('/api/signals', {
    headers: { Authorization: bearer(MEMBER) },
  })
  assert.equal(res.status, 400)
})

test('GET returns signals for a workspace the user belongs to', async () => {
  const res = await server.request(`/api/signals?workspaceId=${OWNED_WS}`, {
    headers: { Authorization: bearer(MEMBER) },
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.signals[0].workspaceId, OWNED_WS)
})

test('GET denies access to a workspace the user does NOT belong to', async () => {
  const res = await server.request(`/api/signals?workspaceId=${OTHER_WS}`, {
    headers: { Authorization: bearer(MEMBER) },
  })
  assert.equal(res.status, 403)
  // The query for another workspace's signals must never run.
  assert.equal(prisma.callsTo('signal', 'findMany').length, 0)
})

// --- POST /api/signals ---

test('POST validates required fields and strength range', async () => {
  const auth = { Authorization: bearer(MEMBER), 'Content-Type': 'application/json' }

  const missing = await server.request('/api/signals', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ workspaceId: OWNED_WS }),
  })
  assert.equal(missing.status, 400)

  const badStrength = await server.request('/api/signals', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      workspaceId: OWNED_WS,
      prospectId: 'p1',
      type: 'FUNDING',
      strength: 150,
    }),
  })
  assert.equal(badStrength.status, 400)
})

test('POST creates a signal and rescores the prospect in the owned workspace', async () => {
  const res = await server.request('/api/signals', {
    method: 'POST',
    headers: { Authorization: bearer(MEMBER), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workspaceId: OWNED_WS,
      prospectId: 'p1',
      type: 'FUNDING',
      strength: 80,
    }),
  })
  assert.equal(res.status, 201)
  assert.equal(prisma.callsTo('signal', 'upsert').length, 1)
  // Prospect rescore side effect ran.
  assert.equal(prisma.callsTo('prospect', 'update').length, 1)
})

test('POST denies creating a signal in a workspace the user does NOT belong to', async () => {
  const res = await server.request('/api/signals', {
    method: 'POST',
    headers: { Authorization: bearer(MEMBER), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workspaceId: OTHER_WS,
      prospectId: 'p-other',
      type: 'FUNDING',
      strength: 80,
    }),
  })
  assert.equal(res.status, 403)
  assert.equal(prisma.callsTo('signal', 'upsert').length, 0)
})

// --- DELETE /api/signals/:id ---

test('DELETE returns 404 for an unknown signal', async () => {
  const res = await server.request('/api/signals/does-not-exist', {
    method: 'DELETE',
    headers: { Authorization: bearer(MEMBER) },
  })
  assert.equal(res.status, 404)
})

test('DELETE removes a signal in the owned workspace', async () => {
  const res = await server.request('/api/signals/sig-owned', {
    method: 'DELETE',
    headers: { Authorization: bearer(MEMBER) },
  })
  assert.equal(res.status, 200)
  assert.equal(prisma.callsTo('signal', 'delete').length, 1)
})

test('DELETE denies removing a signal in another workspace and does not delete', async () => {
  const res = await server.request('/api/signals/sig-other', {
    method: 'DELETE',
    headers: { Authorization: bearer(MEMBER) },
  })
  assert.equal(res.status, 403)
  assert.equal(prisma.callsTo('signal', 'delete').length, 0)
})
