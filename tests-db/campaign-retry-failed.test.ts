// Database-backed test for the campaign "retry failed" operator action: clears
// FAILED outbox rows (making those leads re-sendable) while leaving delivered
// rows intact.

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { campaignsRouter } from '../apps/api/src/routes/campaigns.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace, startTestServer, bearer, type TestServer } from './helpers/db.ts'

let server: TestServer
before(async () => { server = await startTestServer('/api/campaigns', campaignsRouter) })
after(async () => { await server.close(); await disconnect() })
beforeEach(async () => { await resetDb() })

test('POST /:id/retry-failed clears FAILED rows and keeps delivered ones', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const campaign = await prisma.campaign.create({ data: { workspaceId: workspace.id, name: 'C', goalType: 'BOOK_CALL' } })
  for (const status of ['FAILED', 'FAILED', 'SENT']) {
    await prisma.outreachSent.create({
      data: { workspaceId: workspace.id, campaignId: campaign.id, toEmail: `${status}-${Math.random()}@x.test`, subject: 's', body: 'b', status },
    })
  }

  const res = await server.request(`/api/campaigns/${campaign.id}/retry-failed`, { method: 'POST', headers: { Authorization: bearer(user.id) } })
  assert.equal(res.status, 200)
  assert.equal(res.body.cleared, 2)

  const remaining = await prisma.outreachSent.findMany({ where: { campaignId: campaign.id } })
  assert.equal(remaining.length, 1)
  assert.equal(remaining[0].status, 'SENT')
})

test('POST /:id/retry-failed denies a non-member', async () => {
  const a = await seedUserWithWorkspace('a@x.test')
  const b = await seedUserWithWorkspace('b@x.test')
  const campaign = await prisma.campaign.create({ data: { workspaceId: b.workspace.id, name: 'C', goalType: 'BOOK_CALL' } })
  const res = await server.request(`/api/campaigns/${campaign.id}/retry-failed`, { method: 'POST', headers: { Authorization: bearer(a.user.id) } })
  assert.equal(res.status, 403)
})
