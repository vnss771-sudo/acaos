// Phase 1 regression: Australian-targeting self-service downgrade must fail closed.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { workspaceRouter } from '../apps/api/src/routes/workspaces/index.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace, startTestServer, bearer, type TestServer } from './helpers/db.ts'

let server: TestServer
before(async () => { server = await startTestServer('/api/workspaces', workspaceRouter) })
after(async () => { await server.close(); await disconnect() })
beforeEach(async () => { await resetDb() })

async function patch(workspaceId: string, userId: string, targetsAustralia: boolean) {
  return server.request(`/api/workspaces/${workspaceId}/compliance`, {
    method: 'PATCH',
    headers: { Authorization: bearer(userId), 'Content-Type': 'application/json' },
    body: JSON.stringify({ targetsAustralia }),
  })
}
async function fresh(userId: string) {
  await prisma.user.update({ where: { id: userId }, data: { lastReauthAt: new Date() } })
}

test('true -> false fails with 409 and does not change persisted targeting', async () => {
  const { user, workspace } = await seedUserWithWorkspace('au-lock@x.test')
  await fresh(user.id)
  await prisma.workspace.update({ where: { id: workspace.id }, data: { targetsAustralia: true } })
  const res = await patch(workspace.id, user.id, false)
  assert.equal(res.status, 409, JSON.stringify(res.body))
  assert.equal((await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } })).targetsAustralia, true)
})

test('true -> true is allowed', async () => {
  const { user, workspace } = await seedUserWithWorkspace('au-true@x.test')
  await fresh(user.id)
  await prisma.workspace.update({ where: { id: workspace.id }, data: { targetsAustralia: true } })
  const res = await patch(workspace.id, user.id, true)
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body.posture.targetsAustralia, true)
})

test('false -> true is allowed, and false -> false remains harmless', async () => {
  const { user, workspace } = await seedUserWithWorkspace('au-optin@x.test')
  await fresh(user.id)
  assert.equal((await patch(workspace.id, user.id, false)).status, 200)
  const res = await patch(workspace.id, user.id, true)
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body.posture.targetsAustralia, true)
})

test('non-admin member cannot change Australian targeting', async () => {
  const owner = await seedUserWithWorkspace('au-owner@x.test')
  const { user: member } = await seedUserWithWorkspace('au-member@x.test')
  await prisma.membership.create({ data: { userId: member.id, workspaceId: owner.workspace.id, role: 'member' } })
  await fresh(member.id)
  assert.equal((await patch(owner.workspace.id, member.id, true)).status, 403)
  assert.equal((await prisma.workspace.findUniqueOrThrow({ where: { id: owner.workspace.id } })).targetsAustralia, false)
})

test('cross-workspace attempt is denied', async () => {
  const a = await seedUserWithWorkspace('au-a@x.test')
  const b = await seedUserWithWorkspace('au-b@x.test')
  await fresh(a.user.id)
  assert.equal((await patch(b.workspace.id, a.user.id, true)).status, 403)
})
