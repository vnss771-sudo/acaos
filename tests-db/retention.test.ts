// Database-backed tests for the automated retention sweep (purgeExpiredData).
// Verifies that rows past their documented window are deleted, rows inside it
// survive, and that auth tokens are only purged once spent (expired/used/revoked)
// AND past the grace window — never while still live and usable.

import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { purgeExpiredData } from '../packages/backend-core/src/lib/retention.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace } from './helpers/db.ts'

after(async () => { await disconnect() })
beforeEach(async () => { await resetDb() })

const DAY = 24 * 60 * 60 * 1000
const ago = (days: number) => new Date(Date.now() - days * DAY)

test('purges rows past their window and keeps rows inside it', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const ws = workspace.id

  // ProcessedEmail — 90-day window.
  await prisma.processedEmail.create({ data: { workspaceId: ws, uid: 1, fromAddress: 'a@x.test', processedAt: ago(120) } })
  await prisma.processedEmail.create({ data: { workspaceId: ws, uid: 2, fromAddress: 'b@x.test', processedAt: ago(30) } })

  // AuditEvent — 24-month (730-day) window.
  await prisma.auditEvent.create({ data: { workspaceId: ws, type: 'old.event', createdAt: ago(800) } })
  await prisma.auditEvent.create({ data: { workspaceId: ws, type: 'new.event', createdAt: ago(10) } })

  // DiscoveryRun — 12-month (365-day) window.
  await prisma.discoveryRun.create({ data: { workspaceId: ws, source: 'apollo', status: 'SUCCEEDED', startedAt: ago(400) } })
  await prisma.discoveryRun.create({ data: { workspaceId: ws, source: 'apollo', status: 'SUCCEEDED', startedAt: ago(100) } })

  // AnalyticsEvent — 12-month (365-day) window.
  await prisma.analyticsEvent.create({ data: { workspaceId: ws, name: 'signup', occurredAt: ago(400) } })
  await prisma.analyticsEvent.create({ data: { workspaceId: ws, name: 'signup', occurredAt: ago(30) } })

  // ProcessedStripeEvent — 12-month window (platform-wide).
  await prisma.processedStripeEvent.create({ data: { id: 'evt_old', type: 'invoice.paid', processedAt: ago(400) } })
  await prisma.processedStripeEvent.create({ data: { id: 'evt_new', type: 'invoice.paid', processedAt: ago(5) } })

  const deleted = await purgeExpiredData()

  assert.equal(deleted.processedEmail, 1)
  assert.equal(deleted.auditEvent, 1)
  assert.equal(deleted.discoveryRun, 1)
  assert.equal(deleted.analyticsEvent, 1)
  assert.equal(deleted.processedStripeEvent, 1)

  assert.equal(await prisma.processedEmail.count(), 1)
  assert.equal(await prisma.auditEvent.count(), 1)
  assert.equal(await prisma.discoveryRun.count(), 1)
  assert.equal(await prisma.analyticsEvent.count(), 1)
  assert.equal(await prisma.processedStripeEvent.count(), 1)
})

test('refresh tokens: purges spent+old, keeps live tokens and recently-revoked ones', async () => {
  const { user } = await seedUserWithWorkspace()
  const uid = user.id

  // Expired and old → purged.
  await prisma.refreshToken.create({ data: { userId: uid, tokenHash: 'h-expired-old', expiresAt: ago(40), createdAt: ago(60) } })
  // Revoked and old → purged.
  await prisma.refreshToken.create({ data: { userId: uid, tokenHash: 'h-revoked-old', expiresAt: new Date(Date.now() + 10 * DAY), revokedAt: ago(35), createdAt: ago(60) } })
  // Live (not expired, not revoked), old → KEPT (still usable).
  await prisma.refreshToken.create({ data: { userId: uid, tokenHash: 'h-live-old', expiresAt: new Date(Date.now() + 10 * DAY), createdAt: ago(60) } })
  // Expired but created recently (inside grace window) → KEPT.
  await prisma.refreshToken.create({ data: { userId: uid, tokenHash: 'h-expired-recent', expiresAt: ago(1), createdAt: ago(5) } })

  const deleted = await purgeExpiredData()

  assert.equal(deleted.refreshToken, 2)
  const survivors = await prisma.refreshToken.findMany({ select: { tokenHash: true } })
  assert.deepEqual(new Set(survivors.map((s) => s.tokenHash)), new Set(['h-live-old', 'h-expired-recent']))
})

test('is idempotent — a second sweep deletes nothing', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await prisma.processedEmail.create({ data: { workspaceId: workspace.id, uid: 9, fromAddress: 'a@x.test', processedAt: ago(200) } })

  const first = await purgeExpiredData()
  assert.equal(first.processedEmail, 1)
  const second = await purgeExpiredData()
  assert.equal(second.processedEmail, 0)
})
