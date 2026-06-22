// DB-tier tests for canContactRecipient — the central contact-frequency gate
// composing suppression, the ContactEvent ledger, and lead terminal state.

import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { canContactRecipient } from '../packages/backend-core/src/services/contactPolicy.ts'
import { suppress } from '../packages/backend-core/src/lib/suppressions.ts'
import { recordContactEvent } from '../packages/backend-core/src/lib/contactEvents.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace } from './helpers/db.ts'

after(async () => { await disconnect() })
beforeEach(async () => { await resetDb() })

const EMAIL = 'target@buyer.test'

test('allows a fresh, never-contacted recipient', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const decision = await canContactRecipient({ workspaceId: workspace.id, email: EMAIL })
  assert.deepEqual(decision, { allowed: true })
})

test('blocks a suppressed recipient (case-insensitive)', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await suppress(workspace.id, EMAIL, 'UNSUBSCRIBED')
  const decision = await canContactRecipient({ workspaceId: workspace.id, email: 'TARGET@Buyer.TEST' })
  assert.deepEqual(decision, { allowed: false, reason: 'SUPPRESSED' })
})

test('blocks a recipient who already replied', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await recordContactEvent({ workspaceId: workspace.id, email: EMAIL, type: 'REPLIED' })
  const decision = await canContactRecipient({ workspaceId: workspace.id, email: EMAIL })
  assert.deepEqual(decision, { allowed: false, reason: 'ALREADY_REPLIED' })
})

test('blocks a terminal lead (BOOKED/CLOSED/DEAD)', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const lead = await prisma.lead.create({ data: { workspaceId: workspace.id, businessName: 'Acme', email: EMAIL, stage: 'BOOKED' } })
  const decision = await canContactRecipient({ workspaceId: workspace.id, email: EMAIL, leadId: lead.id })
  assert.deepEqual(decision, { allowed: false, reason: 'LEAD_TERMINAL' })
})

test('blocks a recently-contacted recipient (within the business-day gap)', async () => {
  const { workspace } = await seedUserWithWorkspace()
  // Sent yesterday → within the default 5-business-day gap.
  await recordContactEvent({ workspaceId: workspace.id, email: EMAIL, type: 'SENT', occurredAt: new Date(Date.now() - 24 * 60 * 60 * 1000) })
  const decision = await canContactRecipient({ workspaceId: workspace.id, email: EMAIL })
  assert.deepEqual(decision, { allowed: false, reason: 'RECENTLY_CONTACTED' })
})

test('enforces the monthly contact cap (>= 3 sends in 30 days)', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000)
  // Three older sends (outside the 5-business-day recency window but within 30 days).
  for (const n of [10, 15, 20]) {
    await recordContactEvent({ workspaceId: workspace.id, email: EMAIL, type: 'SENT', occurredAt: daysAgo(n) })
  }
  const decision = await canContactRecipient({ workspaceId: workspace.id, email: EMAIL })
  assert.deepEqual(decision, { allowed: false, reason: 'MONTHLY_CONTACT_LIMIT' })
})

test('suppression takes precedence over other signals', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await suppress(workspace.id, EMAIL, 'BOUNCED')
  await recordContactEvent({ workspaceId: workspace.id, email: EMAIL, type: 'REPLIED' })
  const decision = await canContactRecipient({ workspaceId: workspace.id, email: EMAIL })
  assert.deepEqual(decision, { allowed: false, reason: 'SUPPRESSED' })
})
