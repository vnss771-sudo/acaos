// Integration tests for the public /api/unsubscribe router.
//
// Security invariant (CAN-SPAM + accidental-unsubscribe protection): GET is a
// safe confirmation page that must NOT change state (mail clients prefetch GET
// links); only POST performs the suppression.

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { unsubscribeRouter } from '../apps/api/src/routes/unsubscribe.ts'
import {
  createFakePrisma, installPrisma, resetPrisma, startTestServer,
  type FakePrisma, type TestServer,
} from './helpers/integration.ts'

const TOKEN = 'tok123'

function spec() {
  return {
    outreachSent: {
      findUnique: async (a: any) =>
        a?.where?.unsubscribeToken === TOKEN
          ? { id: 'o1', toEmail: 'prospect@acme.test', workspaceId: 'ws1' }
          : null,
    },
    suppression: { upsert: async (a: any) => ({ id: 's1', ...a.create }) },
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
