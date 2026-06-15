// Database-backed tests for the AuditEvent log + admin audit endpoint.

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { adminRouter } from '../apps/api/src/routes/admin.ts'
import { recordAudit } from '../apps/api/src/lib/audit.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace, startTestServer, bearer, type TestServer } from './helpers/db.ts'

let server: TestServer
const prevAdminEmail = process.env.ADMIN_EMAIL
before(async () => { server = await startTestServer('/api/admin', adminRouter) })
after(async () => {
  if (prevAdminEmail === undefined) delete process.env.ADMIN_EMAIL
  else process.env.ADMIN_EMAIL = prevAdminEmail
  await server.close(); await disconnect()
})
beforeEach(async () => { await resetDb() })

test('recordAudit writes an event with metadata', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  await recordAudit({ workspaceId: workspace.id, actorUserId: user.id, type: 'test.event', entityType: 'x', entityId: 'y', metadata: { a: 1 } })
  const ev = await prisma.auditEvent.findFirst({ where: { type: 'test.event' } })
  assert.ok(ev)
  assert.equal(ev!.entityId, 'y')
  assert.deepEqual(ev!.metadata, { a: 1 })
})

test('GET /admin/audit lists events for an admin (newest first, filterable)', async () => {
  const { user, workspace } = await seedUserWithWorkspace('admin@acaos.test')
  process.env.ADMIN_EMAIL = 'admin@acaos.test'
  await recordAudit({ workspaceId: workspace.id, actorUserId: user.id, type: 'campaign.send', entityId: 'c1' })
  await recordAudit({ workspaceId: workspace.id, actorUserId: user.id, type: 'mission.create', entityId: 'm1' })

  const res = await server.request('/api/admin/audit', { headers: { Authorization: bearer(user.id) } })
  assert.equal(res.status, 200)
  assert.equal(res.body.events.length, 2)

  const filtered = await server.request('/api/admin/audit?type=campaign.send', { headers: { Authorization: bearer(user.id) } })
  assert.equal(filtered.body.events.length, 1)
  assert.equal(filtered.body.events[0].entityId, 'c1')
})

test('GET /admin/audit denies a non-admin', async () => {
  const { user } = await seedUserWithWorkspace('notadmin@acaos.test')
  process.env.ADMIN_EMAIL = 'someoneelse@acaos.test'
  const res = await server.request('/api/admin/audit', { headers: { Authorization: bearer(user.id) } })
  assert.equal(res.status, 403)
})
