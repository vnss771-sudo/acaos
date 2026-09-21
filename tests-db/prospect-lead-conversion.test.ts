// Database-backed tests for POST /api/prospects/:id/convert-to-lead — the fix
// for Phase 0.4 (Lead vs Prospect have no visible relationship, no conversion
// path). Verifies the created Lead's fields, the 1:1 link back on the
// Prospect, and that a second conversion attempt is rejected rather than
// creating a duplicate Lead.

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { prospectsRouter } from '../apps/api/src/routes/prospects.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace, startTestServer, bearer, type TestServer } from './helpers/db.ts'

let prospects: TestServer
before(async () => { prospects = await startTestServer('/api/prospects', prospectsRouter) })
after(async () => { await prospects.close(); await disconnect() })
beforeEach(async () => { await resetDb() })

function jsonAuth(userId: string) {
  return { Authorization: bearer(userId), 'Content-Type': 'application/json' }
}

test('converts a prospect into a lead carrying its company/contact fields, and links the two records', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const p = await prisma.prospect.create({
    data: {
      workspaceId: workspace.id, companyName: 'Acme Corp', domain: 'acme.test',
      industry: 'HVAC', location: 'Austin, TX',
      contactName: 'Jane Doe', contactEmail: 'Jane@Acme.TEST', contactPhone: '555-1212',
      notes: 'Met at a trade show', aiSummary: 'Growing HVAC operator', sourceTag: 'apollo',
    },
  })

  const res = await prospects.request(`/api/prospects/${p.id}/convert-to-lead`, {
    method: 'POST', headers: jsonAuth(user.id), body: JSON.stringify({}),
  })
  assert.equal(res.status, 201)
  assert.equal(res.body.lead.businessName, 'Acme Corp')
  assert.equal(res.body.lead.contactName, 'Jane Doe')
  // Email is normalized (lowercased) exactly like the plain lead-create route.
  assert.equal(res.body.lead.email, 'jane@acme.test')
  assert.equal(res.body.lead.phone, '555-1212')
  assert.equal(res.body.lead.website, 'acme.test')
  assert.equal(res.body.lead.city, 'Austin, TX')
  assert.equal(res.body.lead.category, 'HVAC')
  assert.equal(res.body.lead.notes, 'Met at a trade show')
  assert.equal(res.body.lead.sourceTag, 'apollo')
  assert.equal(res.body.lead.stage, 'NEW')

  // The prospect side of the link is set too.
  assert.equal(res.body.prospect.convertedLeadId, res.body.lead.id)
  assert.ok(res.body.prospect.convertedAt)

  const storedLead = await prisma.lead.findUnique({ where: { id: res.body.lead.id } })
  assert.ok(storedLead)
  const storedProspect = await prisma.prospect.findUnique({ where: { id: p.id } })
  assert.equal(storedProspect!.convertedLeadId, res.body.lead.id)
})

test('a prospect can only be converted once — a second attempt 409s without creating a duplicate lead', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const p = await prisma.prospect.create({ data: { workspaceId: workspace.id, companyName: 'Acme Corp' } })

  const first = await prospects.request(`/api/prospects/${p.id}/convert-to-lead`, {
    method: 'POST', headers: jsonAuth(user.id), body: JSON.stringify({}),
  })
  assert.equal(first.status, 201)

  const second = await prospects.request(`/api/prospects/${p.id}/convert-to-lead`, {
    method: 'POST', headers: jsonAuth(user.id), body: JSON.stringify({}),
  })
  assert.equal(second.status, 409)

  const leadCount = await prisma.lead.count({ where: { workspaceId: workspace.id } })
  assert.equal(leadCount, 1, 'only the first conversion should have created a lead')
})

test('convert-to-lead denies (403) a caller who is not a member of the prospect\'s workspace', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const other = await seedUserWithWorkspace('other@x.test')
  const p = await prisma.prospect.create({ data: { workspaceId: other.workspace.id, companyName: 'Other Co' } })

  const res = await prospects.request(`/api/prospects/${p.id}/convert-to-lead`, {
    method: 'POST', headers: jsonAuth(user.id), body: JSON.stringify({}),
  })
  assert.equal(res.status, 403)
  assert.equal(await prisma.lead.count({ where: { workspaceId: workspace.id } }), 0)
})

test('convert-to-lead 404s for an unknown prospect id', async () => {
  const { user } = await seedUserWithWorkspace()
  const res = await prospects.request('/api/prospects/doesnotexist/convert-to-lead', {
    method: 'POST', headers: jsonAuth(user.id), body: JSON.stringify({}),
  })
  assert.equal(res.status, 404)
})

test('convert-to-lead is blocked at the workspace lead cap, same as a plain lead create', async () => {
  const { user, workspace } = await seedUserWithWorkspace(undefined, 'owner', {})
  // Free plan cap is 500 leads — seed exactly that many so the next create is blocked.
  await prisma.workspace.update({ where: { id: workspace.id }, data: { plan: 'free' } })
  const rows = Array.from({ length: 500 }, (_, i) => ({ workspaceId: workspace.id, businessName: `Lead ${i}` }))
  await prisma.lead.createMany({ data: rows })

  const p = await prisma.prospect.create({ data: { workspaceId: workspace.id, companyName: 'Acme Corp' } })
  const res = await prospects.request(`/api/prospects/${p.id}/convert-to-lead`, {
    method: 'POST', headers: jsonAuth(user.id), body: JSON.stringify({}),
  })
  assert.equal(res.status, 429)
  assert.equal(await prisma.prospect.findUnique({ where: { id: p.id } }).then(r => r!.convertedLeadId), null)
})
