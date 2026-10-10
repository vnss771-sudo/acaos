// Read-only operator diagnostics (UQ-31): GET /api/admin/workspaces/:id/diagnostics.
// Platform admins only; each view is audited; and nothing sensitive — message
// content, recipients, credentials, tokens — ever leaves the server.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { adminRouter } from '../apps/api/src/routes/admin.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace, startTestServer, bearer, type TestServer } from './helpers/db.ts'

let admin: TestServer
before(async () => { admin = await startTestServer('/api/admin', adminRouter) })
after(async () => { await admin.close(); await disconnect() })
beforeEach(async () => { await resetDb() })

const get = (uid: string, path: string) => admin.request(path, { headers: { Authorization: bearer(uid) } })

test('a platform admin sees a workspace\'s posture, never its secrets or message content', async () => {
  const founder = await seedUserWithWorkspace('founder@acaos.test')
  await prisma.user.update({ where: { id: founder.user.id }, data: { isPlatformAdmin: true } })
  const pilot = await seedUserWithWorkspace('pilot@customer.test')
  const ws = pilot.workspace.id
  await prisma.workspace.update({ where: { id: ws }, data: { plan: 'growth', subscriptionStatus: 'past_due', billingGraceUntil: new Date(Date.now() + 3 * 86_400_000) } })
  await prisma.workspaceEmailConfig.create({
    data: {
      workspaceId: ws, smtpHost: 'smtp.customer.test', smtpFrom: 'sales@customer.test', smtpPass: 'SMTP-SECRET-PASS',
      imapHost: 'imap.customer.test', imapPass: 'IMAP-SECRET-PASS', authMethod: 'GOOGLE_OAUTH',
      oauthRefreshToken: 'OAUTH-REFRESH-SECRET', oauthConnectedAt: new Date(), oauthError: 'invalid_grant',
    },
  })
  const old = new Date(Date.now() - 6 * 3_600_000)
  await prisma.outreachSent.createMany({ data: [
    { workspaceId: ws, toEmail: 'buyer-one@private.test', subject: 'SECRET SUBJECT', body: 'SECRET BODY', status: 'SENT' },
    { workspaceId: ws, toEmail: 'buyer-two@private.test', subject: 'SECRET SUBJECT', body: 'SECRET BODY', status: 'SENDING', claimedAt: old },
  ] })
  await prisma.discoverySourceState.create({ data: { workspaceId: ws, source: 'planningalerts', lastRunAt: new Date(), lastError: 'HTTP 503\n  upstream down', runCount: 4, failureCount: 1 } })
  await prisma.auditEvent.create({ data: { workspaceId: ws, type: 'discovery.run_failed', entityType: 'DiscoveryRun', entityId: 'run1', metadata: { detail: 'SECRET METADATA' } } })

  const res = await get(founder.user.id, `/api/admin/workspaces/${ws}/diagnostics`)
  assert.equal(res.status, 200, JSON.stringify(res.body))
  const d = res.body.diagnostics
  assert.equal(d.billing.entitlement, 'grace')
  assert.equal(d.billing.effectivePlan, 'growth')
  assert.deepEqual(d.sending.last24h, { SENT: 1, SENDING: 1 })
  assert.equal(d.sending.staleSending, 1)
  assert.equal(d.mailbox.oauthActionRequired, true)
  assert.equal(d.mailbox.smtpConfigured, true)
  assert.deepEqual(d.discovery.sources.map((s: { source: string; lastError: string }) => [s.source, s.lastError]), [['planningalerts', 'HTTP 503 upstream down']])
  assert.deepEqual(d.recentFailures.map((f: { type: string; entityId: string }) => [f.type, f.entityId]), [['discovery.run_failed', 'run1']])
  assert.ok(res.body.release.version)

  const wire = JSON.stringify(res.body)
  for (const secret of ['SMTP-SECRET-PASS', 'IMAP-SECRET-PASS', 'OAUTH-REFRESH-SECRET', 'SECRET SUBJECT', 'SECRET BODY', 'buyer-one@private.test', 'SECRET METADATA', 'invalid_grant']) {
    assert.ok(!wire.includes(secret), `diagnostics must not expose ${secret}`)
  }
  assert.ok(await prisma.auditEvent.findFirst({ where: { workspaceId: ws, type: 'platform_admin.workspace_diagnostics_viewed', actorUserId: founder.user.id } }))
})

test('diagnostics: workspace members are refused and an unknown workspace is a 404', async () => {
  const founder = await seedUserWithWorkspace('founder@acaos.test')
  await prisma.user.update({ where: { id: founder.user.id }, data: { isPlatformAdmin: true } })
  const pilot = await seedUserWithWorkspace('pilot@customer.test')
  assert.equal((await get(pilot.user.id, `/api/admin/workspaces/${pilot.workspace.id}/diagnostics`)).status, 403)
  assert.equal((await get(founder.user.id, '/api/admin/workspaces/does-not-exist/diagnostics')).status, 404)
})
