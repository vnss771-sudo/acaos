// DB-tier tests for the suppression list — the compliance-critical gate that
// keeps us from emailing unsubscribed/bounced addresses. Exercised against the
// real Prisma layer (the @@unique(workspaceId, email) constraint and case
// normalization can't be verified by the fake-Prisma unit tier).

import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { prisma, resetDb, disconnect, seedUserWithWorkspace } from './helpers/db.ts'
import { suppress, isSuppressed, bulkCheckSuppression } from '../packages/backend-core/src/lib/suppressions.ts'

beforeEach(resetDb)
after(disconnect)

test('suppress + isSuppressed normalize case and surrounding whitespace', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await suppress(workspace.id, '  Foo@Example.COM ', 'BOUNCED')

  assert.equal(await isSuppressed(workspace.id, 'foo@example.com'), true)
  assert.equal(await isSuppressed(workspace.id, 'FOO@EXAMPLE.COM'), true)
  assert.equal(await isSuppressed(workspace.id, 'other@example.com'), false)
})

test('suppress upserts: re-suppressing the same address updates the reason, no dup row', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await suppress(workspace.id, 'a@x.com', 'UNSUBSCRIBED')
  await suppress(workspace.id, 'A@X.com', 'MANUAL') // same address, different case

  const rows = await prisma.suppression.findMany({ where: { workspaceId: workspace.id } })
  assert.equal(rows.length, 1, 'normalization + upsert collapses to a single row')
  assert.equal(rows[0].reason, 'MANUAL')
})

test('bulkCheckSuppression predicate normalizes both sides and is workspace-scoped', async () => {
  const a = await seedUserWithWorkspace()
  const b = await seedUserWithWorkspace()
  await suppress(a.workspace.id, 'sup@x.com')
  await suppress(b.workspace.id, 'other@x.com') // suppressed only in the OTHER workspace

  const pred = await bulkCheckSuppression(a.workspace.id, ['SUP@x.com', 'clean@x.com', 'other@x.com'])
  assert.equal(pred('sup@x.com'), true, 'normalized address matches')
  assert.equal(pred('  SUP@X.COM '), true, 'raw mixed-case/whitespace still matches (the footgun this API closes)')
  assert.equal(pred('clean@x.com'), false, 'never-suppressed address is sendable')
  assert.equal(pred('other@x.com'), false, "another workspace's suppression must not leak in")
})
