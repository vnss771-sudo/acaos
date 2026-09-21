// DB-tier tests for the ConsentRecord lookup helpers (lib/consent.ts) that the
// send-pipeline consent gate relies on — mirrors suppressions.test.ts since both
// are normalized-emailKey lookups with the same footguns to close.

import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { prisma, resetDb, disconnect, seedUserWithWorkspace } from './helpers/db.ts'
import { hasConsent, bulkCheckConsent } from '../packages/backend-core/src/lib/consent.ts'

beforeEach(resetDb)
after(disconnect)

async function recordConsent(workspaceId: string, email: string) {
  await prisma.consentRecord.create({
    data: { workspaceId, emailKey: email.trim().toLowerCase(), basis: 'express_consent', source: 'manual' },
  })
}

test('hasConsent normalizes case and surrounding whitespace', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await recordConsent(workspace.id, 'foo@example.com')

  assert.equal(await hasConsent(workspace.id, '  Foo@Example.COM '), true)
  assert.equal(await hasConsent(workspace.id, 'FOO@EXAMPLE.COM'), true)
  assert.equal(await hasConsent(workspace.id, 'other@example.com'), false)
})

test('hasConsent is workspace-scoped: a record in another workspace does not leak in', async () => {
  const a = await seedUserWithWorkspace()
  const b = await seedUserWithWorkspace()
  await recordConsent(b.workspace.id, 'shared@x.com')

  assert.equal(await hasConsent(a.workspace.id, 'shared@x.com'), false)
  assert.equal(await hasConsent(b.workspace.id, 'shared@x.com'), true)
})

test('bulkCheckConsent predicate normalizes both sides and is workspace-scoped', async () => {
  const a = await seedUserWithWorkspace()
  const b = await seedUserWithWorkspace()
  await recordConsent(a.workspace.id, 'yes@x.com')
  await recordConsent(b.workspace.id, 'other@x.com') // consented only in the OTHER workspace

  const pred = await bulkCheckConsent(a.workspace.id, ['YES@x.com', 'no@x.com', 'other@x.com'])
  assert.equal(pred('yes@x.com'), true, 'normalized address matches')
  assert.equal(pred('  YES@X.COM '), true, 'raw mixed-case/whitespace still matches')
  assert.equal(pred('no@x.com'), false, 'no record on file — no consent')
  assert.equal(pred('other@x.com'), false, "another workspace's consent record must not leak in")
})

test('an append-only ledger: multiple records for the same email are all fine, consent still holds', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await recordConsent(workspace.id, 'dupe@x.com')
  await recordConsent(workspace.id, 'dupe@x.com')
  assert.equal(await prisma.consentRecord.count({ where: { workspaceId: workspace.id, emailKey: 'dupe@x.com' } }), 2)
  assert.equal(await hasConsent(workspace.id, 'dupe@x.com'), true)
})
