// Integration tests for /api/ai — validation, optional-workspace authorization,
// AI-usage accounting, and the OpenAI config guard (no key → 503).

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { aiRouter } from '../apps/api/src/routes/ai.ts'
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
    user: { findUnique: async () => ({ id: USER, email: 'u1@a.test', name: null, emailVerified: true }) },
    membership: { findFirst: async (a: any) => member(a?.where?.userId, a?.where?.workspaceId) },
    workspace: { findUnique: async () => ({ plan: 'free', subscriptionStatus: null }) },
    usageRecord: { findMany: async () => [], upsert: async () => ({ id: 'u' }) },
    workspaceICP: { findUnique: async () => null },
  }
}

let prisma: FakePrisma
let server: TestServer
let ip = 0
beforeEach(async () => {
  delete process.env.OPENAI_API_KEY // force the 503 guard
  prisma = createFakePrisma(spec()); installPrisma(prisma)
  server = await startTestServer('/api/ai', aiRouter)
})
afterEach(async () => { await server.close(); resetPrisma() })

function post(path: string, body: unknown) {
  ip += 1
  return server.request(path, {
    method: 'POST',
    headers: { Authorization: bearer(USER), 'Content-Type': 'application/json', 'X-Forwarded-For': `9.0.0.${ip}` },
    body: JSON.stringify(body),
  })
}

test('research requires businessName', async () => {
  assert.equal((await post('/api/ai/research', {})).status, 400)
})
test('research denies a non-member workspace before doing any work', async () => {
  const res = await post('/api/ai/research', { workspaceId: OTHER, businessName: 'Acme' })
  assert.equal(res.status, 403)
  assert.equal(prisma.callsTo('usageRecord', 'upsert').length, 0)
})
test('research increments AI usage then hits the OpenAI guard (503) for a member', async () => {
  const res = await post('/api/ai/research', { workspaceId: OWNED, businessName: 'Acme' })
  assert.equal(res.status, 503) // no OPENAI_API_KEY
  assert.equal(prisma.callsTo('usageRecord', 'upsert').length, 1) // usage counted
})
test('research without a workspaceId skips usage and still hits the guard', async () => {
  const res = await post('/api/ai/research', { businessName: 'Acme' })
  assert.equal(res.status, 503)
  assert.equal(prisma.callsTo('usageRecord', 'upsert').length, 0)
})
test('outreach requires businessName', async () => {
  assert.equal((await post('/api/ai/outreach', {})).status, 400)
})
test('reply-analysis requires replyBody', async () => {
  assert.equal((await post('/api/ai/reply-analysis', {})).status, 400)
})
test('reply-analysis rejects an over-long body', async () => {
  const res = await post('/api/ai/reply-analysis', { replyBody: 'x'.repeat(10_001) })
  assert.equal(res.status, 400)
})
test('outreach counts usage for a member workspace then hits the guard', async () => {
  const res = await post('/api/ai/outreach', { workspaceId: OWNED, businessName: 'Acme' })
  assert.equal(res.status, 503)
  assert.equal(prisma.callsTo('usageRecord', 'upsert').length, 1)
})
test('reply-analysis with a member workspace counts usage then hits the guard', async () => {
  const res = await post('/api/ai/reply-analysis', { workspaceId: OWNED, replyBody: 'Interested!' })
  assert.equal(res.status, 503)
  assert.equal(prisma.callsTo('usageRecord', 'upsert').length, 1)
})
test('outreach denies a non-member workspace', async () => {
  const res = await post('/api/ai/outreach', { workspaceId: OTHER, businessName: 'Acme' })
  assert.equal(res.status, 403)
})
