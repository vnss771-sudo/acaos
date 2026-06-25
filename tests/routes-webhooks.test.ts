// Integration tests for /api/webhooks — endpoint CRUD with workspace authorization
// and secret handling (full secret once on create, masked thereafter).

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { webhooksRouter } from '../apps/api/src/routes/webhooks.ts'
import { createFakePrisma, installPrisma, resetPrisma, startTestServer, bearer, type TestServer } from './helpers/integration.ts'

const ADMIN = 'admin-user'
const MEMBER = 'member-user'
const OWNED = 'ws1'
const OTHER = 'ws2'

// Role resolution for assertWorkspacePermission + userBelongsToWorkspace: ADMIN is
// admin of OWNED, MEMBER is a plain member of OWNED, nobody belongs to OTHER.
function membershipFor(a: any) {
  const { userId, workspaceId, role } = a?.where ?? {}
  if (workspaceId !== OWNED) return null
  const r = userId === ADMIN ? 'admin' : userId === MEMBER ? 'member' : null
  if (!r) return null
  if (role?.in && !role.in.includes(r)) return null
  return { id: `m-${userId}`, role: r }
}

function spec(overrides: Record<string, any> = {}) {
  return {
    user: { findUnique: async (a: any) => ({ id: a?.where?.id, email: 'u@x.test', name: null, emailVerified: true }) },
    membership: { findFirst: async (a: any) => membershipFor(a) },
    webhookEndpoint: {
      // Obviously-fake, low-entropy fixture (a real secret is high-entropy + DB-only;
      // this keeps the secret-scanner from flagging a test value).
      findMany: async () => [{ id: 'wh1', url: 'https://a.test', secret: 'whsec_aaaaaaaaaaaa', eventTypes: ['reply.received'], enabled: true, failureCount: 0, lastDeliveryAt: null, lastStatus: null, createdAt: new Date() }],
      create: async (a: any) => ({ id: 'wh-new', enabled: true, failureCount: 0, lastDeliveryAt: null, lastStatus: null, createdAt: new Date(), ...a.data }),
      findUnique: async (a: any) => (a?.where?.id === 'wh1' ? { id: 'wh1', workspaceId: OWNED, url: 'https://a.test' } : null),
      delete: async () => ({ id: 'wh1' }),
    },
    ...overrides,
  }
}

let server: TestServer
beforeEach(async () => { installPrisma(createFakePrisma(spec())); server = await startTestServer('/api/webhooks', webhooksRouter) })
afterEach(async () => { await server.close(); resetPrisma() })

const json = (uid: string) => ({ Authorization: bearer(uid), 'Content-Type': 'application/json' })

test('POST creates an endpoint and returns the full secret exactly once (admin)', async () => {
  const res = await server.request('/api/webhooks', {
    method: 'POST', headers: json(ADMIN),
    body: JSON.stringify({ workspaceId: OWNED, url: 'https://hook.test/x', eventTypes: ['reply.received', 'reply.received'] }),
  })
  assert.equal(res.status, 201)
  assert.match(res.body.secret, /^whsec_[0-9a-f]+$/, 'full secret returned on create')
  assert.deepEqual(res.body.endpoint.eventTypes, ['reply.received'], 'duplicates collapsed')
  assert.match(res.body.endpoint.secretMasked, /…$/, 'endpoint object only carries a masked secret')
})

test('POST rejects an unsupported event type (400)', async () => {
  const res = await server.request('/api/webhooks', {
    method: 'POST', headers: json(ADMIN),
    body: JSON.stringify({ workspaceId: OWNED, url: 'https://hook.test/x', eventTypes: ['nope.bad'] }),
  })
  assert.equal(res.status, 400)
})

test('POST denies a plain member (workspace:update required)', async () => {
  const res = await server.request('/api/webhooks', {
    method: 'POST', headers: json(MEMBER),
    body: JSON.stringify({ workspaceId: OWNED, url: 'https://hook.test/x', eventTypes: ['reply.received'] }),
  })
  assert.equal(res.status, 403)
})

test('GET lists endpoints with masked secrets for a member', async () => {
  const res = await server.request(`/api/webhooks?workspaceId=${OWNED}`, { headers: { Authorization: bearer(MEMBER) } })
  assert.equal(res.status, 200)
  assert.equal(res.body.endpoints[0].secretMasked, 'whsec_aaaaa…')
  assert.equal(res.body.endpoints[0].secret, undefined, 'raw secret never listed')
  assert.ok(res.body.supportedEvents.includes('reply.received'))
})

test('GET denies a non-member workspace (403)', async () => {
  assert.equal((await server.request(`/api/webhooks?workspaceId=${OTHER}`, { headers: { Authorization: bearer(ADMIN) } })).status, 403)
})

test('DELETE removes an endpoint (admin); 404 for unknown', async () => {
  assert.equal((await server.request('/api/webhooks/wh1', { method: 'DELETE', headers: json(ADMIN) })).status, 200)
  assert.equal((await server.request('/api/webhooks/nope', { method: 'DELETE', headers: json(ADMIN) })).status, 404)
})
