// Cross-tenant (IDOR) regression tests against a REAL database. The fake-prisma
// isolation suite (tests/security-isolation.test.ts) covers leads/campaigns/
// workspaces; this closes the audit's gap list — prospects, missions, and the
// signal→prospect cross-reference — by asserting that a member of workspace A
// can never read or mutate a resource owned by workspace B (403), exercising the
// actual Prisma scoping rather than a mock.

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { prospectsRouter } from '../apps/api/src/routes/prospects.ts'
import { missionsRouter } from '../apps/api/src/routes/missions.ts'
import { signalsRouter } from '../apps/api/src/routes/signals.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace, startTestServer, bearer, type TestServer } from './helpers/db.ts'

let prospects: TestServer
let missions: TestServer
let signals: TestServer

before(async () => {
  prospects = await startTestServer('/api/prospects', prospectsRouter)
  missions = await startTestServer('/api/missions', missionsRouter)
  signals = await startTestServer('/api/signals', signalsRouter)
})
after(async () => {
  await prospects.close(); await missions.close(); await signals.close()
  await disconnect()
})
beforeEach(async () => { await resetDb() })

// User A (owner of workspace A, email-verified) and workspace B with its own
// owner. Resources are created in B; A must never reach them.
async function seedTwoTenants() {
  const a = await seedUserWithWorkspace('a@x.test')
  const b = await seedUserWithWorkspace('b@x.test')
  // Verified so requireVerifiedEmail-gated mutations test the TENANT gate, not the
  // verification gate.
  await prisma.user.update({ where: { id: a.user.id }, data: { emailVerified: true } })
  return { a, b }
}
const authA = (userId: string) => ({ Authorization: bearer(userId), 'Content-Type': 'application/json' })

test('prospects: a member of A cannot read/update/delete a prospect in B', async () => {
  const { a, b } = await seedTwoTenants()
  const p = await prisma.prospect.create({ data: { workspaceId: b.workspace.id, companyName: 'Acme B', industry: 'construction' } })
  const h = authA(a.user.id)

  assert.equal((await prospects.request(`/api/prospects/${p.id}`, { headers: h })).status, 403)
  assert.equal((await prospects.request(`/api/prospects/${p.id}`, { method: 'PATCH', headers: h, body: JSON.stringify({ companyName: 'hacked' }) })).status, 403)
  assert.equal((await prospects.request(`/api/prospects/${p.id}`, { method: 'DELETE', headers: h })).status, 403)

  // The prospect is untouched.
  const after = await prisma.prospect.findUnique({ where: { id: p.id } })
  assert.equal(after!.companyName, 'Acme B')
})

test('missions: a member of A cannot read or update a mission in B', async () => {
  const { a, b } = await seedTwoTenants()
  const m = await prisma.mission.create({ data: { workspaceId: b.workspace.id, name: 'Mission B', goalType: 'BOOK_MEETINGS' } })
  const h = authA(a.user.id)

  assert.equal((await missions.request(`/api/missions/${m.id}`, { headers: h })).status, 403)
  assert.equal((await missions.request(`/api/missions/${m.id}`, { method: 'PATCH', headers: h, body: JSON.stringify({ status: 'PAUSED' }) })).status, 403)

  const after = await prisma.mission.findUnique({ where: { id: m.id } })
  assert.equal(after!.name, 'Mission B')
})

test('signals: a member of A cannot attach a signal to a prospect in B', async () => {
  const { a, b } = await seedTwoTenants()
  const p = await prisma.prospect.create({ data: { workspaceId: b.workspace.id, companyName: 'Acme B', industry: 'construction' } })

  // A is an admin of its OWN workspace, but the target prospect belongs to B —
  // the cross-reference must be rejected, not silently attached.
  const res = await signals.request('/api/signals', {
    method: 'POST', headers: authA(a.user.id),
    body: JSON.stringify({ workspaceId: a.workspace.id, prospectId: p.id, type: 'HIRING', strength: 80 }),
  })
  assert.equal(res.status, 403)
  assert.equal(await prisma.signal.count({ where: { prospectId: p.id } }), 0)
})
