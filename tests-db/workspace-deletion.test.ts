// Database-backed tests for irreversible workspace erasure (GDPR Art. 17).
// Verifies: owner-only + step-up + typed-name confirmation; that EVERY workspace-
// scoped table is emptied (both the cascade tables and the decoupled AuditEvent /
// ScoringOutcome that need explicit deletion); that the user survives; that a live
// subscription blocks deletion; and that another tenant's data is untouched.

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { workspaceRouter } from '../apps/api/src/routes/workspaces/index.ts'
import {
  prisma, resetDb, disconnect, seedUserWithWorkspace, seedWorkspace,
  startTestServer, bearer, type TestServer,
} from './helpers/db.ts'

let server: TestServer
before(async () => { server = await startTestServer('/api/workspaces', workspaceRouter) })
after(async () => { await server.close(); await disconnect() })
beforeEach(async () => { await resetDb() })

// `auth` is the full header value from bearer() (already "Bearer <jwt>").
const del = (id: string, body: unknown, auth: string) =>
  server.request(`/api/workspaces/${id}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', Authorization: auth },
    body: JSON.stringify(body),
  })

// Step-up (requireFreshAuth) reads lastReauthAt — make it fresh.
async function freshAuth(userId: string) {
  await prisma.user.update({ where: { id: userId }, data: { lastReauthAt: new Date() } })
}

// Seed a representative spread of tenant data, including both decoupled tables.
async function seedTenantData(workspaceId: string) {
  const lead = await prisma.lead.create({ data: { workspaceId, businessName: 'Acme Co' } })
  const campaign = await prisma.campaign.create({ data: { workspaceId, name: 'Q3 Outbound', goalType: 'BOOK_MEETINGS' } })
  await prisma.outreachDraft.create({ data: { leadId: lead.id, workspaceId, subject: 's', emailBody: 'b' } })
  await prisma.usageRecord.create({ data: { workspaceId, action: 'AI_RESEARCH', month: '2026-06', count: 5 } })
  await prisma.suppression.create({ data: { workspaceId, email: 'x@y.test', emailKey: 'x@y.test' } })
  await prisma.auditEvent.create({ data: { workspaceId, type: 'lead.created', entityId: lead.id } })
  const model = await prisma.scoringModel.create({ data: { workspaceId, weights: {}, performanceMetrics: {} } })
  await prisma.scoringOutcome.create({ data: { workspaceId, scoringModelId: model.id, score: 50, replied: false } })
  return { leadId: lead.id, campaignId: campaign.id }
}

async function tenantRowCounts(workspaceId: string) {
  const [leads, campaigns, drafts, usage, suppressions, audits, models, outcomes, memberships, workspace] = await Promise.all([
    prisma.lead.count({ where: { workspaceId } }),
    prisma.campaign.count({ where: { workspaceId } }),
    prisma.outreachDraft.count({ where: { workspaceId } }),
    prisma.usageRecord.count({ where: { workspaceId } }),
    prisma.suppression.count({ where: { workspaceId } }),
    prisma.auditEvent.count({ where: { workspaceId } }),
    prisma.scoringModel.count({ where: { workspaceId } }),
    prisma.scoringOutcome.count({ where: { workspaceId } }),
    prisma.membership.count({ where: { workspaceId } }),
    prisma.workspace.findUnique({ where: { id: workspaceId } }),
  ])
  return { leads, campaigns, drafts, usage, suppressions, audits, models, outcomes, memberships, workspace }
}

test('owner erases the workspace: every tenant table is emptied, the user survives', async () => {
  const { user, workspace } = await seedUserWithWorkspace('owner@x.test')
  await freshAuth(user.id)
  await seedTenantData(workspace.id)

  const before = await tenantRowCounts(workspace.id)
  assert.ok(before.leads === 1 && before.audits === 1 && before.outcomes === 1 && before.workspace, 'data seeded')

  const res = await del(workspace.id, { confirmName: workspace.name }, bearer(user.id))
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body.deleted, true)

  const after = await tenantRowCounts(workspace.id)
  for (const [k, v] of Object.entries(after)) {
    if (k === 'workspace') assert.equal(v, null, 'workspace row deleted')
    else assert.equal(v, 0, `${k} must be 0 after erasure (got ${v})`)
  }
  // The user account itself is NOT deleted (it may belong to other workspaces).
  assert.ok(await prisma.user.findUnique({ where: { id: user.id } }), 'user survives workspace deletion')
  // A global audit record (workspaceId: null) survives the erasure.
  const audit = await prisma.auditEvent.findFirst({ where: { type: 'workspace.deleted', entityId: workspace.id } })
  assert.ok(audit && audit.workspaceId === null, 'global workspace.deleted audit recorded')
})

test('a wrong confirmName is rejected (typed-confirmation guard)', async () => {
  const { user, workspace } = await seedUserWithWorkspace('owner2@x.test')
  await freshAuth(user.id)
  const res = await del(workspace.id, { confirmName: 'not the name' }, bearer(user.id))
  assert.equal(res.status, 400)
  assert.ok(await prisma.workspace.findUnique({ where: { id: workspace.id } }), 'workspace NOT deleted')
})

test('a non-owner (admin/member) cannot erase the workspace', async () => {
  const { user: owner, workspace } = await seedUserWithWorkspace('owner3@x.test')
  const { user: admin } = await seedUserWithWorkspace('admin3@x.test')
  // Add admin as an ADMIN member of the owner's workspace.
  await prisma.membership.create({ data: { userId: admin.id, workspaceId: workspace.id, role: 'admin' } })
  await freshAuth(admin.id)
  const res = await del(workspace.id, { confirmName: workspace.name }, bearer(admin.id))
  assert.equal(res.status, 403)
  assert.ok(await prisma.workspace.findUnique({ where: { id: workspace.id } }), 'workspace NOT deleted')
})

test('a live Stripe subscription blocks deletion (no orphaned billing)', async () => {
  const { user, workspace } = await seedUserWithWorkspace('owner4@x.test')
  await freshAuth(user.id)
  await prisma.workspace.update({ where: { id: workspace.id }, data: { stripeSubscriptionId: 'sub_live', subscriptionStatus: 'active' } })
  const res = await del(workspace.id, { confirmName: workspace.name }, bearer(user.id))
  assert.equal(res.status, 409)
  assert.ok(await prisma.workspace.findUnique({ where: { id: workspace.id } }), 'workspace NOT deleted')
})

test('erasure is tenant-scoped: another workspace is untouched', async () => {
  const { user, workspace } = await seedUserWithWorkspace('owner5@x.test')
  await freshAuth(user.id)
  await seedTenantData(workspace.id)
  // A second workspace owned by the same user, with its own data.
  const other = await seedWorkspace(user.id, { role: 'owner' })
  await seedTenantData(other.id)

  const res = await del(workspace.id, { confirmName: workspace.name }, bearer(user.id))
  assert.equal(res.status, 200, JSON.stringify(res.body))

  const otherCounts = await tenantRowCounts(other.id)
  assert.ok(otherCounts.workspace && otherCounts.leads === 1 && otherCounts.audits === 1 && otherCounts.outcomes === 1,
    'the other workspace and its data are intact')
})
