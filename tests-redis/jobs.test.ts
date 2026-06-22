// Redis-backed integration tests for /api/jobs.
//
// Drives the real BullMQ enqueue path and the real job-state poll against a live
// Redis (no worker process is running, so jobs stay queued). This covers the
// jobs.ts paths the fake tier can't reach.

import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { jobsRouter } from '../apps/api/src/routes/jobs.ts'
import { requestContext } from '../apps/api/src/middleware/requestContext.ts'
import { getQueue } from '../packages/backend-core/src/lib/queues.ts'
import {
  prisma, resetAll, disconnect, seedUserWithWorkspace, startTestServer, bearer, type TestServer,
} from './helpers/env.ts'

let server: TestServer
let ip = 0

before(async () => {
  server = await startTestServer('/api/jobs', jobsRouter)
})
after(async () => {
  await server.close()
  await disconnect()
})
beforeEach(async () => {
  await resetAll()
  ip += 1
})

function authHeaders(userId: string) {
  return { Authorization: bearer(userId), 'Content-Type': 'application/json', 'X-Forwarded-For': `7.7.0.${ip}` }
}

async function seedLead(workspaceId: string) {
  return prisma.lead.create({ data: { workspaceId, businessName: 'Acme', stage: 'NEW' } })
}

test('POST /research enqueues a real job and increments AI usage', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const lead = await seedLead(workspace.id)

  const res = await server.request('/api/jobs/research', {
    method: 'POST', headers: authHeaders(user.id), body: JSON.stringify({ leadId: lead.id }),
  })
  assert.equal(res.status, 202)
  assert.equal(res.body.queue, 'research-lead')
  assert.ok(res.body.jobId, 'a real BullMQ job id is returned')

  // Usage recorded in the database.
  const month = new Date().toISOString().slice(0, 7)
  const usage = await prisma.usageRecord.findFirst({
    where: { workspaceId: workspace.id, month, action: 'AI_RESEARCH' },
  })
  assert.equal(usage?.count, 1)

  // The job is really in Redis and pollable; with no worker it stays queued.
  const poll = await server.request(`/api/jobs/research-lead/${res.body.jobId}`, {
    headers: { Authorization: bearer(user.id) },
  })
  assert.equal(poll.status, 200)
  assert.ok(['waiting', 'delayed', 'active', 'prioritized'].includes(poll.body.state), `unexpected state ${poll.body.state}`)
})

test('POST /research returns 404 for an unknown lead and enqueues nothing', async () => {
  const { user } = await seedUserWithWorkspace()
  const res = await server.request('/api/jobs/research', {
    method: 'POST', headers: authHeaders(user.id), body: JSON.stringify({ leadId: 'nope' }),
  })
  assert.equal(res.status, 404)
})

test('POST /research denies a lead in another workspace (no enqueue, no usage)', async () => {
  const a = await seedUserWithWorkspace('a@acme.test')
  const b = await seedUserWithWorkspace('b@acme.test')
  const otherLead = await seedLead(b.workspace.id)

  const res = await server.request('/api/jobs/research', {
    method: 'POST', headers: authHeaders(a.user.id), body: JSON.stringify({ leadId: otherLead.id }),
  })
  assert.equal(res.status, 403)
  const usage = await prisma.usageRecord.count({ where: { workspaceId: a.workspace.id } })
  assert.equal(usage, 0)
})

test('poll returns 404 for an unknown job id', async () => {
  const { user } = await seedUserWithWorkspace()
  const res = await server.request('/api/jobs/research-lead/does-not-exist', {
    headers: { Authorization: bearer(user.id) },
  })
  assert.equal(res.status, 404)
})

test('poll rejects an unknown queue name', async () => {
  const { user } = await seedUserWithWorkspace()
  const res = await server.request('/api/jobs/not-a-queue/123', {
    headers: { Authorization: bearer(user.id) },
  })
  assert.equal(res.status, 400)
})

test('POST /research threads the API X-Request-Id into the job payload', async () => {
  // Mount requestContext so the inbound X-Request-Id becomes req.id, the same way
  // the production app does — then assert it survives into the real queued payload.
  const ctxServer = await startTestServer('/api/jobs', jobsRouter, {
    configure: (app) => app.use(requestContext),
  })
  try {
    const { user, workspace } = await seedUserWithWorkspace()
    const lead = await seedLead(workspace.id)
    const reqId = 'req-threading-test-abc123'
    const res = await ctxServer.request('/api/jobs/research', {
      method: 'POST',
      headers: { ...authHeaders(user.id), 'X-Request-Id': reqId },
      body: JSON.stringify({ leadId: lead.id }),
    })
    assert.equal(res.status, 202)
    assert.equal(res.headers.get('x-request-id'), reqId)

    // The correlation id is on the real BullMQ job, ready for the worker to log.
    const job = await getQueue('research-lead').getJob(res.body.jobId)
    assert.equal(job?.data.requestId, reqId)
  } finally {
    await ctxServer.close()
  }
})

test('POST /outreach enqueues to the generate-outreach queue', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const lead = await seedLead(workspace.id)
  const res = await server.request('/api/jobs/outreach', {
    method: 'POST', headers: authHeaders(user.id), body: JSON.stringify({ leadId: lead.id }),
  })
  assert.equal(res.status, 202)
  assert.equal(res.body.queue, 'generate-outreach')
})
