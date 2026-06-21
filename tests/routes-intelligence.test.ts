// Integration tests for the /api/intelligence router.
//
// These endpoints expose a workspace's entire sales pipeline, revenue
// forecast, and prospect statistics, all scoped by a client-supplied
// workspaceId. Every endpoint must reject callers who are not members of the
// requested workspace.

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { intelligenceRouter } from '../apps/api/src/routes/intelligence.ts'
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

function baseSpec() {
  return {
    user: {
      findUnique: async () => ({ id: MEMBER, email: 'u1@acme.test', name: null, emailVerified: true }),
    },
    membership: {
      findFirst: async (args: any) =>
        membershipFor(args?.where?.userId, args?.where?.workspaceId),
    },
    prospect: {
      findMany: async () => [
        {
          id: 'p1',
          companyName: 'Acme',
          industry: 'construction',
          location: 'NYC',
          opportunityScore: 80,
          intentScore: 70,
          fitScore: 75,
          timingScore: 60,
          confidenceScore: 65,
          buyingStage: 'PURCHASING',
          outcomeStage: 'CONTACTED',
          contactName: 'C',
          contactEmail: 'c@acme.test',
          contactTitle: 'Ops',
          expectedDealValue: null,
          winProbability: 0.4,
          lastSignalAt: new Date(),
          signals: [],
          recommendations: [],
        },
      ],
      count: async () => 1,
      groupBy: async (args: any) =>
        args?.by?.[0] === 'buyingStage'
          ? [{ buyingStage: 'PURCHASING', _count: 1 }]
          : [{ opportunityScore: 80, _count: 1 }],
    },
    signal: {
      groupBy: async () => [{ type: 'FUNDING', _count: 2 }],
    },
    prospectOutcome: {
      findMany: async () => [{ dealValue: 12000, recordedAt: new Date() }],
      aggregate: async () => ({ _sum: { dealValue: 12000 }, _count: 1 }),
    },
  }
}

let prisma: FakePrisma
let server: TestServer

beforeEach(async () => {
  prisma = createFakePrisma(baseSpec())
  installPrisma(prisma)
  server = await startTestServer('/api/intelligence', intelligenceRouter)
})

afterEach(async () => {
  await server.close()
  resetPrisma()
})

const ENDPOINTS = ['/opportunities', '/forecast', '/stats']

for (const ep of ENDPOINTS) {
  test(`GET ${ep} requires authentication`, async () => {
    const res = await server.request(`/api/intelligence${ep}?workspaceId=${OWNED_WS}`)
    assert.equal(res.status, 401)
  })

  test(`GET ${ep} requires a workspaceId`, async () => {
    const res = await server.request(`/api/intelligence${ep}`, {
      headers: { Authorization: bearer(MEMBER) },
    })
    assert.equal(res.status, 400)
  })

  test(`GET ${ep} denies a workspace the user does NOT belong to`, async () => {
    const res = await server.request(`/api/intelligence${ep}?workspaceId=${OTHER_WS}`, {
      headers: { Authorization: bearer(MEMBER) },
    })
    assert.equal(res.status, 403)
    // No prospect data for another workspace should ever be queried.
    assert.equal(prisma.callsTo('prospect', 'findMany').length, 0)
    assert.equal(prisma.callsTo('prospect', 'count').length, 0)
  })

  test(`GET ${ep} succeeds for a member`, async () => {
    const res = await server.request(`/api/intelligence${ep}?workspaceId=${OWNED_WS}`, {
      headers: { Authorization: bearer(MEMBER) },
    })
    assert.equal(res.status, 200)
  })
}
