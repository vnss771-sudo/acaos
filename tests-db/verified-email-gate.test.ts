// Behavioral proof of the email-verification mutation gate against a REAL
// database. The static matrix (tests/routes-verified-email-gate.test.ts) proves
// the middleware is WIRED on every router; this proves it BEHAVES: an unverified
// account is blocked from mutating (403) but can still read (GET), verifying the
// email lifts the block, and the onboarding self-config is exempt.
//
// seedUserWithWorkspace defaults to a VERIFIED user (most route tests want an
// onboarded user), so these tests opt INTO an unverified account explicitly.

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { missionsRouter } from '../apps/api/src/routes/missions.ts'
import { workspaceRouter } from '../apps/api/src/routes/workspaces/index.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace, startTestServer, bearer, type TestServer } from './helpers/db.ts'

let missions: TestServer
let workspaces: TestServer

before(async () => {
  missions = await startTestServer('/api/missions', missionsRouter)
  workspaces = await startTestServer('/api/workspaces', workspaceRouter)
})
after(async () => { await missions.close(); await workspaces.close(); await disconnect() })
beforeEach(async () => { await resetDb() })

const auth = (userId: string) => ({ Authorization: bearer(userId), 'Content-Type': 'application/json' })
const createBody = (workspaceId: string) =>
  JSON.stringify({ workspaceId, name: 'Q3 Outbound', goalType: 'BOOK_CALL' })
const unverified = () => seedUserWithWorkspace(undefined, 'owner', { emailVerified: false })

test('an unverified user is blocked from mutating (POST → 403 verification)', async () => {
  const { user, workspace } = await unverified()
  const res = await missions.request('/api/missions', { method: 'POST', headers: auth(user.id), body: createBody(workspace.id) })
  assert.equal(res.status, 403)
  assert.match((res.body as { error?: string }).error ?? '', /verification/i, 'must be the email-verification 403, not a tenant/validation 403')
  // Nothing was written.
  assert.equal(await prisma.mission.count({ where: { workspaceId: workspace.id } }), 0)
})

test('an unverified user can still READ (GET is not blocked by verification)', async () => {
  const { user, workspace } = await unverified()
  const res = await missions.request(`/api/missions?workspaceId=${workspace.id}`, { headers: auth(user.id) })
  assert.equal(res.status, 200, 'reads stay open to unverified, authenticated members')
})

test('verifying the email lifts the mutation block (POST → 201)', async () => {
  const { user, workspace } = await unverified()
  await prisma.user.update({ where: { id: user.id }, data: { emailVerified: true } })
  const res = await missions.request('/api/missions', { method: 'POST', headers: auth(user.id), body: createBody(workspace.id) })
  assert.equal(res.status, 201, 'a verified member may create the mission')
  assert.equal(await prisma.mission.count({ where: { workspaceId: workspace.id } }), 1)
})

// --- onboarding exemption: a new, unverified user can still finish setup ---

test('onboarding is exempt: an unverified owner may PUT /:id/icp', async () => {
  const { user, workspace } = await unverified()
  const res = await workspaces.request(`/api/workspaces/${workspace.id}/icp`, {
    method: 'PUT', headers: auth(user.id), body: JSON.stringify({ outreachTone: 'professional' }),
  })
  assert.equal(res.status, 200, 'onboarding ICP setup must work before email verification')
})

test('a non-onboarding workspace mutation still requires verification (POST /:id/members → 403)', async () => {
  const { user, workspace } = await unverified()
  const res = await workspaces.request(`/api/workspaces/${workspace.id}/members`, {
    method: 'POST', headers: auth(user.id), body: JSON.stringify({ email: 'invitee@x.test', role: 'member' }),
  })
  assert.equal(res.status, 403)
  assert.match((res.body as { error?: string }).error ?? '', /verification/i, 'must be the verification 403, proving the exemption is scoped to onboarding')
})
