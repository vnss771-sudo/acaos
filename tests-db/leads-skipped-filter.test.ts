// Database-backed test for the outreach-gate "skipped" review queue: the leads
// list filters to poor-fit leads the gate suppressed (no OpenAI involved).

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { leadsRouter } from '../apps/api/src/routes/leads.ts'
import {
  prisma, resetDb, disconnect, seedUserWithWorkspace,
  startTestServer, bearer, type TestServer,
} from './helpers/db.ts'

let server: TestServer

before(async () => { server = await startTestServer('/api/leads', leadsRouter) })
after(async () => { await server.close(); await disconnect() })
beforeEach(async () => { await resetDb() })

test('GET /api/leads?skipped=true returns only outreach-gate-suppressed leads', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  await prisma.lead.create({ data: { workspaceId: workspace.id, businessName: 'Good Fit Co' } })
  await prisma.lead.create({
    data: {
      workspaceId: workspace.id,
      businessName: 'Poor Fit Co',
      outreachSkippedAt: new Date(),
      outreachSkipReason: 'SKIPPED_POOR_FIT: research recommended skipping this lead as a poor fit',
    },
  })

  const all = await server.request(`/api/leads?workspaceId=${workspace.id}`, { headers: { Authorization: bearer(user.id) } })
  assert.equal(all.status, 200)
  assert.equal(all.body.leads.length, 2)

  const skipped = await server.request(`/api/leads?workspaceId=${workspace.id}&skipped=true`, { headers: { Authorization: bearer(user.id) } })
  assert.equal(skipped.status, 200)
  assert.equal(skipped.body.leads.length, 1)
  assert.equal(skipped.body.leads[0].businessName, 'Poor Fit Co')
  assert.ok(skipped.body.leads[0].outreachSkipReason.startsWith('SKIPPED_POOR_FIT'))
})
