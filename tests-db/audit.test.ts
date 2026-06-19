// Database-backed tests for the AuditEvent log + admin audit endpoint.

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { adminRouter } from '../apps/api/src/routes/admin.ts'
import { recordAudit } from '../packages/backend-core/src/lib/audit.ts'
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
  // Primary admin path: the non-user-settable DB flag + a verified email (the
  // hardened gate requires both — not just a matching ADMIN_EMAIL).
  await prisma.user.update({ where: { id: user.id }, data: { isPlatformAdmin: true, emailVerified: true } })
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
  // Verified, but not a platform admin and not the ADMIN_EMAIL — denied by the
  // admin gate (not merely the email-verification gate).
  await prisma.user.update({ where: { id: user.id }, data: { emailVerified: true } })
  process.env.ADMIN_EMAIL = 'someoneelse@acaos.test'
  const res = await server.request('/api/admin/audit', { headers: { Authorization: bearer(user.id) } })
  assert.equal(res.status, 403)
})

test('ADMIN_EMAIL is a one-time bootstrap: first hit promotes the DB flag and audits it', async () => {
  const { user } = await seedUserWithWorkspace('founder@acaos.test')
  // Verified, matches ADMIN_EMAIL, but the DB flag is NOT yet set.
  await prisma.user.update({ where: { id: user.id }, data: { emailVerified: true, isPlatformAdmin: false } })
  process.env.ADMIN_EMAIL = 'founder@acaos.test'

  // Privilege escalation requires step-up (a recent credential proof). Without a
  // fresh re-auth the bootstrap is refused — a stolen long-lived token can't self-promote.
  const stale = await server.request('/api/admin/audit', { headers: { Authorization: bearer(user.id) } })
  assert.equal(stale.status, 403)

  // Simulate a fresh login (login/reauth set lastReauthAt) and retry.
  await prisma.user.update({ where: { id: user.id }, data: { lastReauthAt: new Date() } })

  // First admin request after fresh auth: granted via the env bootstrap.
  const res = await server.request('/api/admin/audit', { headers: { Authorization: bearer(user.id) } })
  assert.equal(res.status, 200)

  // The grant is now persisted to the DB flag (source of truth from here on)…
  const promoted = await prisma.user.findUnique({ where: { id: user.id }, select: { isPlatformAdmin: true } })
  assert.equal(promoted!.isPlatformAdmin, true)

  // …and recorded in the audit log, so the bootstrap is observable.
  const ev = await prisma.auditEvent.findFirst({ where: { type: 'platform_admin.bootstrap', actorUserId: user.id } })
  assert.ok(ev, 'expected a platform_admin.bootstrap audit event')

  // Removing the env var no longer locks the founder out — the DB flag carries it.
  delete process.env.ADMIN_EMAIL
  const after = await server.request('/api/admin/audit', { headers: { Authorization: bearer(user.id) } })
  assert.equal(after.status, 200)
})
