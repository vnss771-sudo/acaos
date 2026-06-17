// Integration tests for the /api/prospects router.
//
// Covers workspace authorization on read/write endpoints and the Apollo
// enrichment endpoint, which previously failed with an unhandled
// module-not-found (500) and now returns a clean 503 when the integration is
// not configured.

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { prospectsRouter } from '../apps/api/src/routes/prospects.ts'
import {
  createFakePrisma,
  installPrisma,
  resetPrisma,
  startTestServer,
  bearer,
  type FakePrisma,
  type TestServer,
} from './helpers/integration.ts'

const MEMBER = 'u1'
const OWNED_WS = 'ws1'
const OTHER_WS = 'ws2'

function membershipFor(userId: string, workspaceId: string) {
  return userId === MEMBER && workspaceId === OWNED_WS ? { id: 'm1' } : null
}

function prospectRow(workspaceId: string, id = 'p1') {
  return {
    id,
    workspaceId,
    companyName: 'Acme',
    domain: 'acme.test',
    industry: 'construction',
    employeeCount: 50,
    location: 'NYC',
    contactName: 'C',
    contactEmail: 'c@acme.test',
    contactPhone: null,
    contactTitle: null,
    linkedinUrl: null,
    opportunityScore: 80,
    intentScore: 70,
    fitScore: 75,
    timingScore: 60,
    confidenceScore: 65,
    buyingStage: 'PURCHASING',
    outcomeStage: 'DISCOVERED',
    expectedDealValue: null,
    winProbability: 0.4,
    lastSignalAt: null,
    lastContactedAt: null,
    sourceTag: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    signals: [],
    recommendations: [],
    outcomes: [],
    _count: { signals: 0 },
  }
}

function spec() {
  return {
    user: { findUnique: async () => ({ id: MEMBER, email: 'u1@acme.test', name: null }) },
    membership: {
      findFirst: async (args: any) => membershipFor(args?.where?.userId, args?.where?.workspaceId),
    },
    prospect: {
      findMany: async (args: any) => [prospectRow(args?.where?.workspaceId)],
      count: async () => 1,
      findUnique: async (args: any) => {
        if (args?.where?.id === 'p1') return prospectRow(OWNED_WS, 'p1')
        if (args?.where?.id === 'p-other') return prospectRow(OTHER_WS, 'p-other')
        return null
      },
      create: async (args: any) => ({ ...prospectRow(OWNED_WS), ...args.data }),
      update: async (args: any) => ({ ...prospectRow(OWNED_WS), ...args.data }),
      delete: async () => ({ id: 'p1' }),
    },
    workspaceICP: { findUnique: async () => null },
    signal: { findMany: async () => [] },
  }
}

let prisma: FakePrisma
let server: TestServer

beforeEach(async () => {
  delete process.env.APOLLO_API_KEY // ensure enrichment is "not configured"
  prisma = createFakePrisma(spec())
  installPrisma(prisma)
  server = await startTestServer('/api/prospects', prospectsRouter)
})

afterEach(async () => {
  await server.close()
  resetPrisma()
})

const auth = (u: string) => ({ Authorization: bearer(u) })

// --- list / read authz ---

test('GET / denies a workspace the user does not belong to', async () => {
  const res = await server.request(`/api/prospects?workspaceId=${OTHER_WS}`, { headers: auth(MEMBER) })
  assert.equal(res.status, 403)
  assert.equal(prisma.callsTo('prospect', 'findMany').length, 0)
})

test('GET / succeeds for a member', async () => {
  const res = await server.request(`/api/prospects?workspaceId=${OWNED_WS}`, { headers: auth(MEMBER) })
  assert.equal(res.status, 200)
  assert.equal(res.body.prospects.length, 1)
  assert.equal(res.body.prospects[0].tier, 'HOT')
})

test('GET /:id denies access to another workspace\'s prospect', async () => {
  const res = await server.request('/api/prospects/p-other', { headers: auth(MEMBER) })
  assert.equal(res.status, 403)
})

test('GET /:id returns 404 for an unknown prospect', async () => {
  const res = await server.request('/api/prospects/missing', { headers: auth(MEMBER) })
  assert.equal(res.status, 404)
})

// --- write authz ---

test('POST / requires companyName', async () => {
  const res = await server.request('/api/prospects', {
    method: 'POST',
    headers: { ...auth(MEMBER), 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceId: OWNED_WS }),
  })
  assert.equal(res.status, 400)
})

test('DELETE /:id denies another workspace and does not delete', async () => {
  const res = await server.request('/api/prospects/p-other', { method: 'DELETE', headers: auth(MEMBER) })
  assert.equal(res.status, 403)
  assert.equal(prisma.callsTo('prospect', 'delete').length, 0)
})

// --- rescore ---

test('POST /:id/rescore recomputes scores for a member', async () => {
  const res = await server.request('/api/prospects/p1/rescore', { method: 'POST', headers: auth(MEMBER) })
  assert.equal(res.status, 200)
  assert.equal(prisma.callsTo('prospect', 'update').length, 1)
})

// --- enrich (Apollo scaffold) ---

test('POST /:id/enrich returns a clean 503 when Apollo is not configured', async () => {
  const res = await server.request('/api/prospects/p1/enrich', { method: 'POST', headers: auth(MEMBER) })
  assert.equal(res.status, 503)
})

test('POST /:id/enrich still enforces workspace access before anything else', async () => {
  const res = await server.request('/api/prospects/p-other/enrich', { method: 'POST', headers: auth(MEMBER) })
  assert.equal(res.status, 403)
})

test('GET /:id/intents returns the prospect bridge intents for a member', async () => {
  const s = spec()
  ;(s as any).outreachIntent = { findMany: async () => [{ id: 'oi1', status: 'PROPOSED', recommendationId: 'r1' }] }
  installPrisma(createFakePrisma(s))
  const res = await server.request('/api/prospects/p1/intents', { headers: auth(MEMBER) })
  assert.equal(res.status, 200)
  assert.equal(res.body.intents[0].status, 'PROPOSED')
})

test('GET /:id/intents denies a prospect in another workspace', async () => {
  const res = await server.request('/api/prospects/p-other/intents', { headers: auth(MEMBER) })
  assert.equal(res.status, 403)
})

test('POST /:id/intents/:intentId/draft denies another workspace', async () => {
  const res = await server.request('/api/prospects/p-other/intents/oi1/draft', { method: 'POST', headers: auth(MEMBER) })
  assert.equal(res.status, 403)
})

test('POST /:id/intents/:intentId/draft 404 when the intent is missing', async () => {
  const s = spec(); (s as any).outreachIntent = { findUnique: async () => null }
  installPrisma(createFakePrisma(s))
  const res = await server.request('/api/prospects/p1/intents/missing/draft', { method: 'POST', headers: auth(MEMBER) })
  assert.equal(res.status, 404)
})

test('POST /:id/intents/:intentId/draft returns 503 when AI is unconfigured', async () => {
  const saved = process.env.OPENAI_API_KEY
  delete process.env.OPENAI_API_KEY
  try {
    const s = spec(); (s as any).outreachIntent = { findUnique: async () => ({ id: 'oi1', prospectId: 'p1', recommendationId: null, messageAngle: 'x' }) }
    installPrisma(createFakePrisma(s))
    const res = await server.request('/api/prospects/p1/intents/oi1/draft', { method: 'POST', headers: auth(MEMBER) })
    assert.equal(res.status, 503)
  } finally {
    if (saved !== undefined) process.env.OPENAI_API_KEY = saved
  }
})
