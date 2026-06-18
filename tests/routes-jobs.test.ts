// Integration tests for /api/jobs — validation, lead authorization, unknown
// queues, and SSE query-token auth. The enqueue happy-path needs Redis + a
// worker (integration territory); these cover every pre-queue branch.

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { jobsRouter } from '../apps/api/src/routes/jobs.ts'
import {
  createFakePrisma, installPrisma, resetPrisma, startTestServer, bearer,
  type TestServer,
} from './helpers/integration.ts'

const USER = 'u1'
const OWNED = 'ws1'
const OTHER = 'ws2'
const member = (uid: string, wid: string) => (uid === USER && wid === OWNED ? { id: 'm1', role: 'admin' } : null)

function spec() {
  return {
    user: { findUnique: async () => ({ id: USER, email: 'u1@a.test', name: null }) },
    membership: { findFirst: async (a: any) => member(a?.where?.userId, a?.where?.workspaceId) },
    lead: {
      findUnique: async (a: any) => {
        if (a?.where?.id === 'l-own') return { id: 'l-own', workspaceId: OWNED }
        if (a?.where?.id === 'l-other') return { id: 'l-other', workspaceId: OTHER }
        return null
      },
    },
  }
}

let server: TestServer
let ip = 0
beforeEach(async () => { installPrisma(createFakePrisma(spec())); server = await startTestServer('/api/jobs', jobsRouter) })
afterEach(async () => { await server.close(); resetPrisma() })

function post(path: string, body: unknown) {
  ip += 1
  return server.request(path, {
    method: 'POST',
    headers: { Authorization: bearer(USER), 'Content-Type': 'application/json', 'X-Forwarded-For': `8.0.0.${ip}` },
    body: JSON.stringify(body),
  })
}
const get = (path: string) => server.request(path, { headers: { Authorization: bearer(USER) } })

test('research requires a leadId', async () => {
  assert.equal((await post('/api/jobs/research', {})).status, 400)
})
test('research returns 404 for an unknown lead', async () => {
  assert.equal((await post('/api/jobs/research', { leadId: 'missing' })).status, 404)
})
test('research denies a lead in another workspace', async () => {
  assert.equal((await post('/api/jobs/research', { leadId: 'l-other' })).status, 403)
})
test('outreach requires a leadId', async () => {
  assert.equal((await post('/api/jobs/outreach', {})).status, 400)
})
test('analyze-reply requires a replyBody', async () => {
  assert.equal((await post('/api/jobs/analyze-reply', {})).status, 400)
})
test('analyze-reply rejects an over-long body', async () => {
  assert.equal((await post('/api/jobs/analyze-reply', { replyBody: 'x'.repeat(10_001) })).status, 400)
})
test('analyze-reply denies a referenced lead in another workspace', async () => {
  assert.equal((await post('/api/jobs/analyze-reply', { replyBody: 'hi', leadId: 'l-other' })).status, 403)
})
test('analyze-reply requires a leadId or workspaceId (closes the unmetered AI path)', async () => {
  // Previously an omitted leadId skipped metering while the worker still ran the
  // AI call. Now a billable scope is mandatory.
  assert.equal((await post('/api/jobs/analyze-reply', { replyBody: 'a real reply body' })).status, 400)
})
test('analyze-reply denies a workspaceId the user is not a member of', async () => {
  assert.equal((await post('/api/jobs/analyze-reply', { replyBody: 'hi', workspaceId: OTHER })).status, 403)
})
test('research-bulk requires a workspaceId', async () => {
  assert.equal((await post('/api/jobs/research-bulk', {})).status, 400)
})
test('research-bulk denies a non-member workspace', async () => {
  assert.equal((await post('/api/jobs/research-bulk', { workspaceId: OTHER })).status, 403)
})
test('poll rejects an unknown queue name', async () => {
  assert.equal((await get('/api/jobs/not-a-queue/job123')).status, 400)
})
test('SSE rejects an unknown queue name', async () => {
  assert.equal((await get('/api/jobs/events/not-a-queue/job123?token=x')).status, 400)
})
test('SSE requires a ticket', async () => {
  // No ticket query param → rejected before any Redis lookup.
  assert.equal((await get('/api/jobs/events/research-lead/job123')).status, 401)
})
test('issuing an SSE ticket requires authentication', async () => {
  const res = await server.request('/api/jobs/events/ticket', { method: 'POST' })
  assert.equal(res.status, 401)
})
// (valid-ticket single-use, invalid-ticket, and cross-user cases need real
//  Redis and are covered in tests-redis/sse.test.ts)
