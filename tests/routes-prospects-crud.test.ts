// Supplementary /api/prospects tests covering the create / get / patch /
// outcome / recommend handlers (the authz + enrich paths live in
// routes-prospects.test.ts).

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { prospectsRouter } from '../apps/api/src/routes/prospects.ts'
import {
  createFakePrisma, installPrisma, resetPrisma, startTestServer, bearer,
  type FakePrisma, type TestServer,
} from './helpers/integration.ts'

const USER = 'u1'
const WS = 'ws1'
const member = (uid: string, wid: string) => (uid === USER && wid === WS ? { id: 'm1', role: 'admin' } : null)

function row(id = 'p1') {
  return {
    id, workspaceId: WS, companyName: 'Acme', domain: 'acme.test', industry: 'construction',
    employeeCount: 50, location: 'NYC', contactName: 'C', contactEmail: 'c@acme.test',
    contactPhone: null, contactTitle: null, linkedinUrl: null, opportunityScore: 80,
    intentScore: 70, fitScore: 75, timingScore: 60, confidenceScore: 65, buyingStage: 'PURCHASING',
    outcomeStage: 'DISCOVERED', expectedDealValue: null, winProbability: 0.4, lastSignalAt: null,
    lastContactedAt: null, aiSummary: null, sourceTag: null, createdAt: new Date(), updatedAt: new Date(),
    signals: [], recommendations: [], outcomes: [],
  }
}

function spec() {
  return {
    user: { findUnique: async () => ({ id: USER, email: 'u1@a.test', name: null, emailVerified: true }) },
    membership: { findFirst: async (a: any) => member(a?.where?.userId, a?.where?.workspaceId) },
    workspaceICP: { findUnique: async () => null },
    prospect: {
      findUnique: async (a: any) => (a?.where?.id === 'p1' ? row('p1') : null),
      create: async (a: any) => ({ ...row('p-new'), ...a.data }),
      update: async (a: any) => ({ ...row(a?.where?.id), ...a.data }),
    },
    prospectOutcome: { create: async (a: any) => ({ id: 'oc1', ...a.data }) },
    recommendation: { create: async (a: any) => ({ id: 'r1', ...a.data }) },
  }
}

let prisma: FakePrisma
let server: TestServer
beforeEach(async () => { prisma = createFakePrisma(spec()); installPrisma(prisma); server = await startTestServer('/api/prospects', prospectsRouter) })
afterEach(async () => { await server.close(); resetPrisma() })

const jsonAuth = { Authorization: bearer(USER), 'Content-Type': 'application/json' }
const auth = { Authorization: bearer(USER) }

test('POST / creates a prospect and returns its tier', async () => {
  const res = await server.request('/api/prospects', { method: 'POST', headers: jsonAuth, body: JSON.stringify({ workspaceId: WS, companyName: 'Acme', industry: 'construction', employeeCount: 50 }) })
  assert.equal(res.status, 201)
  assert.ok(['HOT', 'WARM', 'COLD'].includes(res.body.tier))
  assert.equal(prisma.callsTo('prospect', 'create').length, 1)
})

test('GET /:id returns the prospect with a buying-intent prediction', async () => {
  const res = await server.request('/api/prospects/p1', { headers: auth })
  assert.equal(res.status, 200)
  assert.equal(res.body.companyName, 'Acme')
  assert.ok(res.body.prediction)
})

test('PATCH /:id applies allowed field updates', async () => {
  const res = await server.request('/api/prospects/p1', { method: 'PATCH', headers: jsonAuth, body: JSON.stringify({ industry: 'logistics', notes: 'hot lead' }) })
  assert.equal(res.status, 200)
  assert.equal(prisma.callsTo('prospect', 'update').length, 1)
})

test('POST /:id/outcome requires a stage', async () => {
  const res = await server.request('/api/prospects/p1/outcome', { method: 'POST', headers: jsonAuth, body: JSON.stringify({}) })
  assert.equal(res.status, 400)
})

test('POST /:id/outcome records a non-terminal outcome (no calibration jobs)', async () => {
  const res = await server.request('/api/prospects/p1/outcome', { method: 'POST', headers: jsonAuth, body: JSON.stringify({ stage: 'CONTACTED', notes: 'spoke' }) })
  assert.equal(res.status, 200)
  assert.equal(prisma.callsTo('prospectOutcome', 'create').length, 1)
  assert.equal(prisma.callsTo('prospect', 'update').length, 1)
})

test('POST /:id/recommend creates a rule-based recommendation', async () => {
  const res = await server.request('/api/prospects/p1/recommend', { method: 'POST', headers: jsonAuth, body: '{}' })
  assert.equal(res.status, 201)
  assert.equal(prisma.callsTo('recommendation', 'create').length, 1)
})

test('POST / denies a non-member workspace', async () => {
  const res = await server.request('/api/prospects', { method: 'POST', headers: jsonAuth, body: JSON.stringify({ workspaceId: 'ws-other', companyName: 'X' }) })
  assert.equal(res.status, 403)
})
