// Integration tests for /api/campaigns — CRUD with workspace authorization.

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { campaignsRouter } from '../apps/api/src/routes/campaigns.ts'
import {
  createFakePrisma, installPrisma, resetPrisma, startTestServer, bearer,
  type FakePrisma, type TestServer,
} from './helpers/integration.ts'

const MEMBER = 'u1'
const OWNED = 'ws1'
const OTHER = 'ws2'
const member = (uid: string, wid: string) => (uid === MEMBER && wid === OWNED ? { id: 'm1' } : null)

function spec() {
  return {
    user: { findUnique: async () => ({ id: MEMBER, email: 'u1@a.test', name: null }) },
    membership: { findFirst: async (a: any) => member(a?.where?.userId, a?.where?.workspaceId) },
    campaign: {
      findMany: async () => [{ id: 'c1', name: 'C', goalType: 'BOOK_CALL', _count: { leads: 3 } }],
      create: async (a: any) => ({ id: 'c-new', ...a.data }),
      findUnique: async (a: any) => {
        if (a?.where?.id === 'c1') return { id: 'c1', workspaceId: OWNED, name: 'C', goalType: 'BOOK_CALL' }
        if (a?.where?.id === 'c-other') return { id: 'c-other', workspaceId: OTHER, name: 'X', goalType: 'BOOK_CALL' }
        return null
      },
      update: async (a: any) => ({ id: a?.where?.id, ...a.data }),
      delete: async () => ({ id: 'c1' }),
    },
    // Defaults for send-readiness: nothing configured.
    workspaceEmailConfig: { findUnique: async () => null },
    workspace: { findUnique: async () => ({ senderBusinessName: null, senderPostalAddress: null }) },
  }
}

let prisma: FakePrisma
let server: TestServer
beforeEach(async () => { prisma = createFakePrisma(spec()); installPrisma(prisma); server = await startTestServer('/api/campaigns', campaignsRouter) })
afterEach(async () => { await server.close(); resetPrisma() })

const auth = (u = MEMBER) => ({ Authorization: bearer(u) })
const jsonAuth = (u = MEMBER) => ({ Authorization: bearer(u), 'Content-Type': 'application/json' })

test('GET requires auth', async () => {
  assert.equal((await server.request(`/api/campaigns?workspaceId=${OWNED}`)).status, 401)
})
test('GET requires workspaceId', async () => {
  assert.equal((await server.request('/api/campaigns', { headers: auth() })).status, 400)
})
test('GET denies a non-member workspace', async () => {
  assert.equal((await server.request(`/api/campaigns?workspaceId=${OTHER}`, { headers: auth() })).status, 403)
})
test('GET lists campaigns with lead counts for a member', async () => {
  const res = await server.request(`/api/campaigns?workspaceId=${OWNED}`, { headers: auth() })
  assert.equal(res.status, 200)
  assert.equal(res.body.campaigns[0]._count.leads, 3)
})

test('POST requires a name', async () => {
  const res = await server.request('/api/campaigns', { method: 'POST', headers: jsonAuth(), body: JSON.stringify({ workspaceId: OWNED }) })
  assert.equal(res.status, 400)
})
test('POST denies a non-member workspace', async () => {
  const res = await server.request('/api/campaigns', { method: 'POST', headers: jsonAuth(), body: JSON.stringify({ workspaceId: OTHER, name: 'X' }) })
  assert.equal(res.status, 403)
  assert.equal(prisma.callsTo('campaign', 'create').length, 0)
})
test('POST creates a campaign for a member', async () => {
  const res = await server.request('/api/campaigns', { method: 'POST', headers: jsonAuth(), body: JSON.stringify({ workspaceId: OWNED, name: 'Spring', goalType: 'GET_REPLY' }) })
  assert.equal(res.status, 201)
  assert.equal(res.body.campaign.name, 'Spring')
})

test('GET /:id returns 404 for unknown', async () => {
  assert.equal((await server.request('/api/campaigns/missing', { headers: auth() })).status, 404)
})
test('GET /:id denies a campaign in another workspace', async () => {
  assert.equal((await server.request('/api/campaigns/c-other', { headers: auth() })).status, 403)
})

test('PATCH updates a campaign for a member', async () => {
  const res = await server.request('/api/campaigns/c1', { method: 'PATCH', headers: jsonAuth(), body: JSON.stringify({ name: 'Renamed' }) })
  assert.equal(res.status, 200)
  assert.equal(res.body.campaign.name, 'Renamed')
})
test('PATCH denies another workspace', async () => {
  const res = await server.request('/api/campaigns/c-other', { method: 'PATCH', headers: jsonAuth(), body: JSON.stringify({ name: 'X' }) })
  assert.equal(res.status, 403)
})

test('DELETE removes a member campaign but denies another workspace', async () => {
  assert.equal((await server.request('/api/campaigns/c-other', { method: 'DELETE', headers: auth() })).status, 403)
  assert.equal(prisma.callsTo('campaign', 'delete').length, 0)
  assert.equal((await server.request('/api/campaigns/c1', { method: 'DELETE', headers: auth() })).status, 200)
  assert.equal(prisma.callsTo('campaign', 'delete').length, 1)
})

test('GET /send-readiness requires workspaceId and membership', async () => {
  assert.equal((await server.request('/api/campaigns/send-readiness', { headers: auth() })).status, 400)
  assert.equal((await server.request(`/api/campaigns/send-readiness?workspaceId=${OTHER}`, { headers: auth() })).status, 403)
})

test('GET /send-readiness reports not-ready with actionable checks when unconfigured', async () => {
  const res = await server.request(`/api/campaigns/send-readiness?workspaceId=${OWNED}`, { headers: auth() })
  assert.equal(res.status, 200)
  assert.equal(res.body.ready, false)
  const names = res.body.checks.map((c: any) => c.name).sort()
  assert.deepEqual(names, ['senderBusinessName', 'senderPostalAddress', 'smtpConfigured'])
  for (const c of res.body.checks) assert.ok(c.label && c.hint, 'each check has a label + hint')
})

test('GET /send-readiness reports ready when SMTP + sender identity are set', async () => {
  const s = spec()
  s.workspaceEmailConfig = { findUnique: async () => ({ smtpHost: 'smtp.test', smtpFrom: 'a@test' }) } as any
  s.workspace = { findUnique: async () => ({ senderBusinessName: 'Acme', senderPostalAddress: '1 St' }) } as any
  installPrisma(createFakePrisma(s))
  const res = await server.request(`/api/campaigns/send-readiness?workspaceId=${OWNED}`, { headers: auth() })
  assert.equal(res.status, 200)
  assert.equal(res.body.ready, true)
  assert.ok(res.body.checks.every((c: any) => c.ok))
})
