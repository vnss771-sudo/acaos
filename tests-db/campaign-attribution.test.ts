// Database-backed test for campaign ROI attribution: sent/replied come from the
// immutable ContactEvent ledger as DISTINCT leads (so a lead that later goes DEAD
// still counts, and a lead with two replies counts once), while booked/won come
// from the lead's current sticky stage.

import { test, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { getCampaignAttribution } from '../packages/backend-core/src/lib/campaignAttribution.ts'
import { contactEventData } from '../packages/backend-core/src/lib/contactEvents.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace } from './helpers/db.ts'

after(async () => { await disconnect() })
beforeEach(async () => { await resetDb() })

test('attribution: distinct-lead ledger counts + stage-based booked/won, drop-loss-free', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const ws = workspace.id
  const campaign = await prisma.campaign.create({ data: { workspaceId: ws, name: 'C', goalType: 'BOOK_MEETINGS' } })

  // Four leads contacted; their CURRENT stages vary — incl. one replied-then-DEAD.
  const mk = (email: string, stage: any) => prisma.lead.create({ data: { workspaceId: ws, campaignId: campaign.id, businessName: 'B', email, stage } })
  const l1 = await mk('a@x.test', 'CLOSED')   // won (was booked, replied)
  const l2 = await mk('b@x.test', 'BOOKED')   // booked (replied)
  const l3 = await mk('c@x.test', 'DEAD')     // replied then NOT_INTERESTED → DEAD
  const l4 = await mk('d@x.test', 'OUTREACH_SENT') // contacted, no reply

  // Ledger: all four SENT; l1/l2/l3 REPLIED (l2 replied twice → still one distinct lead).
  const sent = (lead: { id: string; email: string | null }) =>
    contactEventData({ workspaceId: ws, email: lead.email!, type: 'SENT', leadId: lead.id, campaignId: campaign.id })
  const replied = (lead: { id: string; email: string | null }) =>
    contactEventData({ workspaceId: ws, email: lead.email!, type: 'REPLIED', leadId: lead.id, campaignId: campaign.id })
  for (const l of [l1, l2, l3, l4]) await prisma.contactEvent.create({ data: sent(l) })
  for (const l of [l1, l2, l3]) await prisma.contactEvent.create({ data: replied(l) })
  await prisma.contactEvent.create({ data: replied(l2) }) // duplicate reply for l2

  const attr = await getCampaignAttribution(campaign.id)
  assert.equal(attr.sent, 4)     // four distinct leads contacted
  assert.equal(attr.replied, 3)  // three distinct leads replied (l2's dup counts once)
  assert.equal(attr.booked, 2)   // BOOKED (l2) + CLOSED (l1)
  assert.equal(attr.won, 1)      // CLOSED (l1)
  assert.equal(attr.replyRate, 0.75) // 3/4
  assert.equal(attr.winRate, 0.25)   // 1/4
})
