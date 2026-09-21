// Database-backed tests for the Ops alerts worklist: listing/filtering and the
// review action, including the reviewedBy-is-a-user-id and idempotent-review
// properties the route deliberately gets right.

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { alertsRouter } from '../apps/api/src/routes/ops/alerts.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace, startTestServer, bearer, type TestServer } from './helpers/db.ts'

let server: TestServer
before(async () => { server = await startTestServer('/api/ops/alerts', alertsRouter) })
after(async () => { await server.close(); await disconnect() })
beforeEach(async () => { await resetDb() })

function jsonAuth(userId: string) {
  return { Authorization: bearer(userId), 'Content-Type': 'application/json' }
}

async function seedAlert(workspaceId: string, overrides: Partial<{ alertType: string; severity: string; status: string; title: string }> = {}) {
  return prisma.opsAlert.create({
    data: {
      workspaceId,
      alertType: (overrides.alertType ?? 'MISSING_HEAT_CHECK') as never,
      severity: (overrides.severity ?? 'MEDIUM') as never,
      status: (overrides.status ?? 'OPEN') as never,
      title: overrides.title ?? 'Test alert',
    },
  })
}

test('GET / lists alerts filtered by status and severity, ordered OPEN-then-severity-then-newest', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  await seedAlert(workspace.id, { severity: 'LOW', title: 'low one' })
  await seedAlert(workspace.id, { severity: 'CRITICAL', title: 'critical one' })
  await seedAlert(workspace.id, { status: 'REVIEWED', title: 'reviewed one' })

  const res = await server.request(`/api/ops/alerts?workspaceId=${workspace.id}`, { headers: { Authorization: bearer(user.id) } })
  assert.equal(res.status, 200)
  assert.equal(res.body.total, 3)
  // OPEN alerts sort before REVIEWED, and within OPEN, CRITICAL sorts before LOW.
  assert.equal(res.body.alerts[0].title, 'critical one')
  assert.equal(res.body.alerts[1].title, 'low one')
  assert.equal(res.body.alerts[2].title, 'reviewed one')

  const filtered = await server.request(`/api/ops/alerts?workspaceId=${workspace.id}&severity=CRITICAL`, { headers: { Authorization: bearer(user.id) } })
  assert.equal(filtered.body.total, 1)
})

test('GET /counts buckets both HIGH and CRITICAL into openHigh', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  await seedAlert(workspace.id, { severity: 'HIGH' })
  await seedAlert(workspace.id, { severity: 'CRITICAL' })
  await seedAlert(workspace.id, { severity: 'LOW' })
  await seedAlert(workspace.id, { severity: 'HIGH', status: 'REVIEWED' })

  const res = await server.request(`/api/ops/alerts/counts?workspaceId=${workspace.id}`, { headers: { Authorization: bearer(user.id) } })
  assert.equal(res.status, 200)
  assert.equal(res.body.open, 3)
  assert.equal(res.body.reviewed, 1)
  assert.equal(res.body.openHigh, 2, 'HIGH and CRITICAL both count toward openHigh')
})

test('POST /:id/review stamps reviewedBy with the ACTING USER\'S ID, not a display name', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const alert = await seedAlert(workspace.id)

  const res = await server.request(`/api/ops/alerts/${alert.id}/review`, {
    method: 'POST', headers: jsonAuth(user.id), body: JSON.stringify({ workspaceId: workspace.id }),
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.alert.status, 'REVIEWED')
  assert.equal(res.body.alert.reviewedBy, user.id)
  assert.notEqual(res.body.alert.reviewedBy, user.name, 'must never store the display name')
})

test('reviewing an already-reviewed alert is idempotent — does not re-stamp reviewedAt/reviewedBy', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const other = await seedUserWithWorkspace('other-reviewer@x.test')
  await prisma.membership.create({ data: { userId: other.user.id, workspaceId: workspace.id, role: 'admin' } })
  const alert = await seedAlert(workspace.id)

  const first = await server.request(`/api/ops/alerts/${alert.id}/review`, {
    method: 'POST', headers: jsonAuth(user.id), body: JSON.stringify({ workspaceId: workspace.id }),
  })
  assert.equal(first.body.alert.reviewedBy, user.id)
  const firstReviewedAt = first.body.alert.reviewedAt

  // A different admin reviews it again — must NOT overwrite the first reviewer's attribution.
  const second = await server.request(`/api/ops/alerts/${alert.id}/review`, {
    method: 'POST', headers: jsonAuth(other.user.id), body: JSON.stringify({ workspaceId: workspace.id }),
  })
  assert.equal(second.status, 200)
  assert.equal(second.body.alert.reviewedBy, user.id, 'attribution must stay with the FIRST reviewer')
  assert.equal(second.body.alert.reviewedAt, firstReviewedAt)
})

test('review requires ops:manage — a plain member is denied', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const member = await seedUserWithWorkspace(undefined, 'member')
  await prisma.membership.create({ data: { userId: member.user.id, workspaceId: workspace.id, role: 'member' } })
  const alert = await seedAlert(workspace.id)

  const res = await server.request(`/api/ops/alerts/${alert.id}/review`, {
    method: 'POST', headers: jsonAuth(member.user.id), body: JSON.stringify({ workspaceId: workspace.id }),
  })
  assert.equal(res.status, 403)

  // A plain member can still read the worklist.
  const list = await server.request(`/api/ops/alerts?workspaceId=${workspace.id}`, { headers: { Authorization: bearer(member.user.id) } })
  assert.equal(list.status, 200)
})

test('review 404s for an alert id from another workspace', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const other = await seedUserWithWorkspace('other@x.test')
  const otherAlert = await seedAlert(other.workspace.id)

  const res = await server.request(`/api/ops/alerts/${otherAlert.id}/review`, {
    method: 'POST', headers: jsonAuth(user.id), body: JSON.stringify({ workspaceId: workspace.id }),
  })
  assert.equal(res.status, 404)
})
