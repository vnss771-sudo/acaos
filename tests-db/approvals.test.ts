// Database-backed tests for the draft approval queue: listing, editing copy
// before approval (DRAFTED-only), and approve/reject with audit recording.

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { leadsRouter } from '../apps/api/src/routes/leads.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace, startTestServer, bearer, type TestServer } from './helpers/db.ts'

let server: TestServer
before(async () => { server = await startTestServer('/api/leads', leadsRouter) })
after(async () => { await server.close(); await disconnect() })
beforeEach(async () => { await resetDb() })

async function seedDraft(workspaceId: string, status = 'DRAFTED') {
  const lead = await prisma.lead.create({ data: { workspaceId, businessName: 'Acme', email: 'a@acme.test' } })
  const draft = await prisma.outreachDraft.create({
    data: { workspaceId, leadId: lead.id, subject: 'Hi', emailBody: 'Original body', status },
  })
  return { lead, draft }
}

test('GET /approvals/pending lists DRAFTED drafts with lead context', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  await seedDraft(workspace.id, 'DRAFTED')
  await seedDraft(workspace.id, 'APPROVED') // should not appear

  const res = await server.request(`/api/leads/approvals/pending?workspaceId=${workspace.id}`, { headers: { Authorization: bearer(user.id) } })
  assert.equal(res.status, 200)
  assert.equal(res.body.drafts.length, 1)
  assert.equal(res.body.drafts[0].lead.businessName, 'Acme')
})

test('PATCH edits a DRAFTED draft body/subject', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const { lead, draft } = await seedDraft(workspace.id)
  const res = await server.request(`/api/leads/${lead.id}/drafts/${draft.id}`, {
    method: 'PATCH',
    headers: { Authorization: bearer(user.id), 'Content-Type': 'application/json' },
    body: JSON.stringify({ subject: 'Edited', emailBody: 'New body' }),
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.draft.subject, 'Edited')
  assert.equal(res.body.draft.emailBody, 'New body')
})

test('PATCH refuses to edit a non-DRAFTED draft (409)', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const { lead, draft } = await seedDraft(workspace.id, 'APPROVED')
  const res = await server.request(`/api/leads/${lead.id}/drafts/${draft.id}`, {
    method: 'PATCH',
    headers: { Authorization: bearer(user.id), 'Content-Type': 'application/json' },
    body: JSON.stringify({ subject: 'nope' }),
  })
  assert.equal(res.status, 409)
})

test('POST approve sets APPROVED and records an audit event', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const { lead, draft } = await seedDraft(workspace.id)
  const res = await server.request(`/api/leads/${lead.id}/drafts/${draft.id}/approve`, {
    method: 'POST', headers: { Authorization: bearer(user.id) },
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.draft.status, 'APPROVED')

  // Audit is fire-and-forget; poll briefly so the assertion isn't racy.
  let audit = null
  for (let i = 0; i < 20 && !audit; i++) {
    audit = await prisma.auditEvent.findFirst({ where: { type: 'draft.approve', entityId: draft.id } })
    if (!audit) await new Promise(r => setTimeout(r, 25))
  }
  assert.ok(audit, 'approve should record an audit event')
})
