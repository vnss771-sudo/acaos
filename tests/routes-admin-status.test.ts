// /api/admin/status — the read-only operational status endpoint. It inherits the
// platform-admin gate (a non-admin must be denied), and for an admin it returns
// the live launch-control snapshot + dependency liveness + queue depths.
//
// Queue depths require Redis, which isn't available in the unit tier; the handler
// bounds that call with a timeout and degrades to `queues: null`, so the admin
// path resolves without a live Redis. We disconnect the shared connection in
// teardown so its reconnect timer can't keep the runner alive.

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { adminRouter } from '../apps/api/src/routes/admin.ts'
import { getRedisConnection } from '../packages/backend-core/src/lib/queues.ts'
import {
  createFakePrisma, installPrisma, resetPrisma, startTestServer, bearer,
  type FakePrisma, type TestServer,
} from './helpers/integration.ts'

const USER = 'u1'

function specForUser(isPlatformAdmin: boolean) {
  return {
    user: {
      findUnique: async () => ({
        id: USER, email: 'u1@a.test', name: null, emailVerified: true, isPlatformAdmin,
      }),
    },
  }
}

let server: TestServer
beforeEach(async () => {
  // No ADMIN_EMAIL: a non-admin must be denied outright, never bootstrapped.
  delete process.env.ADMIN_EMAIL
  server = await startTestServer('/api/admin', adminRouter)
})
afterEach(async () => {
  await server.close()
  resetPrisma()
  // Drop the shared Redis connection's reconnect timer so it can't outlive the test.
  try { getRedisConnection().disconnect() } catch { /* never connected */ }
})

const headers = { Authorization: bearer(USER) }

test('non-admin is denied (403) and never reaches the status payload', async () => {
  installPrisma(createFakePrisma(specForUser(false)) as FakePrisma)
  const res = await server.request('/api/admin/status', { headers })
  assert.equal(res.status, 403)
})

test('platform admin gets the live launch-control snapshot, dependencies, and queues', async () => {
  installPrisma(createFakePrisma(specForUser(true)) as FakePrisma)
  const res = await server.request('/api/admin/status', { headers })
  assert.equal(res.status, 200)
  // Launch-control snapshot is present and shaped (kill switches default ON).
  assert.equal(typeof res.body.launchControls, 'object')
  assert.equal(typeof res.body.launchControls.features.send, 'boolean')
  assert.ok(['off', 'observe', 'enforce'].includes(res.body.reputationGuardMode))
  assert.equal(typeof res.body.followupsEnabled, 'boolean')
  // Dependency liveness is reported (DB true via the fake $queryRaw, Redis down).
  assert.equal(res.body.dependencies.database, true)
  assert.equal(res.body.dependencies.redis, false)
  // Queue depths degrade to null when Redis is unreachable rather than hanging.
  assert.equal(res.body.queues, null)
  assert.equal(typeof res.body.timestamp, 'string')
})
