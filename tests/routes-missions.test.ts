// Integration tests for the /api/missions router — the mission control plane.
//
// Covers workspace authorization, playbook persistence on create, and the
// enriched GET /:id (playbook + discovery history + owned prospects + the
// mission-scoped action queue).

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { missionsRouter } from '../apps/api/src/routes/missions.ts'
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
  return userId === MEMBER && workspaceId === OWNED_WS ? { id: 'm1', role: 'admin' } : null
}

function missionRow(workspaceId: string, id = 'm1', playbookId: string | null = null) {
  return {
    id,
    workspaceId,
    name: 'Mission One',
    goalType: 'BOOK_CALL',
    targetCustomer: null,
    offer: null,
    playbookId,
    status: 'ACTIVE',
    campaignId: 'c1',
    createdAt: new Date(),
    updatedAt: new Date(),
    campaign: { id: 'c1', name: 'Mission One', _count: { leads: 0 } },
  }
}

function spec(overrides: Record<string, unknown> = {}) {
  return {
    user: { findUnique: async () => ({ id: MEMBER, email: 'u1@acme.test', name: null, emailVerified: true }) },
    membership: { findFirst: async (args: any) => membershipFor(args?.where?.userId, args?.where?.workspaceId) },
    mission: {
      findUnique: async (args: any) => {
        if (args?.where?.id === 'm1') return missionRow(OWNED_WS, 'm1')
        if (args?.where?.id === 'm-fieldops') return missionRow(OWNED_WS, 'm-fieldops', 'fieldops')
        if (args?.where?.id === 'm-other') return missionRow(OTHER_WS, 'm-other')
        return null
      },
      findMany: async () => [missionRow(OWNED_WS)],
      create: async (a: any) => ({ ...missionRow(OWNED_WS), ...a.data, campaign: { id: 'c1', name: a.data.name, _count: { leads: 0 } } }),
      update: async (a: any) => ({ ...missionRow(OWNED_WS), ...a.data }),
    },
    campaign: { create: async (a: any) => ({ id: 'c1', ...a.data }) },
    discoveryRun: { findMany: async () => [], groupBy: async () => [] },
    prospect: { findMany: async () => [], count: async () => 0 },
    outreachIntent: { findMany: async () => [], groupBy: async () => [] },
    outreachSent: { groupBy: async () => [], findMany: async () => [] },
    outreachDraft: { findMany: async () => [] },
    scoringModel: { findUnique: async () => null },
    scoringOutcome: { count: async () => 0 },
    workspaceEmailConfig: { findUnique: async () => null },
    workspace: { findUnique: async () => ({ senderBusinessName: 'Acme LLC', senderPostalAddress: '123 St' }) },
    auditEvent: { create: async () => ({ id: 'a1' }) },
    ...overrides,
  }
}

let prisma: FakePrisma
let server: TestServer

beforeEach(async () => {
  prisma = createFakePrisma(spec())
  installPrisma(prisma)
  server = await startTestServer('/api/missions', missionsRouter)
})

afterEach(async () => {
  await server.close()
  resetPrisma()
})

const auth = (u: string) => ({ Authorization: bearer(u) })
const jsonHeaders = { Authorization: bearer(MEMBER), 'Content-Type': 'application/json' }

// --- GET / (list) ---

test('GET / denies a workspace the user does not belong to', async () => {
  const res = await server.request(`/api/missions?workspaceId=${OTHER_WS}`, { headers: auth(MEMBER) })
  assert.equal(res.status, 403)
})

test('GET / returns missions with stats + discovery shape for a member', async () => {
  const res = await server.request(`/api/missions?workspaceId=${OWNED_WS}`, { headers: auth(MEMBER) })
  assert.equal(res.status, 200)
  assert.equal(res.body.missions.length, 1)
  assert.deepEqual(res.body.missions[0].discovery, { runs: 0, discovered: 0 })
  assert.ok(res.body.missions[0].stats)
})

// --- GET /:id (control plane) ---

test('GET /:id returns the enriched control plane for a member', async () => {
  prisma = createFakePrisma(spec({
    prospect: {
      findMany: async () => [{ id: 'p1', companyName: 'Acme', industry: 'construction', opportunityScore: 80, buyingStage: 'PURCHASING' }],
      count: async () => 3,
    },
    outreachIntent: {
      findMany: async () => [
        { id: 'i1', status: 'PROPOSED', prospect: { id: 'pa', companyName: 'Low', opportunityScore: 40 } },
        { id: 'i2', status: 'APPROVED', prospect: { id: 'pb', companyName: 'High', opportunityScore: 95 } },
      ],
      groupBy: async () => [{ status: 'PROPOSED', _count: 1 }, { status: 'APPROVED', _count: 1 }],
    },
    discoveryRun: { findMany: async () => [{ id: 'r1', source: 'apollo', status: 'SUCCEEDED', resultCount: 5, importedCount: 3, skippedCount: 2 }] },
  }))
  installPrisma(prisma)
  const res = await server.request('/api/missions/m1', { headers: auth(MEMBER) })
  assert.equal(res.status, 200)
  assert.equal(res.body.playbook, null) // m1 has no playbook
  assert.equal(res.body.prospects.length, 1)
  assert.equal(res.body.discoveryRuns.length, 1)
  // Action queue is sorted strongest-opportunity first.
  assert.equal(res.body.intents[0].prospect.companyName, 'High')
  // Funnel is derived from prospect count + intent status groupBy.
  assert.equal(res.body.funnel.discovered, 3)
  assert.equal(res.body.funnel.recommended, 2) // PROPOSED + APPROVED
  assert.equal(res.body.funnel.approved, 1)
  // Send readiness is surfaced for the operator.
  assert.ok(Array.isArray(res.body.sendReadiness.checks))
  assert.equal(typeof res.body.sendReadiness.ready, 'boolean')
})

