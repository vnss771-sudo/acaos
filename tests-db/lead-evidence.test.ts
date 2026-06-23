// Database-backed tests for the LeadEvidenceSource relational provenance store:
// idempotent replace, tenant scoping, and FK cascade on lead delete.

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { replaceLeadEvidence } from '../packages/backend-core/src/lib/leadEvidence.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace } from './helpers/db.ts'

before(async () => { await resetDb() })
after(async () => { await disconnect() })
beforeEach(async () => { await resetDb() })

async function seedLead(workspaceId: string) {
  return prisma.lead.create({ data: { workspaceId, businessName: 'Acme Plumbing' } })
}

test('replaceLeadEvidence: inserts rows scoped to the lead/workspace', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const lead = await seedLead(workspace.id)

  const n = await replaceLeadEvidence(prisma, {
    workspaceId: workspace.id,
    leadId: lead.id,
    evidence: [
      { signal: 'Website lists 4 service areas', type: 'confirmed', confidence: 'high', sourceUrl: 'https://acme.example' },
      { signal: 'Likely dispatch complexity', type: 'inferred', confidence: 'medium' },
    ],
  })
  assert.equal(n, 2)

  const rows = await prisma.leadEvidenceSource.findMany({ where: { leadId: lead.id }, orderBy: { evidenceType: 'asc' } })
  assert.equal(rows.length, 2)
  assert.ok(rows.every((r) => r.workspaceId === workspace.id && r.leadId === lead.id))
  const confirmed = rows.find((r) => r.evidenceType === 'confirmed')!
  assert.equal(confirmed.sourceUrl, 'https://acme.example')
  assert.equal(confirmed.sourceType, 'website')
})

test('replaceLeadEvidence: is idempotent — a re-run replaces the prior rows', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const lead = await seedLead(workspace.id)

  await replaceLeadEvidence(prisma, {
    workspaceId: workspace.id, leadId: lead.id,
    evidence: [{ signal: 'first pass', type: 'observed', confidence: 'low' }],
  })
  await replaceLeadEvidence(prisma, {
    workspaceId: workspace.id, leadId: lead.id,
    evidence: [
      { signal: 'second pass A', type: 'observed', confidence: 'medium' },
      { signal: 'second pass B', type: 'inferred', confidence: 'low' },
    ],
  })

  const rows = await prisma.leadEvidenceSource.findMany({ where: { leadId: lead.id } })
  assert.equal(rows.length, 2)
  assert.ok(!rows.some((r) => r.signal === 'first pass'), 'stale rows from the first pass must be gone')
})

test('replaceLeadEvidence: empty evidence clears existing rows', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const lead = await seedLead(workspace.id)
  await replaceLeadEvidence(prisma, {
    workspaceId: workspace.id, leadId: lead.id,
    evidence: [{ signal: 'to be cleared', type: 'observed', confidence: 'low' }],
  })
  const n = await replaceLeadEvidence(prisma, { workspaceId: workspace.id, leadId: lead.id, evidence: [] })
  assert.equal(n, 0)
  assert.equal(await prisma.leadEvidenceSource.count({ where: { leadId: lead.id } }), 0)
})

test('deleting the lead cascades to its evidence rows', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const lead = await seedLead(workspace.id)
  await replaceLeadEvidence(prisma, {
    workspaceId: workspace.id, leadId: lead.id,
    evidence: [{ signal: 'cascade me', type: 'confirmed', confidence: 'high', sourceUrl: 'https://x.example' }],
  })
  assert.equal(await prisma.leadEvidenceSource.count({ where: { leadId: lead.id } }), 1)

  await prisma.lead.delete({ where: { id: lead.id } })
  assert.equal(await prisma.leadEvidenceSource.count({ where: { leadId: lead.id } }), 0)
})
