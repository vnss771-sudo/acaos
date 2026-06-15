// Database-backed tests for first-class Missions: creating a mission also creates
// its linked execution campaign, and status transitions/listing/auth work.

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { missionsRouter } from '../apps/api/src/routes/missions.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace, startTestServer, bearer, type TestServer } from './helpers/db.ts'

let server: TestServer
before(async () => { server = await startTestServer('/api/missions', missionsRouter) })
after(async () => { await server.close(); await disconnect() })
beforeEach(async () => { await resetDb() })

function jsonAuth(userId: string) {
  return { Authorization: bearer(userId), 'Content-Type': 'application/json' }
}

test('POST /missions creates a mission AND its linked campaign', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const res = await server.request('/api/missions', {
    method: 'POST',
    headers: jsonAuth(user.id),
    body: JSON.stringify({ workspaceId: workspace.id, name: 'Q3 Push', goalType: 'BOOK_CALL', targetCustomer: 'plumbers', offer: 'lead gen' }),
  })
  assert.equal(res.status, 201)
  assert.equal(res.body.mission.name, 'Q3 Push')
  assert.equal(res.body.mission.status, 'ACTIVE')
  assert.ok(res.body.mission.campaignId, 'mission should link a campaign')
  assert.equal(res.body.campaign.id, res.body.mission.campaignId)

  // The linked campaign actually exists and carries target/offer in its description.
  const campaign = await prisma.campaign.findUnique({ where: { id: res.body.mission.campaignId } })
  assert.ok(campaign)
  assert.match(campaign!.description ?? '', /plumbers/)
})

test('GET /missions lists workspace missions with campaign lead counts', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  await server.request('/api/missions', {
    method: 'POST', headers: jsonAuth(user.id),
    body: JSON.stringify({ workspaceId: workspace.id, name: 'M1', goalType: 'GET_REPLY' }),
  })
  const res = await server.request(`/api/missions?workspaceId=${workspace.id}`, { headers: { Authorization: bearer(user.id) } })
  assert.equal(res.status, 200)
  assert.equal(res.body.missions.length, 1)
  assert.equal(res.body.missions[0].campaign._count.leads, 0)
})

test('GET /missions includes per-mission deliverability stats from the linked campaign', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const created = await server.request('/api/missions', {
    method: 'POST', headers: jsonAuth(user.id),
    body: JSON.stringify({ workspaceId: workspace.id, name: 'M', goalType: 'BOOK_CALL' }),
  })
  const campaignId = created.body.mission.campaignId as string
  for (const status of ['SENT', 'REPLIED', 'BOUNCED', 'FAILED']) {
    await prisma.outreachSent.create({
      data: { workspaceId: workspace.id, campaignId, toEmail: `${status}@x.test`, subject: 's', body: 'b', status },
    })
  }

  const res = await server.request(`/api/missions?workspaceId=${workspace.id}`, { headers: { Authorization: bearer(user.id) } })
  const stats = res.body.missions[0].stats
  assert.equal(stats.sent, 3)   // SENT + REPLIED + BOUNCED (delivered)
  assert.equal(stats.replied, 1)
  assert.equal(stats.failed, 1)
  assert.equal(stats.bounced, 1)
})

test('PATCH /missions/:id updates status', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const created = await server.request('/api/missions', {
    method: 'POST', headers: jsonAuth(user.id),
    body: JSON.stringify({ workspaceId: workspace.id, name: 'M', goalType: 'BOOK_CALL' }),
  })
  const id = created.body.mission.id
  const res = await server.request(`/api/missions/${id}`, { method: 'PATCH', headers: jsonAuth(user.id), body: JSON.stringify({ status: 'PAUSED' }) })
  assert.equal(res.status, 200)
  assert.equal(res.body.mission.status, 'PAUSED')
})

test('POST /missions denies a non-member workspace', async () => {
  const a = await seedUserWithWorkspace('a@x.test')
  const b = await seedUserWithWorkspace('b@x.test')
  const res = await server.request('/api/missions', {
    method: 'POST', headers: jsonAuth(a.user.id),
    body: JSON.stringify({ workspaceId: b.workspace.id, name: 'X', goalType: 'BOOK_CALL' }),
  })
  assert.equal(res.status, 403)
})
