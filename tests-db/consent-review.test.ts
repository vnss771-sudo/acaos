// Integration: GET /api/workspaces/:id/consent (compliance UI review list).
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { workspaceRouter } from '../apps/api/src/routes/workspaces/index.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace, startTestServer, bearer, type TestServer } from './helpers/db.ts'

let server: TestServer
before(async () => { server = await startTestServer('/api/workspaces', workspaceRouter) })
after(async () => { await server.close(); await disconnect() })
beforeEach(async () => { await resetDb() })

const get = (workspaceId: string, auth: string, qs = '') =>
  server.request(`/api/workspaces/${workspaceId}/consent${qs}`, { method: 'GET', headers: { Authorization: auth } })

test('lists records with a SERVER-computed Australian verdict and the reasons', async () => {
  const { user, workspace } = await seedUserWithWorkspace('review@x.test')
  await prisma.consentRecord.create({ data: { workspaceId: workspace.id, emailKey: 'good@x.test', basis: 'inferred_conspicuous_publication', source: 'manual',
    evidenceUrl: 'https://acme.example/contact', evidenceAt: new Date('2026-09-01'), addressType: 'role', optOutStatementAbsent: true, roleRelevant: true } })
  await prisma.consentRecord.create({ data: { workspaceId: workspace.id, emailKey: 'thin@x.test', basis: 'inferred_conspicuous_publication', source: 'manual',
    evidenceUrl: 'https://acme.example/contact', evidenceAt: new Date('2026-09-01'), addressType: 'role' } })
  await prisma.consentRecord.create({ data: { workspaceId: workspace.id, emailKey: 'li@x.test', basis: 'legitimate_interest', source: 'manual' } })
  const res = await get(workspace.id, bearer(user.id))
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body.total, 3)
  const by = Object.fromEntries(res.body.records.map((r: any) => [r.email, r]))
  assert.equal(by['good@x.test'].qualifiesForAustralia, true)
  assert.equal(by['thin@x.test'].qualifiesForAustralia, false)
  assert.ok(by['thin@x.test'].australiaReasons.some((x: string) => /unsolicited commercial email/.test(x)))
  assert.equal(by['li@x.test'].qualifiesForAustralia, false)
  assert.ok(by['li@x.test'].australiaReasons.some((x: string) => /Not an Australian consent basis/.test(x)))
})

test('filters by email, honours limit, and is tenant-scoped', async () => {
  const { user, workspace } = await seedUserWithWorkspace('review2@x.test')
  const other = await seedUserWithWorkspace('review3@x.test')
  for (const e of ['a@x.test', 'b@x.test', 'c@x.test']) await prisma.consentRecord.create({ data: { workspaceId: workspace.id, emailKey: e, basis: 'express_consent', source: 'manual' } })
  await prisma.consentRecord.create({ data: { workspaceId: other.workspace.id, emailKey: 'secret@other.test', basis: 'express_consent', source: 'manual' } })
  assert.equal((await get(workspace.id, bearer(user.id), '?limit=2')).body.records.length, 2)
  assert.deepEqual((await get(workspace.id, bearer(user.id), '?email=B@X.test')).body.records.map((r: any) => r.email), ['b@x.test'])
  const all = (await get(workspace.id, bearer(user.id))).body.records.map((r: any) => r.email)
  assert.ok(!all.includes('secret@other.test'))
  assert.equal((await get(other.workspace.id, bearer(user.id))).status, 403, 'cannot read another workspace')
})

test('requires admin: a plain member is refused', async () => {
  const { workspace } = await seedUserWithWorkspace('review4@x.test')
  const { user: member } = await seedUserWithWorkspace('review5@x.test')
  await prisma.membership.create({ data: { userId: member.id, workspaceId: workspace.id, role: 'member' } })
  assert.equal((await get(workspace.id, bearer(member.id))).status, 403)
})

test('GET compliance exposes the ABN posture fields (and never any ABR secret)', async () => {
  const { user, workspace } = await seedUserWithWorkspace('review6@x.test')
  await prisma.workspace.update({ where: { id: workspace.id }, data: { targetsAustralia: true, senderAbn: '51824753556', senderAbnStatus: 'active', senderAbnEntityName: 'ACME PTY LTD', senderAbnVerifiedAt: new Date() } })
  const res = await server.request(`/api/workspaces/${workspace.id}/compliance`, { method: 'GET', headers: { Authorization: bearer(user.id) } })
  assert.equal(res.body.posture.targetsAustralia, true)
  assert.equal(res.body.posture.senderAbnStatus, 'active')
  assert.ok(!JSON.stringify(res.body).toLowerCase().includes('guid'))
})
