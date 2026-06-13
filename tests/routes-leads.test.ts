// Integration tests for /api/leads — list/CRUD/bulk operations, each
// workspace-scoped, plus scoring on create and bulk caps.

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { leadsRouter } from '../apps/api/src/routes/leads.ts'
import {
  createFakePrisma, installPrisma, resetPrisma, startTestServer, bearer,
  type FakePrisma, type TestServer,
} from './helpers/integration.ts'

const USER = 'u1'
const OWNED = 'ws1'
const OTHER = 'ws2'
const member = (uid: string, wid: string) => (uid === USER && wid === OWNED ? { id: 'm1' } : null)

function spec() {
  return {
    user: { findUnique: async () => ({ id: USER, email: 'u1@a.test', name: null }) },
    membership: { findFirst: async (a: any) => member(a?.where?.userId, a?.where?.workspaceId) },
    workspace: { findUnique: async () => ({ plan: 'free', subscriptionStatus: null }) }, // checkLeadLimit
    scoringModel: { findUnique: async () => null }, // → DEFAULT_SCORING_WEIGHTS
    campaign: { findFirst: async (a: any) => (a?.where?.id === 'camp-own' ? { id: 'camp-own' } : null) },
    lead: {
      count: async () => 10,
      findMany: async () => [{ id: 'l1', businessName: 'Acme', score: 80, stage: 'NEW' }],
      create: async (a: any) => ({ id: 'l-new', ...a.data }),
      createMany: async (a: any) => ({ count: a.data.length }),
      findUnique: async (a: any) => {
        if (a?.where?.id === 'l-own') return { id: 'l-own', workspaceId: OWNED, businessName: 'Acme', stage: 'NEW' }
        if (a?.where?.id === 'l-other') return { id: 'l-other', workspaceId: OTHER, businessName: 'X', stage: 'NEW' }
        return null
      },
      update: async (a: any) => ({ id: a?.where?.id, ...a.data }),
      delete: async () => ({ id: 'l-own' }),
      deleteMany: async (a: any) => ({ count: (a?.where?.id?.in ?? []).length }),
      updateMany: async (a: any) => ({ count: (a?.where?.id?.in ?? []).length }),
    },
  }
}

let prisma: FakePrisma
let server: TestServer
beforeEach(async () => { prisma = createFakePrisma(spec()); installPrisma(prisma); server = await startTestServer('/api/leads', leadsRouter) })
afterEach(async () => { await server.close(); resetPrisma() })

const auth = (u = USER) => ({ Authorization: bearer(u) })
const jsonAuth = (u = USER) => ({ Authorization: bearer(u), 'Content-Type': 'application/json' })
const body = (b: unknown) => JSON.stringify(b)

// --- list ---
test('GET / requires workspaceId', async () => {
  assert.equal((await server.request('/api/leads', { headers: auth() })).status, 400)
})
test('GET / denies a non-member workspace', async () => {
  assert.equal((await server.request(`/api/leads?workspaceId=${OTHER}`, { headers: auth() })).status, 403)
})
test('GET / returns paginated leads for a member', async () => {
  const res = await server.request(`/api/leads?workspaceId=${OWNED}&limit=10`, { headers: auth() })
  assert.equal(res.status, 200)
  assert.equal(res.body.total, 10)
  assert.equal(res.body.leads.length, 1)
})

// --- create ---
test('POST / requires businessName', async () => {
  const res = await server.request('/api/leads', { method: 'POST', headers: jsonAuth(), body: body({ workspaceId: OWNED }) })
  assert.equal(res.status, 400)
})
test('POST / denies a non-member workspace', async () => {
  const res = await server.request('/api/leads', { method: 'POST', headers: jsonAuth(), body: body({ workspaceId: OTHER, businessName: 'X' }) })
  assert.equal(res.status, 403)
  assert.equal(prisma.callsTo('lead', 'create').length, 0)
})
test('POST / creates a scored lead for a member', async () => {
  const res = await server.request('/api/leads', { method: 'POST', headers: jsonAuth(), body: body({ workspaceId: OWNED, businessName: 'Acme', category: 'electrical contractor', email: 'c@acme.test' }) })
  assert.equal(res.status, 201)
  assert.equal(typeof res.body.lead.score, 'number')
})

// --- import ---
test('POST /import rejects more than 500 leads', async () => {
  const leads = Array.from({ length: 501 }, (_, i) => ({ businessName: `B${i}` }))
  const res = await server.request('/api/leads/import', { method: 'POST', headers: jsonAuth(), body: body({ workspaceId: OWNED, leads }) })
  assert.equal(res.status, 400)
})
test('POST /import creates valid rows and reports the count', async () => {
  const res = await server.request('/api/leads/import', { method: 'POST', headers: jsonAuth(), body: body({ workspaceId: OWNED, leads: [{ businessName: 'A' }, { businessName: 'B' }, { notName: 'skip' }] }) })
  assert.equal(res.status, 200)
  assert.equal(res.body.created, 2)
})

// --- get/update/delete by id ---
test('GET /:id denies another workspace\'s lead', async () => {
  assert.equal((await server.request('/api/leads/l-other', { headers: auth() })).status, 403)
})
test('PATCH /:id rejects an invalid stage', async () => {
  const res = await server.request('/api/leads/l-own', { method: 'PATCH', headers: jsonAuth(), body: body({ stage: 'NONSENSE' }) })
  assert.equal(res.status, 400)
})
test('PATCH /:id updates and rescores a member lead', async () => {
  const res = await server.request('/api/leads/l-own', { method: 'PATCH', headers: jsonAuth(), body: body({ category: 'plumbing', stage: 'RESEARCHED' }) })
  assert.equal(res.status, 200)
  assert.equal(res.body.lead.stage, 'RESEARCHED')
})
test('DELETE /:id denies another workspace but allows own', async () => {
  assert.equal((await server.request('/api/leads/l-other', { method: 'DELETE', headers: auth() })).status, 403)
  assert.equal((await server.request('/api/leads/l-own', { method: 'DELETE', headers: auth() })).status, 200)
})

// --- bulk ---
test('bulk-delete enforces the 200 cap', async () => {
  const ids = Array.from({ length: 201 }, (_, i) => `id${i}`)
  const res = await server.request('/api/leads/bulk-delete', { method: 'POST', headers: jsonAuth(), body: body({ workspaceId: OWNED, ids }) })
  assert.equal(res.status, 400)
})
test('bulk-stage rejects an invalid stage', async () => {
  const res = await server.request('/api/leads/bulk-stage', { method: 'POST', headers: jsonAuth(), body: body({ workspaceId: OWNED, ids: ['a'], stage: 'BOGUS' }) })
  assert.equal(res.status, 400)
})
test('bulk-assign rejects a campaign not in the workspace', async () => {
  const res = await server.request('/api/leads/bulk-assign', { method: 'POST', headers: jsonAuth(), body: body({ workspaceId: OWNED, ids: ['a'], campaignId: 'camp-foreign' }) })
  assert.equal(res.status, 404)
})
test('bulk-assign assigns a valid workspace campaign', async () => {
  const res = await server.request('/api/leads/bulk-assign', { method: 'POST', headers: jsonAuth(), body: body({ workspaceId: OWNED, ids: ['a', 'b'], campaignId: 'camp-own' }) })
  assert.equal(res.status, 200)
  assert.equal(res.body.updated, 2)
})
