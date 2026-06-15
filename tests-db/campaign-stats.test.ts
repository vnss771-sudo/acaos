// Database-backed test for campaign stats deliverability counts: FAILED and
// BOUNCED are reported separately, and FAILED (never sent) is excluded from the
// "sent" total while BOUNCED (sent then bounced) is included.

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { campaignsRouter } from '../apps/api/src/routes/campaigns.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace, startTestServer, bearer, type TestServer } from './helpers/db.ts'

let server: TestServer
before(async () => { server = await startTestServer('/api/campaigns', campaignsRouter) })
after(async () => { await server.close(); await disconnect() })
beforeEach(async () => { await resetDb() })

test('campaign stats report failed/bounced and exclude FAILED from sent', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const campaign = await prisma.campaign.create({ data: { workspaceId: workspace.id, name: 'C', goalType: 'BOOK_CALL' } })

  const statuses = ['SENT', 'REPLIED', 'BOUNCED', 'FAILED', 'SENDING']
  for (const status of statuses) {
    await prisma.outreachSent.create({
      data: { workspaceId: workspace.id, campaignId: campaign.id, toEmail: `${status.toLowerCase()}@x.test`, subject: 's', body: 'b', status },
    })
  }

  const res = await server.request(`/api/campaigns/${campaign.id}/stats`, { headers: { Authorization: bearer(user.id) } })
  assert.equal(res.status, 200)
  // sent = SENT + REPLIED + BOUNCED (delivered); excludes FAILED + SENDING
  assert.equal(res.body.stats.sent, 3)
  assert.equal(res.body.stats.replied, 1)
  assert.equal(res.body.stats.failed, 1)
  assert.equal(res.body.stats.bounced, 1)
})
