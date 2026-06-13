// Redis-backed tests for the SSE one-time ticket auth (SEC-6): the EventSource
// stream is authenticated with a short-lived, single-use ticket instead of a
// JWT in the URL.

import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { jobsRouter } from '../apps/api/src/routes/jobs.ts'
import { enqueueResearchLead } from '../apps/api/src/lib/queues.ts'
import {
  resetAll, disconnect, seedUserWithWorkspace, startTestServer, bearer, type TestServer,
} from './helpers/env.ts'

let server: TestServer
before(async () => { server = await startTestServer('/api/jobs', jobsRouter) })
after(async () => { await server.close(); await disconnect() })
beforeEach(async () => { await resetAll() })

async function issueTicket(userId: string): Promise<string> {
  const res = await server.request('/api/jobs/events/ticket', {
    method: 'POST', headers: { Authorization: bearer(userId) },
  })
  assert.equal(res.status, 200)
  return res.body.ticket
}

// Open the SSE stream and return the HTTP status, then abort so the poller stops.
async function openStream(path: string): Promise<number> {
  const ctrl = new AbortController()
  try {
    const res = await fetch(`${server.baseUrl}${path}`, { signal: ctrl.signal })
    return res.status
  } finally {
    ctrl.abort()
  }
}

test('issuing a ticket requires authentication', async () => {
  const res = await server.request('/api/jobs/events/ticket', { method: 'POST' })
  assert.equal(res.status, 401)
})

test('a valid ticket opens the stream, and is single-use', async () => {
  const { user } = await seedUserWithWorkspace()
  const job = await enqueueResearchLead('lead-1', user.id)
  const ticket = await issueTicket(user.id)

  // First use: stream opens (200, text/event-stream).
  const first = await openStream(`/api/jobs/events/research-lead/${job.id}?ticket=${ticket}`)
  assert.equal(first, 200)

  // Second use of the same ticket: rejected (already consumed).
  const second = await openStream(`/api/jobs/events/research-lead/${job.id}?ticket=${ticket}`)
  assert.equal(second, 401)
})

test('the stream rejects a missing or invalid ticket', async () => {
  const { user } = await seedUserWithWorkspace()
  const job = await enqueueResearchLead('lead-1', user.id)

  assert.equal(await openStream(`/api/jobs/events/research-lead/${job.id}`), 401)
  assert.equal(await openStream(`/api/jobs/events/research-lead/${job.id}?ticket=bogus`), 401)
})

test('the stream rejects an unknown queue (before consuming anything)', async () => {
  const { user } = await seedUserWithWorkspace()
  const ticket = await issueTicket(user.id)
  assert.equal(await openStream(`/api/jobs/events/not-a-queue/x?ticket=${ticket}`), 400)
})

test('a ticket cannot stream another user\'s job', async () => {
  const a = await seedUserWithWorkspace('a@acme.test')
  const b = await seedUserWithWorkspace('b@acme.test')
  const bsJob = await enqueueResearchLead('lead-b', b.user.id) // owned by user b
  const aTicket = await issueTicket(a.user.id)

  assert.equal(await openStream(`/api/jobs/events/research-lead/${bsJob.id}?ticket=${aTicket}`), 403)
})
