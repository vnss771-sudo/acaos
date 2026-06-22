// DB-tier test: promptVersionQuality aggregates draft outcomes per prompt version.

import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { promptVersionQuality } from '../packages/backend-core/src/lib/promptQuality.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace } from './helpers/db.ts'

after(async () => { await disconnect() })
beforeEach(async () => { await resetDb() })

async function seedVersion(workspaceId: string, version: number, model: string) {
  return prisma.aiPromptVersion.create({
    data: { workspaceId, type: 'OUTREACH', version, promptHash: `h${version}`, model, isActive: true },
  })
}
async function seedDraft(workspaceId: string, promptVersionId: string, status: string) {
  const lead = await prisma.lead.create({ data: { workspaceId, businessName: 'B', email: `l${Math.random()}@x.test`, stage: 'NEW' } })
  await prisma.outreachDraft.create({ data: { leadId: lead.id, workspaceId, subject: 'Hi', emailBody: 'Hello there', status: status as never, promptVersionId } })
}

test('aggregates approval/rejection/policy-review rates per prompt version, newest first', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const v1 = await seedVersion(workspace.id, 1, 'gpt-4o-mini')
  const v2 = await seedVersion(workspace.id, 2, 'gpt-4o')

  // v1: 3 approved, 1 rejected, 1 policy-review (5 total).
  for (const s of ['APPROVED', 'APPROVED', 'APPROVED', 'REJECTED', 'POLICY_REVIEW']) await seedDraft(workspace.id, v1.id, s)
  // v2: 1 sent, 3 rejected (4 total).
  for (const s of ['SENT', 'REJECTED', 'REJECTED', 'REJECTED']) await seedDraft(workspace.id, v2.id, s)

  const out = await promptVersionQuality(workspace.id)
  assert.equal(out.length, 2)
  // Newest version first.
  assert.equal(out[0].version, 2)
  assert.equal(out[1].version, 1)

  const q1 = out.find(o => o.version === 1)!
  assert.equal(q1.total, 5)
  assert.equal(q1.approvalRate, 0.75) // 3 kept / 4 reviewed
  assert.equal(q1.rejectionRate, 0.25)
  assert.equal(q1.policyReviewRate, 0.2) // 1/5
  assert.equal(q1.model, 'gpt-4o-mini')

  const q2 = out.find(o => o.version === 2)!
  assert.equal(q2.approvalRate, 0.25) // 1 kept / 4 reviewed
  assert.equal(q2.rejectionRate, 0.75)
  assert.equal(q2.model, 'gpt-4o')
})

test('drafts without provenance are excluded', async () => {
  const { workspace } = await seedUserWithWorkspace()
  // A draft with no promptVersionId.
  const lead = await prisma.lead.create({ data: { workspaceId: workspace.id, businessName: 'B', email: 'n@x.test', stage: 'NEW' } })
  await prisma.outreachDraft.create({ data: { leadId: lead.id, workspaceId: workspace.id, subject: 'Hi', emailBody: 'Hello there', status: 'APPROVED' } })

  const out = await promptVersionQuality(workspace.id)
  assert.equal(out.length, 0)
})
