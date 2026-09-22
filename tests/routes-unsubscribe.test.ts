// Integration tests for the public /api/unsubscribe router.
//
// Security invariant (CAN-SPAM + accidental-unsubscribe protection): GET is a
// safe confirmation page that must NOT change state (mail clients prefetch GET
// links); only POST performs the suppression.

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { unsubscribeRouter } from '../apps/api/src/routes/unsubscribe.ts'
import {
  createFakePrisma, installPrisma, resetPrisma, startTestServer, bearer,
  type FakePrisma, type TestServer,
} from './helpers/integration.ts'

const TOKEN = 'tok123'
const MEMBER = 'u1'
const OWNED = 'ws1'
const OTHER = 'ws2'

function spec() {
  return {
    outreachSent: {
      findUnique: async (a: any) =>
        a?.where?.unsubscribeToken === TOKEN
          ? { id: 'o1', toEmail: 'prospect@acme.test', workspaceId: 'ws1' }
          : null,
    },
    suppression: {
      upsert: async (a: any) => ({ id: 's1', ...a.create }),
      findMany: async () => [{ id: 's1', workspaceId: OWNED, email: 'a@b.test' }],
      count: async () => 1,
    },
    user: { findUnique: async () => ({ id: MEMBER, email: 'u1@acme.test', name: null, emailVerified: true }) },
    membership: { findFirst: async (a: any) => (a?.where?.userId === MEMBER && a?.where?.workspaceId === OWNED ? { id: 'm1', role: 'admin' } : null) },
  }
}

let prisma: FakePrisma
let server: TestServer
beforeEach(async () => {
  process.env.RATE_LIMIT_DISABLED = 'true'
  prisma = createFakePrisma(spec()); installPrisma(prisma)
  server = await startTestServer('/api/unsubscribe', unsubscribeRouter)
})
afterEach(async () => { await server.close(); resetPrisma() })

test('GET /:token shows a confirm page and does NOT suppress (no prefetch unsubscribe)', async () => {
  const res = await server.request(`/api/unsubscribe/${TOKEN}`)
  assert.equal(res.status, 200)
  assert.equal(prisma.callsTo('suppression', 'upsert').length, 0)
})

test('GET /:token returns 404 for an unknown token', async () => {
  const res = await server.request('/api/unsubscribe/nope')
  assert.equal(res.status, 404)
})

test('POST /:token suppresses the address', async () => {
  const res = await server.request(`/api/unsubscribe/${TOKEN}`, { method: 'POST' })
  assert.equal(res.status, 200)
  assert.equal(prisma.callsTo('suppression', 'upsert').length, 1)
})

// GET / — authenticated suppression-list endpoint. Previously untested.
test('GET / requires auth', async () => {
  assert.equal((await server.request(`/api/unsubscribe?workspaceId=${OWNED}`)).status, 401)
})
test('GET / denies a non-member workspace', async () => {
  const res = await server.request(`/api/unsubscribe?workspaceId=${OTHER}`, { headers: { Authorization: bearer(MEMBER) } })
  assert.equal(res.status, 403)
})
test('GET / returns the suppression list and total for a member', async () => {
  const res = await server.request(`/api/unsubscribe?workspaceId=${OWNED}`, { headers: { Authorization: bearer(MEMBER) } })
  assert.equal(res.status, 200)
  assert.equal(res.body.suppressions.length, 1)
  assert.equal(res.body.total, 1)
})
// Regression: the list was an unbounded findMany (no `take`), so a workspace
// whose suppression list has grown large (every unsubscribe click adds a row,
// outside the workspace owner's control) could send an unbounded query. `total`
// comes from a separate count() so it stays accurate even once the list itself
// is capped.
test('GET / caps the underlying query with a take limit', async () => {
  await server.request(`/api/unsubscribe?workspaceId=${OWNED}`, { headers: { Authorization: bearer(MEMBER) } })
  const call = prisma.callsTo('suppression', 'findMany').at(-1)
  assert.equal((call?.args[0] as { take?: number })?.take, 200)
})