test('GET /:id reports engagement and learning for the loop tail', async () => {
  prisma = createFakePrisma(spec({
    outreachSent: {
      // SENT + REPLIED + BOUNCED all count as "delivered"; FAILED/SENDING do not.
      groupBy: async () => [
        { status: 'SENT', _count: 6 }, { status: 'REPLIED', _count: 2 },
        { status: 'BOUNCED', _count: 1 }, { status: 'FAILED', _count: 3 },
      ],
      findMany: async () => [
        { id: 's1', toEmail: 'cfo@high.co', subject: 'Hi', status: 'REPLIED', replyIntent: 'INTERESTED', sentAt: new Date(), repliedAt: new Date() },
      ],
    },
    scoringModel: { findUnique: async () => ({ updateCount: 3, lastWeightUpdate: new Date() }) },
    scoringOutcome: { count: async () => 21 },
  }))
  installPrisma(prisma)
  const res = await server.request('/api/missions/m1', { headers: auth(MEMBER) })
  assert.equal(res.status, 200)
  // delivered = 6 + 2 + 1 = 9; replied = 2; failed excluded from "sent"
  assert.equal(res.body.engagement.sent, 9)
  assert.equal(res.body.engagement.replied, 2)
  assert.equal(res.body.engagement.bounced, 1)
  assert.equal(res.body.engagement.failed, 3)
  assert.ok(Math.abs(res.body.engagement.replyRate - 2 / 9) < 1e-9)
  assert.equal(res.body.recentSends.length, 1)
  assert.equal(res.body.recentSends[0].replyIntent, 'INTERESTED')
  // Learning reflects the workspace scoring model + outcome count.
  assert.equal(res.body.learning.updateCount, 3)
  assert.equal(res.body.learning.totalOutcomes, 21)
})

test('GET /:id resolves the playbook when the mission has one', async () => {
  const res = await server.request('/api/missions/m-fieldops', { headers: auth(MEMBER) })
  assert.equal(res.status, 200)
  assert.equal(res.body.playbook.id, 'fieldops')
  assert.ok(res.body.playbook.label)
})

test('GET /:id denies access to another workspace\'s mission', async () => {
  const res = await server.request('/api/missions/m-other', { headers: auth(MEMBER) })
  assert.equal(res.status, 403)
})

test('GET /:id returns 404 for an unknown mission', async () => {
  const res = await server.request('/api/missions/missing', { headers: auth(MEMBER) })
  assert.equal(res.status, 404)
})

// --- POST / (create) ---

test('POST / persists the selected playbook on the mission', async () => {
  const res = await server.request('/api/missions', {
    method: 'POST', headers: jsonHeaders,
    body: JSON.stringify({ workspaceId: OWNED_WS, name: 'Q3 Brisbane', goalType: 'BOOK_CALL', playbookId: 'fieldops' }),
  })
  assert.equal(res.status, 201)
  const createArg = prisma.callsTo('mission', 'create')[0].args[0] as any
  assert.equal(createArg.data.playbookId, 'fieldops')
  assert.ok(res.body.mission)
  assert.ok(res.body.campaign)
})

test('POST / denies a workspace the user does not belong to', async () => {
  const res = await server.request('/api/missions', {
    method: 'POST', headers: jsonHeaders,
    body: JSON.stringify({ workspaceId: OTHER_WS, name: 'X', goalType: 'BOOK_CALL' }),
  })
  assert.equal(res.status, 403)
  assert.equal(prisma.callsTo('mission', 'create').length, 0)
})

test('POST / requires a name (400)', async () => {
  const res = await server.request('/api/missions', {
    method: 'POST', headers: jsonHeaders,
    body: JSON.stringify({ workspaceId: OWNED_WS }),
  })
  assert.equal(res.status, 400)
})

// --- PATCH /:id ---

test('PATCH /:id updates status for a member', async () => {
  const res = await server.request('/api/missions/m1', {
    method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ status: 'PAUSED' }),
  })
  assert.equal(res.status, 200)
  assert.equal(prisma.callsTo('mission', 'update').length, 1)
})

test('PATCH /:id denies another workspace and does not update', async () => {
  const res = await server.request('/api/missions/m-other', {
    method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ status: 'PAUSED' }),
  })
  assert.equal(res.status, 403)
  assert.equal(prisma.callsTo('mission', 'update').length, 0)
})

// --- POST /:id/score ---
// The 202 happy path enqueues to Redis (integration territory, like the jobs
// routes), so only the pre-enqueue authz guards are covered here.
test('POST /:id/score returns 404 for an unknown mission', async () => {
  const res = await server.request('/api/missions/missing/score', { method: 'POST', headers: jsonHeaders })
  assert.equal(res.status, 404)
})

test('POST /:id/score denies a non-admin of the mission workspace (no audit)', async () => {
  const res = await server.request('/api/missions/m-other/score', { method: 'POST', headers: jsonHeaders })
  assert.equal(res.status, 403)
  assert.equal(prisma.callsTo('auditEvent', 'create').length, 0)
})
