// Integration tests for POST /api/prospects/enrich-batch: input validation,
// workspace authorization, the empty-target short-circuit, and discovery-quota
// enforcement. The happy-path enqueue (202 with a jobId) touches Redis and is
// left to the DB/integration suite, matching the convention noted in
// routes-prospects.test.ts.

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { prospectsRouter } from '../apps/api/src/routes/prospects.ts'
import {
  createFakePrisma, installPrisma, resetPrisma, startTestServer, bearer,
  type FakePrisma, type TestServer,
} from './helpers/integration.ts'

const MEMBER = 'u1'
const OWNED_WS = 'ws1'
const OTHER_WS = 'ws2'

const verifiedUser = { findUnique: async () => ({ id: MEMBER, email: 'u1@acme.test', name: null, emailVerified: true }) }

function membershipFor(userId: string, workspaceId: string) {
  return userId === MEMBER && workspaceId === OWNED_WS ? { id: 'm1', role: 'admin' } : null
}

// `unenriched` controls what the target query returns; `quotaUsed` drives the
// discovery-limit check (free plan = 25/month).
function spec(opts: { unenriched?: Array<{ id: string }>; quotaUsed?: number } = {}) {
  return {
    user: verifiedUser,
    membership: { findFirst: async (a: any) => membershipFor(a?.where?.userId, a?.where?.workspaceId) },
    prospect: { findMany: async () => opts.unenriched ?? [] },
    workspace: { findUnique: async () => ({ plan: 'free', subscriptionStatus: 'active' }) },
    usageRecord: {
      findUnique: async () => ({ count: opts.quotaUsed ?? 0 }),
      upsert: async () => ({}),
    },
    auditEvent: { create: async () => ({ id: 'a1' }) },
  }
}

let prisma: FakePrisma
let server: TestServer

async function mount(s: ReturnType<typeof spec>) {
  prisma = createFakePrisma(s)
  installPrisma(prisma)
}

beforeEach(async () => {
  server = await startTestServer('/api/prospects', prospectsRouter)
})

afterEach(async () => {
  await server.close()
  resetPrisma()
})

const jsonHeaders = { Authorization: bearer(MEMBER), 'Content-Type': 'application/json' }

test('400 when workspaceId is missing', async () => {
  await mount(spec())
  const res = await server.request('/api/prospects/enrich-batch', {
    method: 'POST', headers: jsonHeaders, body: JSON.stringify({}),
  })
  assert.equal(res.status, 400)
})

test('403 for a workspace the user does not administer (no work done)', async () => {
  await mount(spec({ unenriched: [{ id: 'p1' }] }))
  const res = await server.request('/api/prospects/enrich-batch', {
    method: 'POST', headers: jsonHeaders, body: JSON.stringify({ workspaceId: OTHER_WS }),
  })
  assert.equal(res.status, 403)
  assert.equal(prisma.callsTo('prospect', 'findMany').length, 0)
})

test('202 with queued:0 when nothing needs enriching (no quota spent)', async () => {
  await mount(spec({ unenriched: [] }))
  const res = await server.request('/api/prospects/enrich-batch', {
    method: 'POST', headers: jsonHeaders, body: JSON.stringify({ workspaceId: OWNED_WS }),
  })
  assert.equal(res.status, 202)
  assert.equal(res.body.queued, 0)
  assert.equal(res.body.jobId, null)
  // Empty batch must not consume the discovery quota.
  assert.equal(prisma.callsTo('usageRecord', 'upsert').length, 0)
})

test('429 when the monthly discovery quota is exhausted', async () => {
  await mount(spec({ unenriched: [{ id: 'p1' }], quotaUsed: 25 }))
  const res = await server.request('/api/prospects/enrich-batch', {
    method: 'POST', headers: jsonHeaders, body: JSON.stringify({ workspaceId: OWNED_WS }),
  })
  assert.equal(res.status, 429)
})
