// Database tier: GET/PUT /api/workspaces/:id/quoting-defaults, and the guarantee
// that changing a default never alters a saved quote estimate.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { workspaceRouter } from '../apps/api/src/routes/workspaces/index.ts'
import { deliveryRouter } from '../apps/api/src/routes/delivery.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace, startTestServer, bearer, type TestServer } from './helpers/db.ts'

let ws: TestServer
let delivery: TestServer
before(async () => {
  ws = await startTestServer('/api/workspaces', workspaceRouter)
  delivery = await startTestServer('/api/delivery', deliveryRouter)
})
after(async () => { await ws.close(); await delivery.close(); await disconnect() })
beforeEach(async () => { await resetDb() })

const call = (s: TestServer, userId: string, method: string, path: string, body?: unknown) =>
  s.request(path, { method, headers: { Authorization: bearer(userId), 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
const getDefaults = (userId: string, workspaceId: string) => call(ws, userId, 'GET', `/api/workspaces/${workspaceId}/quoting-defaults`)
const putDefaults = (userId: string, workspaceId: string, body: unknown) => call(ws, userId, 'PUT', `/api/workspaces/${workspaceId}/quoting-defaults`, body)
const UNSET = { defaultOnCostPct: null, defaultOverheadPct: null, defaultTargetMarginPct: null }

test('a workspace starts with no defaults; set, explicit zero and clearing round-trip; each change is audited', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const first = await getDefaults(user.id, workspace.id)
  assert.equal(first.status, 200, JSON.stringify(first.body))
  assert.deepEqual(first.body.defaults, UNSET, 'NULL, never 0, until someone sets them')

  const set = await putDefaults(user.id, workspace.id, { defaultOnCostPct: 22.5, defaultOverheadPct: 0, defaultTargetMarginPct: 25 })
  assert.equal(set.status, 200, JSON.stringify(set.body))
  assert.deepEqual((await getDefaults(user.id, workspace.id)).body.defaults, { defaultOnCostPct: 22.5, defaultOverheadPct: 0, defaultTargetMarginPct: 25 }, 'an explicit 0 stays 0')

  await putDefaults(user.id, workspace.id, { defaultOnCostPct: 22.5, defaultOverheadPct: null, defaultTargetMarginPct: 25 })
  assert.equal((await getDefaults(user.id, workspace.id)).body.defaults.defaultOverheadPct, null, 'null clears a default')

  const audits = await prisma.auditEvent.findMany({ where: { workspaceId: workspace.id, type: 'workspace.quoting_defaults' }, orderBy: { createdAt: 'asc' } }) as Array<{ metadata: { from: unknown; to: unknown } }>
  assert.equal(audits.length, 2)
  assert.deepEqual(audits[0].metadata.from, UNSET)
  assert.deepEqual(audits[1].metadata.to, { defaultOnCostPct: 22.5, defaultOverheadPct: null, defaultTargetMarginPct: 25 })
})

test('the server validates ranges and shape; the database CHECKs back it up', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const ok = { defaultOnCostPct: 20, defaultOverheadPct: 10, defaultTargetMarginPct: 25 }
  for (const bad of [
    { ...ok, defaultTargetMarginPct: 96 },          // a gross margin near 100 % is impossible
    { ...ok, defaultOnCostPct: 201 },
    { ...ok, defaultOverheadPct: -1 },
    { ...ok, defaultOnCostPct: '20' },
    { defaultOnCostPct: 20, defaultOverheadPct: 10 }, // every field is required: null means unset
    { ...ok, defaultLabourRate: 55 },                 // strict: no unknown fields
  ]) {
    assert.equal((await putDefaults(user.id, workspace.id, bad)).status, 400, JSON.stringify(bad))
  }
  assert.deepEqual((await getDefaults(user.id, workspace.id)).body.defaults, UNSET, 'nothing invalid was stored')
  assert.equal((await putDefaults(user.id, workspace.id, { defaultOnCostPct: 200, defaultOverheadPct: 200, defaultTargetMarginPct: 95 })).status, 200, 'the limits themselves are allowed')
  await assert.rejects(prisma.workspace.update({ where: { id: workspace.id }, data: { defaultTargetMarginPct: 99 } }), /Workspace_defaultTargetMarginPct_range/)
})

test('admin-only and workspace-scoped', async () => {
  const { user: owner, workspace } = await seedUserWithWorkspace()
  await putDefaults(owner.id, workspace.id, { defaultOnCostPct: 20, defaultOverheadPct: 10, defaultTargetMarginPct: 25 })
  const member = await seedUserWithWorkspace()
  await prisma.membership.create({ data: { userId: member.user.id, workspaceId: workspace.id, role: 'member' } })
  const admin = await seedUserWithWorkspace()
  await prisma.membership.create({ data: { userId: admin.user.id, workspaceId: workspace.id, role: 'admin' } })
  const other = await seedUserWithWorkspace()

  assert.equal((await getDefaults(member.user.id, workspace.id)).status, 403, 'a member cannot read margins policy')
  assert.equal((await putDefaults(member.user.id, workspace.id, UNSET)).status, 403)
  assert.equal((await getDefaults(other.user.id, workspace.id)).status, 403, 'another workspace\'s owner cannot read it')
  assert.equal((await putDefaults(other.user.id, workspace.id, UNSET)).status, 403, 'or change it')
  assert.equal((await getDefaults(admin.user.id, workspace.id)).status, 200, 'an admin of this workspace can')
  // Another workspace's defaults are its own.
  assert.deepEqual((await getDefaults(other.user.id, other.workspace.id)).body.defaults, UNSET)
  assert.deepEqual((await getDefaults(owner.id, workspace.id)).body.defaults, { defaultOnCostPct: 20, defaultOverheadPct: 10, defaultTargetMarginPct: 25 })
})

test('changing defaults never alters a saved estimate, and the server never applies defaults on its own', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  await putDefaults(user.id, workspace.id, { defaultOnCostPct: 20, defaultOverheadPct: 10, defaultTargetMarginPct: 25 })
  const opp = await prisma.opportunity.create({
    data: { workspaceId: workspace.id, source: 'planningalerts', externalId: 'QD1', kind: 'DEVELOPMENT_APPLICATION', title: 'Fit-out', score: 70, matchedTrades: ['electrical'], reasons: [], contentHash: 'qd1', status: 'PURSUING' },
  })
  const inputs = { labourHours: 100, labourRate: 50, onCostPct: 20, materialsCents: 300_000, subcontractCents: 0, overheadPct: 10, targetMarginPct: 25 }
  const created = await call(delivery, user.id, 'POST', '/api/delivery/quotes', { workspaceId: workspace.id, opportunityId: opp.id, amountCents: 1_500_000, estimatedHours: 100, estimate: inputs, submit: true })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const before = await prisma.quote.findUnique({ where: { id: created.body.quote.id } }) as { amountCents: number; estimate: unknown; updatedAt: Date }

  await putDefaults(user.id, workspace.id, { defaultOnCostPct: 35, defaultOverheadPct: 18, defaultTargetMarginPct: 30 })
  await putDefaults(user.id, workspace.id, UNSET)
  const after = await prisma.quote.findUnique({ where: { id: created.body.quote.id } }) as typeof before
  assert.deepEqual(after.estimate, before.estimate, 'the stored snapshot is byte-for-byte the same')
  assert.equal(after.amountCents, before.amountCents)
  assert.equal(after.updatedAt.getTime(), before.updatedAt.getTime(), 'the quote row was not written at all')

  // Defaults are a UI starting point only: a preview with on-costs left blank is base pay only, whatever the defaults say.
  await putDefaults(user.id, workspace.id, { defaultOnCostPct: 35, defaultOverheadPct: 18, defaultTargetMarginPct: 30 })
  const preview = await call(delivery, user.id, 'POST', '/api/delivery/estimate', { workspaceId: workspace.id, priceCents: 1_500_000, inputs: { ...inputs, onCostPct: null, overheadPct: null, targetMarginPct: null } })
  assert.equal(preview.status, 200, JSON.stringify(preview.body))
  assert.equal(preview.body.estimate.labourCostCents, 500_000)
  assert.equal(preview.body.estimate.labourIncludesOnCosts, false)
  assert.equal(preview.body.estimate.overheadCents, null)
})
