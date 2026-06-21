// Database-backed test for GET /api/sends/summary: workspace-level delivery
// counts for the Radar Send Monitor, tenant-scoped, with the SENT+REPLIED+BOUNCED
// "delivered" convention and reply rate.

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { sendsRouter } from '../apps/api/src/routes/sends.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace, startTestServer, bearer, type TestServer } from './helpers/db.ts'

let server: TestServer
before(async () => { server = await startTestServer('/api/sends', sendsRouter) })
after(async () => { await server.close(); await disconnect() })
beforeEach(async () => { await resetDb() })

async function seedSend(workspaceId: string, status: string, sentAt = new Date()) {
  return prisma.outreachSent.create({
    data: { workspaceId, toEmail: `${status}@x.test`, subject: 's', body: 'b', status, sentAt },
  })
}

test('summarizes delivery counts, delivered total, and reply rate', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  await seedSend(workspace.id, 'SENT')
  await seedSend(workspace.id, 'SENT')
  await seedSend(workspace.id, 'REPLIED')
  await seedSend(workspace.id, 'BOUNCED')
  await seedSend(workspace.id, 'FAILED')

  const res = await server.request(`/api/sends/summary?workspaceId=${workspace.id}`, { headers: { Authorization: bearer(user.id) } })
  assert.equal(res.status, 200)
  assert.equal(res.body.sent, 2)
  assert.equal(res.body.replied, 1)
  assert.equal(res.body.bounced, 1)
  assert.equal(res.body.failed, 1)
  // delivered = SENT + REPLIED + BOUNCED = 4; reply rate = 1/4 = 25%.
  assert.equal(res.body.delivered, 4)
  assert.equal(res.body.replyRate, 25)
  assert.equal(res.body.total, 5)
})

test('counts last-24h delivered sends and excludes older ones', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  await seedSend(workspace.id, 'SENT', new Date())
  await seedSend(workspace.id, 'SENT', new Date(Date.now() - 48 * 60 * 60 * 1000)) // 2 days ago

  const res = await server.request(`/api/sends/summary?workspaceId=${workspace.id}`, { headers: { Authorization: bearer(user.id) } })
  assert.equal(res.body.last24hSent, 1)
})

test('denies access to a workspace the user does not belong to', async () => {
  const a = await seedUserWithWorkspace('a@x.test')
  const b = await seedUserWithWorkspace('b@x.test')
  await seedSend(b.workspace.id, 'SENT')

  const res = await server.request(`/api/sends/summary?workspaceId=${b.workspace.id}`, { headers: { Authorization: bearer(a.user.id) } })
  assert.equal(res.status, 403)
})
