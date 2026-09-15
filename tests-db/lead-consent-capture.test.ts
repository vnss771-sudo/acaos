// Database-backed tests for automatic ConsentRecord creation from lead
// create/import (Phase 3 — DPA/CASL consent capture). Previously a ConsentRecord
// could only be created via the manual Settings → Compliance admin action; these
// exercise the realistic path where consent evidence rides along with the
// contact itself (e.g. a CSV "consent date" column).

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { leadsRouter } from '../apps/api/src/routes/leads.ts'
import {
  prisma, resetDb, disconnect, seedUserWithWorkspace,
  startTestServer, bearer, type TestServer,
} from './helpers/db.ts'

let server: TestServer
before(async () => { server = await startTestServer('/api/leads', leadsRouter) })
after(async () => { await server.close(); await disconnect() })
beforeEach(async () => { await resetDb() })

test('POST /api/leads with consentBasis + email appends a ConsentRecord', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const res = await server.request('/api/leads', {
    method: 'POST',
    headers: { Authorization: bearer(user.id), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workspaceId: workspace.id, businessName: 'Acme', email: 'Prospect@Example.COM',
      consentBasis: 'express_consent', consentAt: '2026-01-15T00:00:00.000Z',
    }),
  })
  assert.equal(res.status, 201, JSON.stringify(res.body))

  const record = await prisma.consentRecord.findFirst({ where: { workspaceId: workspace.id } })
  assert.ok(record, 'a ConsentRecord is created alongside the lead')
  assert.equal(record!.emailKey, 'prospect@example.com', 'emailKey is normalized the same way as Suppression')
  assert.equal(record!.basis, 'express_consent')
  assert.equal(record!.source, 'import')
  assert.equal(record!.recordedAt.toISOString(), '2026-01-15T00:00:00.000Z')

  const audit = await prisma.auditEvent.findFirst({ where: { workspaceId: workspace.id, type: 'consent.recorded' } })
  assert.ok(audit, 'the auto-recorded consent is audited')
})

test('POST /api/leads without consentBasis creates no ConsentRecord (unchanged behavior)', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const res = await server.request('/api/leads', {
    method: 'POST',
    headers: { Authorization: bearer(user.id), 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceId: workspace.id, businessName: 'Acme', email: 'reach@buyer.test' }),
  })
  assert.equal(res.status, 201)
  assert.equal(await prisma.consentRecord.count({ where: { workspaceId: workspace.id } }), 0)
})

test('POST /api/leads rejects an unrecognized consentBasis', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const res = await server.request('/api/leads', {
    method: 'POST',
    headers: { Authorization: bearer(user.id), 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceId: workspace.id, businessName: 'Acme', email: 'reach@buyer.test', consentBasis: 'bogus' }),
  })
  assert.equal(res.status, 400)
})

test('POST /api/leads/import: rows carrying a valid consentBasis+email each seed a ConsentRecord', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const res = await server.request('/api/leads/import', {
    method: 'POST',
    headers: { Authorization: bearer(user.id), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workspaceId: workspace.id,
      leads: [
        { businessName: 'Consented Co', email: 'yes@buyer.test', consentBasis: 'implied_consent', consentAt: '2026-02-01T00:00:00.000Z' },
        { businessName: 'No Evidence Co', email: 'no@buyer.test' },
        { businessName: 'Bad Basis Co', email: 'bad@buyer.test', consentBasis: 'not_a_real_basis' },
      ],
    }),
  })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body.created, 3)
  assert.equal(res.body.consentRecorded, 1, 'only the row with a valid basis + email seeds a record')

  const records = await prisma.consentRecord.findMany({ where: { workspaceId: workspace.id } })
  assert.equal(records.length, 1)
  assert.equal(records[0].emailKey, 'yes@buyer.test')
  assert.equal(records[0].basis, 'implied_consent')
  assert.equal(records[0].recordedAt.toISOString(), '2026-02-01T00:00:00.000Z')
})

test('POST /api/leads/import: with no consent evidence at all, no ConsentRecord is created (unchanged behavior)', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const res = await server.request('/api/leads/import', {
    method: 'POST',
    headers: { Authorization: bearer(user.id), 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceId: workspace.id, leads: [{ businessName: 'Acme', email: 'reach@buyer.test' }] }),
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.consentRecorded, 0)
  assert.equal(await prisma.consentRecord.count({ where: { workspaceId: workspace.id } }), 0)
})
