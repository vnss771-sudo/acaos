// Integration tests for /api/stats — dashboard funnel and campaign stats,
// both workspace-scoped.

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { statsRouter } from '../apps/api/src/routes/stats.ts'
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
    lead: {
      groupBy: async (a: any) => a?.by?.[0] === 'stage'
        ? [{ stage: 'OUTREACH_SENT', _count: { _all: 4 } }, { stage: 'REPLIED', _count: { _all: 2 } }, { stage: 'BOOKED', _count: { _all: 1 } }]
        : [{ score: 80, _count: { _all: 2 } }, { score: 30, _count: { _all: 1 } }],
      count: async () => 7,
      findMany: async () => [{ id: 'l1', businessName: 'Acme', stage: 'NEW', score: 80, category: 'x' }],
    },
    campaign: {
      count: async () => 1,
      findMany: async () => [{
        id: 'c1', name: 'C', goalType: 'BOOK_CALL', createdAt: new Date(),
        _count: { leads: 5 },
        leads: [{ stage: 'REPLIED', score: 70 }, { stage: 'OUTREACH_SENT', score: 40 }],
      }],
    },
    scoringModel: { findUnique: async () => ({ weights: {}, performanceMetrics: {}, updateCount: 3, lastWeightUpdate: new Date() }) },
    usageRecord: { findMany: async () => [{ action: 'AI_RESEARCH', count: 2 }] },
    workspace: { findUnique: async () => ({ plan: 'free', subscriptionStatus: null }) },
  }
}

let prisma: FakePrisma
let server: TestServer
beforeEach(async () => { prisma = createFakePrisma(spec()); installPrisma(prisma); server = await startTestServer('/api/stats', statsRouter) })
afterEach(async () => { await server.close(); resetPrisma() })
const auth = (u = USER) => ({ Authorization: bearer(u) })

test('GET / requires workspaceId', async () => {
  assert.equal((await server.request('/api/stats', { headers: auth() })).status, 400)
})
test('GET / denies a non-member workspace', async () => {
  assert.equal((await server.request(`/api/stats?workspaceId=${OTHER}`, { headers: auth() })).status, 403)
})
test('GET / returns a funnel with computed conversion metrics', async () => {
  const res = await server.request(`/api/stats?workspaceId=${OWNED}`, { headers: auth() })
  assert.equal(res.status, 200)
  // contacted = OUTREACH_SENT+REPLIED+BOOKED = 7; replied = REPLIED+BOOKED = 3
  assert.equal(res.body.metrics.contacted, 7)
  assert.equal(res.body.metrics.replied, 3)
  assert.equal(res.body.scoreDistribution.HOT, 2) // score 80 → HOT
})
test('GET /campaigns denies a non-member workspace', async () => {
  assert.equal((await server.request(`/api/stats/campaigns?workspaceId=${OTHER}`, { headers: auth() })).status, 403)
})
test('GET /campaigns aggregates per-campaign stats', async () => {
  const res = await server.request(`/api/stats/campaigns?workspaceId=${OWNED}`, { headers: auth() })
  assert.equal(res.status, 200)
  assert.equal(res.body.campaigns[0].totalLeads, 5)
  assert.equal(res.body.campaigns[0].activeLeads, 1) // one REPLIED
})
