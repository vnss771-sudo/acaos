// Integration tests for GET/PATCH /api/missions/:id/icp — the mission-level
// ICP override: reading the resolved effective targeting, and setting/clearing
// the override itself.

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { Prisma } from '@prisma/client'
import { missionsRouter } from '../apps/api/src/routes/missions.ts'
import {
  createFakePrisma,
  installPrisma,
  resetPrisma,
  startTestServer,
  bearer,
  type FakePrisma,
  type TestServer,
} from './helpers/integration.ts'

const MEMBER = 'u1'
const OWNED_WS = 'ws1'
const OTHER_WS = 'ws2'

function membershipFor(userId: string, workspaceId: string) {
  return userId === MEMBER && workspaceId === OWNED_WS ? { id: 'm1', role: 'admin' } : null
}

function missionRow(workspaceId: string, id = 'm1', playbookId: string | null = null, icpOverride: unknown = null) {
  return { id, workspaceId, playbookId, icpOverride }
}

// Emulates the real Postgres round-trip: writing Prisma.JsonNull persists SQL
// NULL, and reading it back yields plain `null` — never the sentinel itself.
function normalizeIcpOverride(value: unknown) {
  return value === Prisma.JsonNull ? null : value
}

function spec(overrides: Record<string, unknown> = {}) {
  return {
    user: { findUnique: async () => ({ id: MEMBER, email: 'u1@acme.test', name: null, emailVerified: true }) },
    membership: { findFirst: async (args: any) => membershipFor(args?.where?.userId, args?.where?.workspaceId) },
    mission: {
      findUnique: async (args: any) => {
        if (args?.where?.id === 'm1') return missionRow(OWNED_WS, 'm1')
        if (args?.where?.id === 'm-fieldops') return missionRow(OWNED_WS, 'm-fieldops', 'fieldops')
        if (args?.where?.id === 'm-override') return missionRow(OWNED_WS, 'm-override', null, { targetIndustries: ['Manufacturing'], minEmployees: 100 })
        if (args?.where?.id === 'm-other') return missionRow(OTHER_WS, 'm-other')
        return null
      },
      update: async (a: any) => ({ ...missionRow(OWNED_WS), ...a.data, icpOverride: normalizeIcpOverride(a.data.icpOverride) }),
    },
    workspaceICP: { findUnique: async () => null },
    auditEvent: { create: async () => ({ id: 'a1' }) },
    ...overrides,
  }
}

let prisma: FakePrisma
let server: TestServer

beforeEach(async () => {
  prisma = createFakePrisma(spec())
  installPrisma(prisma)
  server = await startTestServer('/api/missions', missionsRouter)
})

afterEach(async () => {
  await server.close()
  resetPrisma()
})

const auth = (u: string) => ({ Authorization: bearer(u) })
const jsonHeaders = { Authorization: bearer(MEMBER), 'Content-Type': 'application/json' }

// --- GET /:id/icp ---

test('GET /:id/icp denies access to another workspace\'s mission', async () => {
  const res = await server.request('/api/missions/m-other/icp', { headers: auth(MEMBER) })
  assert.equal(res.status, 403)
})

test('GET /:id/icp returns 404 for an unknown mission', async () => {
  const res = await server.request('/api/missions/missing/icp', { headers: auth(MEMBER) })
  assert.equal(res.status, 404)
})

test('GET /:id/icp with no override, no workspace ICP, no playbook: everything empty', async () => {
  const res = await server.request('/api/missions/m1/icp', { headers: auth(MEMBER) })
  assert.equal(res.status, 200)
  assert.equal(res.body.override, null)
  assert.deepEqual(res.body.effective.targetIndustries, [])
  assert.deepEqual(res.body.effective.targetGeos, [])
})

test('GET /:id/icp with no override falls through to the playbook preset', async () => {
  const res = await server.request('/api/missions/m-fieldops/icp', { headers: auth(MEMBER) })
  assert.equal(res.status, 200)
  assert.equal(res.body.override, null)
  assert.ok(res.body.effective.targetIndustries.length > 0, 'the fieldops pack preset has industries')
})

test('GET /:id/icp surfaces the stored override and its resolved effective value', async () => {
  const res = await server.request('/api/missions/m-override/icp', { headers: auth(MEMBER) })
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.override, { targetIndustries: ['Manufacturing'], minEmployees: 100 })
  assert.deepEqual(res.body.effective.targetIndustries, ['Manufacturing'])
  assert.equal(res.body.effective.minEmployees, 100)
})

// --- PATCH /:id/icp ---

test('PATCH /:id/icp denies a non-admin/other-workspace caller and does not write', async () => {
  const res = await server.request('/api/missions/m-other/icp', {
    method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ override: { targetIndustries: ['X'] } }),
  })
  assert.equal(res.status, 403)
  assert.equal(prisma.callsTo('mission', 'update').length, 0)
})

test('PATCH /:id/icp returns 404 for an unknown mission', async () => {
  const res = await server.request('/api/missions/missing/icp', {
    method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ override: { targetIndustries: ['X'] } }),
  })
  assert.equal(res.status, 404)
})

test('PATCH /:id/icp sets the override and audits it', async () => {
  const res = await server.request('/api/missions/m1/icp', {
    method: 'PATCH', headers: jsonHeaders,
    body: JSON.stringify({ override: { targetIndustries: ['Manufacturing'], targetGeos: ['NSW'], minEmployees: 50, maxEmployees: 500 } }),
  })
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.override, { targetIndustries: ['Manufacturing'], targetGeos: ['NSW'], minEmployees: 50, maxEmployees: 500 })
  assert.equal(prisma.callsTo('mission', 'update').length, 1)
  const audit = prisma.callsTo('auditEvent', 'create')[0].args[0] as any
  assert.equal(audit.data.type, 'mission.icp_override')
  assert.equal(audit.data.metadata.cleared, false)
})

test('PATCH /:id/icp with override: null clears the override', async () => {
  const res = await server.request('/api/missions/m-override/icp', {
    method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ override: null }),
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.override, null)
  const updateArg = prisma.callsTo('mission', 'update')[0].args[0] as any
  assert.equal(updateArg.data.icpOverride, Prisma.JsonNull)
  const audit = prisma.callsTo('auditEvent', 'create')[0].args[0] as any
  assert.equal(audit.data.metadata.cleared, true)
})

test('PATCH /:id/icp rejects a negative minEmployees (400) and does not write', async () => {
  const res = await server.request('/api/missions/m1/icp', {
    method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ override: { minEmployees: -5 } }),
  })
  assert.equal(res.status, 400)
  assert.equal(prisma.callsTo('mission', 'update').length, 0)
})

test('PATCH /:id/icp rejects a missing override field (400)', async () => {
  const res = await server.request('/api/missions/m1/icp', {
    method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({}),
  })
  assert.equal(res.status, 400)
})
