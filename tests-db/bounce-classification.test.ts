// DB-tier tests for soft/hard bounce handling (applyBounces, extracted from
// syncMailboxOnce so it's testable without an IMAP server). Hard/unknown bounces
// suppress immediately (unchanged behaviour); a confidently-soft (4.x.x) bounce
// marks the send BOUNCED and records a class-tagged ledger event but does NOT
// suppress until repeated soft bounces cross the threshold.

import { test, beforeEach, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { applyBounces } from '../packages/backend-core/src/services/mail.ts'
import { isSuppressed } from '../packages/backend-core/src/lib/suppressions.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace } from './helpers/db.ts'

after(async () => { await disconnect() })
beforeEach(async () => { await resetDb() })

const savedEnv: Record<string, string | undefined> = {}
function setEnv(k: string, v: string) { if (!(k in savedEnv)) savedEnv[k] = process.env[k]; process.env[k] = v }
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  for (const k of Object.keys(savedEnv)) delete savedEnv[k]
})

async function seedSend(workspaceId: string, toEmail: string) {
  const campaign = await prisma.campaign.create({ data: { workspaceId, name: 'C', goalType: 'BOOK_MEETINGS' } })
  const lead = await prisma.lead.create({ data: { workspaceId, campaignId: campaign.id, businessName: 'Acme', email: toEmail, stage: 'OUTREACH_SENT' } })
  await prisma.outreachSent.create({ data: { workspaceId, campaignId: campaign.id, leadId: lead.id, toEmail, subject: 'Hi', body: 'x', status: 'SENT', sentAt: new Date() } })
}

test('hard bounce: suppresses immediately and marks the send BOUNCED', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await seedSend(workspace.id, 'dead@buyer.test')

  const n = await applyBounces(workspace.id, [{ recipients: ['dead@buyer.test'], bounceType: 'hard' }])
  assert.equal(n, 1)
  assert.equal(await isSuppressed(workspace.id, 'dead@buyer.test'), true)
  const send = await prisma.outreachSent.findFirst({ where: { toEmail: 'dead@buyer.test' } })
  assert.equal(send!.status, 'BOUNCED')
  const ev = await prisma.contactEvent.findFirst({ where: { workspaceId: workspace.id, type: 'BOUNCED' } })
  assert.equal((ev!.metadata as { bounceType?: string }).bounceType, 'hard')
})

test('unknown bounce: still suppresses immediately (preserves prior behaviour)', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await seedSend(workspace.id, 'mystery@buyer.test')

  await applyBounces(workspace.id, [{ recipients: ['mystery@buyer.test'], bounceType: 'unknown' }])
  assert.equal(await isSuppressed(workspace.id, 'mystery@buyer.test'), true)
})

test('soft bounce: a single transient failure does NOT suppress', async () => {
  const { workspace } = await seedUserWithWorkspace()
  setEnv('SOFT_BOUNCE_SUPPRESS_THRESHOLD', '3')
  await seedSend(workspace.id, 'busy@buyer.test')

  const n = await applyBounces(workspace.id, [{ recipients: ['busy@buyer.test'], bounceType: 'soft' }])
  assert.equal(n, 1)
  assert.equal(await isSuppressed(workspace.id, 'busy@buyer.test'), false, 'a transient bounce must not permanently suppress')
  // The send is still marked BOUNCED and a soft-tagged ledger event recorded.
  assert.equal((await prisma.outreachSent.findFirst({ where: { toEmail: 'busy@buyer.test' } }))!.status, 'BOUNCED')
  const ev = await prisma.contactEvent.findFirst({ where: { workspaceId: workspace.id, type: 'BOUNCED' } })
  assert.equal((ev!.metadata as { bounceType?: string }).bounceType, 'soft')
})

test('soft bounce: suppresses once repeated soft bounces reach the threshold', async () => {
  const { workspace } = await seedUserWithWorkspace()
  setEnv('SOFT_BOUNCE_SUPPRESS_THRESHOLD', '3')
  await seedSend(workspace.id, 'flaky@buyer.test')

  // Three soft bounces over three syncs.
  await applyBounces(workspace.id, [{ recipients: ['flaky@buyer.test'], bounceType: 'soft' }])
  assert.equal(await isSuppressed(workspace.id, 'flaky@buyer.test'), false)
  await applyBounces(workspace.id, [{ recipients: ['flaky@buyer.test'], bounceType: 'soft' }])
  assert.equal(await isSuppressed(workspace.id, 'flaky@buyer.test'), false)
  await applyBounces(workspace.id, [{ recipients: ['flaky@buyer.test'], bounceType: 'soft' }])
  assert.equal(await isSuppressed(workspace.id, 'flaky@buyer.test'), true, 'the 3rd soft bounce crosses the threshold')

  const softEvents = await prisma.contactEvent.count({
    where: { workspaceId: workspace.id, type: 'BOUNCED', metadata: { path: ['bounceType'], equals: 'soft' } },
  })
  assert.equal(softEvents, 3)
})

test('safety: an address we never sent to is never suppressed (stray DSN address)', async () => {
  const { workspace } = await seedUserWithWorkspace()
  // No seedSend — this address was never a recipient of our outreach.
  const n = await applyBounces(workspace.id, [{ recipients: ['stranger@elsewhere.test'], bounceType: 'hard' }])
  assert.equal(n, 0)
  assert.equal(await isSuppressed(workspace.id, 'stranger@elsewhere.test'), false)
})

test('mixed classes for one address: a hard message forces immediate suppression', async () => {
  const { workspace } = await seedUserWithWorkspace()
  setEnv('SOFT_BOUNCE_SUPPRESS_THRESHOLD', '3')
  await seedSend(workspace.id, 'both@buyer.test')

  // Same address referenced by both a soft and a hard bounce in one batch → hard wins.
  await applyBounces(workspace.id, [
    { recipients: ['both@buyer.test'], bounceType: 'soft' },
    { recipients: ['both@buyer.test'], bounceType: 'hard' },
  ])
  assert.equal(await isSuppressed(workspace.id, 'both@buyer.test'), true)
})
