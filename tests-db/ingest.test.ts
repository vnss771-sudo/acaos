// Database-backed integration tests for /api/ingest.
//
// The dedup logic relies on real `findMany ... where email IN (...)` lookups
// against existing rows plus a `$transaction` of inserts — exactly the shape a
// fake can't validate. These tests assert the rows that actually land.

import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { ingestRouter } from '../apps/api/src/routes/ingest.ts'
import { hashApiKey } from '../apps/api/src/lib/apiKeys.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace, startTestServer, bearer, type TestServer } from './helpers/db.ts'

let server: TestServer

before(async () => {
  server = await startTestServer('/api/ingest', ingestRouter)
})
after(async () => {
  await server.close()
  await disconnect()
})
beforeEach(async () => {
  await resetDb()
})

// Give a workspace an ingest API key. Only the hash is stored (as in
// production); the raw key is returned for the test to authenticate with.
async function workspaceWithKey() {
  const { workspace } = await seedUserWithWorkspace()
  const key = `key-${Math.random().toString(36).slice(2)}`
  await prisma.workspace.update({ where: { id: workspace.id }, data: { ingestApiKey: hashApiKey(key) } })
  return { workspaceId: workspace.id, key }
}

function ingest(key: string, body: unknown) {
  return server.request('/api/ingest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key },
    body: JSON.stringify(body),
  })
}

test('creates leads for a valid key and persists them scoped to the workspace', async () => {
  const { workspaceId, key } = await workspaceWithKey()
  const res = await ingest(key, {
    leads: [{ businessName: 'Alpha' }, { businessName: 'Beta', email: 'b@x.test' }],
    autoResearch: false,
  })
  assert.equal(res.status, 201)
  assert.equal(res.body.created, 2)
  assert.equal(await prisma.lead.count({ where: { workspaceId } }), 2)
})

test('key rotation stores only a hash and returns a working raw key (SEC-5)', async () => {
  const { user, workspace } = await seedUserWithWorkspace() // owner
  const rotate = await server.request(`/api/ingest/keys/rotate?workspaceId=${workspace.id}`, {
    method: 'POST', headers: { Authorization: bearer(user.id) },
  })
  assert.equal(rotate.status, 200)
  const rawKey = rotate.body.ingestApiKey
  assert.match(rawKey, /^[a-f0-9]{64}$/)

  // The database stores the hash, never the raw key.
  const ws = await prisma.workspace.findUnique({ where: { id: workspace.id }, select: { ingestApiKey: true } })
  assert.notEqual(ws!.ingestApiKey, rawKey)
  assert.equal(ws!.ingestApiKey, hashApiKey(rawKey))

  // The raw key still authenticates an ingest request.
  const res = await ingest(rawKey, { leads: [{ businessName: 'Via rotated key' }], autoResearch: false })
  assert.equal(res.status, 201)
  assert.equal(res.body.created, 1)
})

test('auto-research respects the monthly AI plan limit (ROB-5)', async () => {
  const { workspaceId, key } = await workspaceWithKey() // free plan: 15 AI calls/mo
  const month = new Date().toISOString().slice(0, 7) // YYYY-MM
  // Already at the free-plan AI cap for this month.
  await prisma.usageRecord.create({
    data: { workspaceId, action: 'AI_RESEARCH', month, count: 15 },
  })

  const res = await ingest(key, {
    leads: [{ businessName: 'One' }, { businessName: 'Two' }, { businessName: 'Three' }],
    autoResearch: true,
  })
  assert.equal(res.status, 201)
  assert.equal(res.body.created, 3) // leads are still saved
  assert.equal(res.body.queued, 0) // but none auto-researched — cap enforced
})

test('dedupes within the batch and against existing workspace rows (case-insensitive)', async () => {
  const { workspaceId, key } = await workspaceWithKey()
  await prisma.lead.create({ data: { workspaceId, businessName: 'Existing', email: 'taken@x.test' } })

  const res = await ingest(key, {
    leads: [
      { businessName: 'DupBatch1', email: 'new@x.test' },
      { businessName: 'DupBatch2', email: 'NEW@x.test' }, // same as above, different case
      { businessName: 'AlreadyHere', email: 'Taken@X.test' }, // already in workspace
      { businessName: 'NoEmailKeeps' }, // no email → always kept
    ],
    autoResearch: false,
  })
  assert.equal(res.status, 201)
  // new@x.test (once) + NoEmailKeeps = 2 created; the dup and existing are skipped.
  assert.equal(res.body.created, 2)
  assert.equal(await prisma.lead.count({ where: { workspaceId } }), 3) // 1 pre-existing + 2
  assert.equal(await prisma.lead.count({ where: { workspaceId, email: 'new@x.test' } }), 1)
})

test('the same email may exist in two different workspaces (dedup is workspace-scoped)', async () => {
  const a = await workspaceWithKey()
  const b = await workspaceWithKey()
  await ingest(a.key, { leads: [{ businessName: 'A', email: 'shared@x.test' }], autoResearch: false })
  const res = await ingest(b.key, { leads: [{ businessName: 'B', email: 'shared@x.test' }], autoResearch: false })
  assert.equal(res.body.created, 1)
  assert.equal(await prisma.lead.count({ where: { email: 'shared@x.test' } }), 2)
})

test('rejects an invalid API key with no rows written', async () => {
  const res = await ingest('bogus-key', { leads: [{ businessName: 'X' }], autoResearch: false })
  assert.equal(res.status, 401)
  assert.equal(await prisma.lead.count(), 0)
})

test('rejects a campaignId that belongs to a different workspace', async () => {
  const { key } = await workspaceWithKey()
  const other = await seedUserWithWorkspace('other@acme.test')
  const foreignCampaign = await prisma.campaign.create({
    data: { workspaceId: other.workspace.id, name: 'Foreign', goalType: 'BOOK' },
  })
  const res = await ingest(key, {
    leads: [{ businessName: 'X' }],
    campaignId: foreignCampaign.id,
    autoResearch: false,
  })
  assert.equal(res.status, 400)
  assert.equal(await prisma.lead.count(), 0)
})
