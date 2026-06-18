// Integration tests for /api/unsubscribe — the CAN-SPAM compliance surface.
//
// Two endpoints with very different trust levels share a router:
//   • GET /:token  — PUBLIC, unauthenticated. Linked from every outreach email
//     footer; resolving a valid token must suppress the recipient.
//   • GET /        — AUTHENTICATED owners only; lists a workspace's suppressions
//     and must deny non-members.
// Both paths run through the fake-Prisma harness so the real route handlers,
// the `suppress()` helper, and the workspace-access check are exercised.

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { unsubscribeRouter } from '../apps/api/src/routes/unsubscribe.ts'
import {
  createFakePrisma, installPrisma, resetPrisma, startTestServer, bearer,
  type FakePrisma, type TestServer,
} from './helpers/integration.ts'

let server: TestServer
let fake: FakePrisma

// A token known to the fake outreachSent table, mapping to a recipient.
const KNOWN_TOKEN = 'unsub-token-abc'

beforeEach(async () => {
  fake = createFakePrisma({
    outreachSent: {
      findUnique: async (a: any) =>
        a?.where?.unsubscribeToken === KNOWN_TOKEN
          ? { id: 'os1', toEmail: 'Prospect@Example.com', workspaceId: 'ws1' }
          : null,
    },
    suppression: {
      upsert: async (a: any) => ({ id: 'sup1', ...a.create }),
      findMany: async (a: any) =>
        a?.where?.workspaceId === 'ws1'
          ? [{ id: 'sup1', workspaceId: 'ws1', email: 'prospect@example.com', reason: 'UNSUBSCRIBED' }]
          : [],
    },
    // requireAuth loads the bearer user before any handler runs.
    user: {
      findUnique: async (a: any) =>
        a?.where?.id === 'u1' ? { id: 'u1', email: 'u1@a.test', name: null, emailVerified: true } : null,
    },
    // Membership backs userHasWorkspaceAccess: u1 ∈ ws1 only.
    membership: {
      findFirst: async (a: any) =>
        a?.where?.userId === 'u1' && a?.where?.workspaceId === 'ws1' ? { id: 'm1' } : null,
    },
  })
  installPrisma(fake)
  server = await startTestServer('/api/unsubscribe', unsubscribeRouter)
})
afterEach(async () => { await server.close(); resetPrisma() })

// ── Public token endpoint ────────────────────────────────────────────────────

test('a valid token suppresses the recipient and confirms with their address', async () => {
  const res = await server.request(`/api/unsubscribe/${KNOWN_TOKEN}`)
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.match(res.body.message, /unsubscribed/i)

  // suppress() must have written a suppression row for the resolved recipient.
  const upserts = fake.callsTo('suppression', 'upsert')
  assert.equal(upserts.length, 1)
  const arg = upserts[0].args[0] as any
  // Email is normalised to lower-case by suppress(); reason defaults to UNSUBSCRIBED.
  assert.equal(arg.where.workspaceId_email.email, 'prospect@example.com')
  assert.equal(arg.create.reason, 'UNSUBSCRIBED')
})

test('an unknown token returns 404 and writes no suppression', async () => {
  const res = await server.request('/api/unsubscribe/does-not-exist')
  assert.equal(res.status, 404)
  assert.equal(fake.callsTo('suppression', 'upsert').length, 0)
})

test('an empty token segment never reaches the handler', async () => {
  // A trailing slash matches the authenticated list route, not /:token, so the
  // public path cannot be invoked with a blank token.
  const res = await server.request('/api/unsubscribe/%20') // whitespace-only token
  assert.equal(res.status, 400)
})

test('the public endpoint requires no Authorization header', async () => {
  const res = await server.request(`/api/unsubscribe/${KNOWN_TOKEN}`)
  assert.equal(res.status, 200)
})

// ── Authenticated suppression-list endpoint ──────────────────────────────────

test('listing suppressions requires authentication', async () => {
  const res = await server.request('/api/unsubscribe/?workspaceId=ws1')
  assert.equal(res.status, 401)
})

test('listing requires a workspaceId', async () => {
  const res = await server.request('/api/unsubscribe/', { headers: { Authorization: bearer('u1') } })
  assert.equal(res.status, 400)
})

test('a non-member cannot read another workspace’s suppression list', async () => {
  const res = await server.request('/api/unsubscribe/?workspaceId=ws-other', {
    headers: { Authorization: bearer('u1') },
  })
  assert.equal(res.status, 403)
  assert.equal(fake.callsTo('suppression', 'findMany').length, 0)
})

test('a member receives their workspace’s suppression list', async () => {
  const res = await server.request('/api/unsubscribe/?workspaceId=ws1', {
    headers: { Authorization: bearer('u1') },
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.suppressions.length, 1)
  assert.equal(res.body.suppressions[0].email, 'prospect@example.com')
})
