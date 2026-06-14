// Integration tests for the /api/outcomes router.
//
// Covers the dual authentication model (ingest API key OR JWT), workspace
// authorization on the JWT path, and the owner-only model reset — including a
// regression test for a role-casing bug that previously made reset impossible
// for legitimate owners.

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { outcomesRouter } from '../apps/api/src/routes/outcomes.ts'
import { hashApiKey } from '../apps/api/src/lib/apiKeys.ts'
import {
  createFakePrisma,
  installPrisma,
  resetPrisma,
  startTestServer,
  bearer,
  type FakePrisma,
  type TestServer,
} from './helpers/integration.ts'

const OWNER = 'owner-1'
const NON_OWNER = 'member-1'
const STRANGER = 'stranger-1'
const WS = 'ws1'
const API_KEY = 'ingest-key-abc'

// membership world: OWNER is owner of WS, NON_OWNER is a plain member, STRANGER
// belongs to nothing.
function membershipFor(args: any) {
  const { userId, workspaceId, role } = args?.where ?? {}
  if (workspaceId !== WS) return null
  if (userId === OWNER) {
    // role-filtered queries (reset requires role: 'owner')
    if (role && role !== 'owner') return null
    return { id: 'm-owner', role: 'owner' }
  }
  if (userId === NON_OWNER) {
    if (role && role !== 'member') return null
    return { id: 'm-member', role: 'member' }
  }
  return null
}

function baseSpec(extra: Record<string, any> = {}) {
  return {
    user: {
      findUnique: async (args: any) => ({
        id: args?.where?.id,
        email: `${args?.where?.id}@acme.test`,
        name: null,
      }),
    },
    membership: { findFirst: async (args: any) => membershipFor(args) },
    workspace: {
      findUnique: async (args: any) =>
        args?.where?.ingestApiKey === hashApiKey(API_KEY) ? { id: WS } : null,
    },
    // The referenced prospect/lead must belong to the resolved workspace.
    prospect: {
      findFirst: async (args: any) =>
        args?.where?.id === 'p1' && args?.where?.workspaceId === WS ? { id: 'p1' } : null,
    },
    lead: {
      findFirst: async (args: any) =>
        args?.where?.id === 'l1' && args?.where?.workspaceId === WS ? { id: 'l1' } : null,
    },
    scoringModel: {
      upsert: async () => ({ id: 'model-1', weights: {}, performanceMetrics: {} }),
      update: async () => ({ id: 'model-1' }),
    },
    scoringOutcome: {
      create: async () => ({ id: 'oc-1' }),
      count: async () => 1,
      findMany: async () => [],
      deleteMany: async () => ({ count: 3 }),
    },
    ...extra,
  }
}

let prisma: FakePrisma
let server: TestServer

async function boot(spec = baseSpec()) {
  // Close any server from a prior boot() (some tests re-boot with a custom spec)
  // so we never leak an open listener — a leaked TCPServerWrap keeps the event
  // loop alive and forces the runner to rely on --test-force-exit.
  if (server) await server.close()
  prisma = createFakePrisma(spec)
  installPrisma(prisma)
  server = await startTestServer('/api/outcomes', outcomesRouter)
}

beforeEach(async () => {
  await boot()
})

afterEach(async () => {
  await server.close()
  resetPrisma()
})

const json = (auth: string | null, body: unknown) => ({
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    ...(auth ? { Authorization: auth } : {}),
  },
  body: JSON.stringify(body),
})

// --- POST /api/outcomes (record an outcome) ---

test('POST records an outcome via a valid ingest API key', async () => {
  const res = await server.request('/api/outcomes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({ prospectId: 'p1', score: 80, replied: true }),
  })
  assert.equal(res.status, 201)
  assert.equal(prisma.callsTo('scoringOutcome', 'create').length, 1)
})

test('POST rejects an invalid ingest API key', async () => {
  const res = await server.request('/api/outcomes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': 'wrong-key' },
    body: JSON.stringify({ prospectId: 'p1', score: 80, replied: true }),
  })
  assert.equal(res.status, 401)
  assert.equal(prisma.callsTo('scoringOutcome', 'create').length, 0)
})

test('POST via JWT denies a non-member workspace', async () => {
  const res = await server.request(
    '/api/outcomes',
    json(bearer(STRANGER), { workspaceId: WS, prospectId: 'p1', score: 80, replied: true })
  )
  assert.equal(res.status, 403)
  assert.equal(prisma.callsTo('scoringOutcome', 'create').length, 0)
})

test('POST rejects a prospectId that does not belong to the workspace (no data poisoning)', async () => {
  const res = await server.request('/api/outcomes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({ prospectId: 'p-foreign', score: 80, replied: true }),
  })
  assert.equal(res.status, 400)
  assert.equal(prisma.callsTo('scoringOutcome', 'create').length, 0)
})

test('POST rejects a leadId that does not belong to the workspace', async () => {
  const res = await server.request('/api/outcomes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({ prospectId: 'p1', leadId: 'l-foreign', score: 80, replied: true }),
  })
  assert.equal(res.status, 400)
  assert.equal(prisma.callsTo('scoringOutcome', 'create').length, 0)
})

test('POST validates the score range', async () => {
  const res = await server.request('/api/outcomes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({ prospectId: 'p1', score: 999, replied: true }),
  })
  assert.equal(res.status, 400)
})

test('POST recomputes weights on every 7th outcome', async () => {
  await boot(baseSpec({
    scoringOutcome: {
      create: async () => ({ id: 'oc-7' }),
      count: async () => 7,
      findMany: async () => [
        { score: 80, replied: true, messageRelevance: 0.6, channelUsed: 'EMAIL' },
        { score: 30, replied: false, messageRelevance: 0.4, channelUsed: 'EMAIL' },
      ],
      deleteMany: async () => ({ count: 0 }),
    },
  }))
  const res = await server.request('/api/outcomes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({ prospectId: 'p1', score: 80, replied: true }),
  })
  assert.equal(res.status, 201)
  assert.equal(res.body.weightsUpdated, true)
  assert.equal(prisma.callsTo('scoringModel', 'update').length, 1)
})

// --- POST /api/outcomes/model/reset (owner only) ---

test('reset is denied for a non-owner member', async () => {
  const res = await server.request(
    '/api/outcomes/model/reset',
    json(bearer(NON_OWNER), { workspaceId: WS })
  )
  assert.equal(res.status, 403)
  assert.equal(prisma.callsTo('scoringOutcome', 'deleteMany').length, 0)
})

test('reset succeeds for the workspace owner (role-casing regression)', async () => {
  const res = await server.request(
    '/api/outcomes/model/reset',
    json(bearer(OWNER), { workspaceId: WS })
  )
  assert.equal(res.status, 200)
  assert.equal(res.body.reset, true)
  // The model is reset and prior outcomes wiped.
  assert.equal(prisma.callsTo('scoringModel', 'upsert').length, 1)
  assert.equal(prisma.callsTo('scoringOutcome', 'deleteMany').length, 1)
})
