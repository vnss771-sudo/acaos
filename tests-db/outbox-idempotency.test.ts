// Database-backed test for the campaign send outbox idempotency guarantee.
// The worker claims a send by inserting an OutreachSent row BEFORE calling SMTP;
// the unique (campaignId, leadId) constraint is what makes a duplicate send
// impossible (a racing attempt or a post-send crash retry cannot create a second
// claim). This verifies that constraint and that non-campaign sends are unaffected.

import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { prisma, resetDb, disconnect, seedUserWithWorkspace } from './helpers/db.ts'

after(async () => { await disconnect() })
beforeEach(async () => { await resetDb() })

test('OutreachSent allows only one row per (campaignId, leadId)', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const campaign = await prisma.campaign.create({
    data: { workspaceId: workspace.id, name: 'C', goalType: 'BOOK_CALL' },
  })
  const lead = await prisma.lead.create({
    data: { workspaceId: workspace.id, businessName: 'L', email: 'l@x.test', campaignId: campaign.id },
  })

  // First claim succeeds.
  await prisma.outreachSent.create({
    data: { workspaceId: workspace.id, campaignId: campaign.id, leadId: lead.id, toEmail: 'l@x.test', subject: 's', body: 'b', status: 'SENDING' },
  })

  // A second claim for the same (campaign, lead) is rejected — this is what
  // prevents a duplicate outbound email under retry/crash conditions.
  await assert.rejects(
    () => prisma.outreachSent.create({
      data: { workspaceId: workspace.id, campaignId: campaign.id, leadId: lead.id, toEmail: 'l@x.test', subject: 's2', body: 'b2', status: 'SENDING' },
    }),
    (err: { code?: string }) => err.code === 'P2002',
  )
})

test('OutreachSent rows with null campaign/lead are not constrained (NULLs distinct)', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await prisma.outreachSent.create({ data: { workspaceId: workspace.id, toEmail: 'a@x.test', subject: 's', body: 'b' } })
  await prisma.outreachSent.create({ data: { workspaceId: workspace.id, toEmail: 'b@x.test', subject: 's', body: 'b' } })
  const rows = await prisma.outreachSent.count({ where: { campaignId: null, leadId: null } })
  assert.equal(rows, 2)
})
