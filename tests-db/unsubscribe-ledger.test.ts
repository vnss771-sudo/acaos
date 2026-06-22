// DB-tier tests for the unsubscribe/bounce audit ledger: an opt-out must create
// BOTH a Suppression (current state) and an UnsubscribeEvent (audit), plus a
// UNSUBSCRIBED ContactEvent; a bounce records a BOUNCED ContactEvent.

import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { suppress } from '../packages/backend-core/src/lib/suppressions.ts'
import { recordContactEvent } from '../packages/backend-core/src/lib/contactEvents.ts'
import { normalizeEmail } from '../packages/backend-core/src/lib/normalize.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace } from './helpers/db.ts'

after(async () => { await disconnect() })
beforeEach(async () => { await resetDb() })

// Mirrors the unsubscribe route's effect (suppress + ledger writes) so the DB
// contract is verified without standing up the HTTP layer.
async function applyUnsubscribe(workspaceId: string, email: string, campaignId: string | null, outreachSentId: string | null) {
  await suppress(workspaceId, email, 'UNSUBSCRIBED')
  await prisma.unsubscribeEvent.create({
    data: { workspaceId, emailKey: normalizeEmail(email), source: 'LINK', campaignId, outreachSentId },
  })
  await recordContactEvent({ workspaceId, email, type: 'UNSUBSCRIBED', campaignId, outreachSentId })
}

test('unsubscribe creates a Suppression AND an UnsubscribeEvent AND a ContactEvent', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await applyUnsubscribe(workspace.id, 'Opt-Out@Buyer.TEST', null, null)

  // Suppression (current state), keyed on normalized emailKey.
  assert.equal(await prisma.suppression.count({ where: { workspaceId: workspace.id, emailKey: 'opt-out@buyer.test' } }), 1)
  // UnsubscribeEvent (audit), normalized.
  const unsub = await prisma.unsubscribeEvent.findFirst({ where: { workspaceId: workspace.id } })
  assert.equal(unsub!.emailKey, 'opt-out@buyer.test')
  assert.equal(unsub!.source, 'LINK')
  // ContactEvent (lifecycle ledger).
  const ev = await prisma.contactEvent.findFirst({ where: { workspaceId: workspace.id, type: 'UNSUBSCRIBED' } })
  assert.equal(ev!.emailKey, 'opt-out@buyer.test')
})

test('a bounce records a BOUNCED ContactEvent', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await recordContactEvent({ workspaceId: workspace.id, email: 'bounced@buyer.test', type: 'BOUNCED' })
  const ev = await prisma.contactEvent.findFirst({ where: { workspaceId: workspace.id, type: 'BOUNCED' } })
  assert.equal(ev!.emailKey, 'bounced@buyer.test')
})
