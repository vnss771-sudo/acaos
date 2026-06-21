// Database-backed tests: workspace-scoped mutations write an AuditEvent row.
//
// A review council flagged that audit logging was opt-in and missing from most
// data-mutating endpoints. These tests drive a mutation through each router and
// assert a correctly-scoped AuditEvent (type + entityId + workspaceId + actor)
// was recorded. Auditing is fire-and-forget (`void recordAudit(...)`), so we
// poll briefly for the row rather than assuming it lands before the response.

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { leadsRouter } from '../apps/api/src/routes/leads.ts'
import { campaignsRouter } from '../apps/api/src/routes/campaigns.ts'
import { prospectsRouter } from '../apps/api/src/routes/prospects/index.ts'
import { workspaceRouter } from '../apps/api/src/routes/workspaces.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace, startTestServer, bearer, type TestServer } from './helpers/db.ts'

let leads: TestServer
let campaigns: TestServer
let prospects: TestServer
let workspaces: TestServer

before(async () => {
  leads = await startTestServer('/api/leads', leadsRouter)
  campaigns = await startTestServer('/api/campaigns', campaignsRouter)
  prospects = await startTestServer('/api/prospects', prospectsRouter)
  workspaces = await startTestServer('/api/workspaces', workspaceRouter)
})
after(async () => {
  await Promise.all([leads.close(), campaigns.close(), prospects.close(), workspaces.close()])
  await disconnect()
})
beforeEach(async () => { await resetDb() })

// Audit writes are fire-and-forget, so the row may land just after the HTTP
// response. Poll briefly for the first matching event.
async function waitForAudit(where: Record<string, unknown>) {
  for (let i = 0; i < 50; i++) {
    const ev = await prisma.auditEvent.findFirst({ where, orderBy: { createdAt: 'desc' } })
    if (ev) return ev
    await new Promise((r) => setTimeout(r, 20))
  }
  return null
}

test('creating a lead writes a lead.created audit event', async () => {
  const { user, workspace } = await seedUserWithWorkspace()

  const res = await leads.request('/api/leads', {
    method: 'POST',
    headers: { Authorization: bearer(user.id), 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceId: workspace.id, businessName: 'Acme Co' }),
  })
  assert.equal(res.status, 201)
  const leadId = res.body.lead.id as string

  const ev = await waitForAudit({ type: 'lead.created', entityId: leadId })
  assert.ok(ev, 'expected a lead.created audit event')
  assert.equal(ev!.workspaceId, workspace.id)
  assert.equal(ev!.actorUserId, user.id)
  assert.equal(ev!.entityType, 'lead')
})

test('deleting a lead writes a lead.deleted audit event', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const lead = await prisma.lead.create({ data: { workspaceId: workspace.id, businessName: 'Doomed' } })

  const res = await leads.request(`/api/leads/${lead.id}`, {
    method: 'DELETE',
    headers: { Authorization: bearer(user.id) },
  })
  assert.equal(res.status, 200)

  const ev = await waitForAudit({ type: 'lead.deleted', entityId: lead.id })
  assert.ok(ev, 'expected a lead.deleted audit event')
  assert.equal(ev!.workspaceId, workspace.id)
  assert.equal(ev!.actorUserId, user.id)
})

test('creating a campaign writes a campaign.created audit event', async () => {
  const { user, workspace } = await seedUserWithWorkspace()

  const res = await campaigns.request('/api/campaigns', {
    method: 'POST',
    headers: { Authorization: bearer(user.id), 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceId: workspace.id, name: 'Q3 Outbound' }),
  })
  assert.equal(res.status, 201)
  const campaignId = res.body.campaign.id as string

  const ev = await waitForAudit({ type: 'campaign.created', entityId: campaignId })
  assert.ok(ev, 'expected a campaign.created audit event')
  assert.equal(ev!.workspaceId, workspace.id)
  assert.equal(ev!.actorUserId, user.id)
  assert.equal(ev!.entityType, 'campaign')
})

test('creating a prospect writes a prospect.created audit event', async () => {
  const { user, workspace } = await seedUserWithWorkspace()

  const res = await prospects.request('/api/prospects', {
    method: 'POST',
    headers: { Authorization: bearer(user.id), 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceId: workspace.id, companyName: 'Globex' }),
  })
  assert.equal(res.status, 201)
  const prospectId = res.body.id as string

  const ev = await waitForAudit({ type: 'prospect.created', entityId: prospectId })
  assert.ok(ev, 'expected a prospect.created audit event')
  assert.equal(ev!.workspaceId, workspace.id)
  assert.equal(ev!.actorUserId, user.id)
  assert.equal(ev!.entityType, 'prospect')
})

test('updating workspace settings writes a workspace.updated audit event', async () => {
  const { user, workspace } = await seedUserWithWorkspace()

  const res = await workspaces.request(`/api/workspaces/${workspace.id}`, {
    method: 'PATCH',
    headers: { Authorization: bearer(user.id), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Renamed Workspace' }),
  })
  assert.equal(res.status, 200)

  const ev = await waitForAudit({ type: 'workspace.updated', entityId: workspace.id })
  assert.ok(ev, 'expected a workspace.updated audit event')
  assert.equal(ev!.workspaceId, workspace.id)
  assert.equal(ev!.actorUserId, user.id)
  assert.equal(ev!.entityType, 'workspace')
  // The settings change logs only which fields changed, never the values.
  assert.deepEqual((ev!.metadata as { fields?: string[] }).fields, ['name'])
})
