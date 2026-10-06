// GET /api/commercial-opportunities/network-participation: the opt-in state Today
// reads, for members only, without the 403 the benchmarks give non-contributors.

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { commercialOpportunitiesRouter } from '../apps/api/src/routes/commercialOpportunities.ts'
import {
  createFakePrisma, installPrisma, resetPrisma, startTestServer, bearer,
  type TestServer,
} from './helpers/integration.ts'

const USER = 'u1'
const WS = 'ws1'
let optedInAt: Date | null = null

function spec() {
  return {
    user: { findUnique: async () => ({ id: USER, email: 'u1@a.test', name: null, emailVerified: true }) },
    membership: { findFirst: async (a: any) => (a?.where?.userId === USER && a?.where?.workspaceId === WS ? { id: 'm1', role: 'member' } : null) },
    workspace: { findUnique: async (a: any) => (a?.where?.id === WS ? { networkOptInAt: optedInAt } : null) },
  }
}

let server: TestServer
beforeEach(async () => {
  optedInAt = null
  installPrisma(createFakePrisma(spec()))
  server = await startTestServer('/api/commercial-opportunities', commercialOpportunitiesRouter)
})
afterEach(async () => { await server.close(); resetPrisma() })

const auth = { Authorization: bearer(USER) }
const path = (ws: string) => `/api/commercial-opportunities/network-participation?workspaceId=${ws}`

test('a workspace that has not opted in reads null, not a 403', async () => {
  const res = await server.request(path(WS), { headers: auth })
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { optedInAt: null })
})

test('an opted-in workspace reads its opt-in time', async () => {
  optedInAt = new Date('2026-09-01T00:00:00Z')
  const res = await server.request(path(WS), { headers: auth })
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { optedInAt: '2026-09-01T00:00:00.000Z' })
})

test('another workspace is refused', async () => {
  const res = await server.request(path('ws-other'), { headers: auth })
  assert.equal(res.status, 403)
})
