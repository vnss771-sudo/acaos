// Run against disposable Postgres with the technician-evidence migration applied.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { technicianRouter } from '../apps/api/src/routes/ops/technician.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace, seedUser, startTestServer, bearer, type TestServer } from './helpers/db.ts'

let server: TestServer
before(async () => { server = await startTestServer('/api/ops/technician', technicianRouter) })
after(async () => { await server.close(); await disconnect() })
beforeEach(async () => { await resetDb() })

function request(userId: string, method: string, path: string, body?: unknown) {
  return server.request(path, {
    method,
    headers: { Authorization: bearer(userId), 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function setup(email: string) {
  const { user, workspace } = await seedUserWithWorkspace(email)
  const site = await prisma.opsJobSite.create({ data: {
    workspaceId: workspace.id, jobCode: 'TEST-SITE', siteName: 'Test site',
  } })
  const job = await prisma.job.create({ data: { workspaceId: workspace.id, opsJobSiteId: site.id } })
  const crew = await prisma.opsCrewMember.create({ data: {
    workspaceId: workspace.id, employeeCode: 'TECH-1', fullName: 'Test technician', role: 'TECH', userId: user.id,
  } })
  return { user, workspace, site, job, crew }
}

test('technician needs explicit job assignment to create or read evidence', async () => {
  const a = await setup('tech-a@example.test')
  const url = `/api/ops/technician/${a.job.id}/evidence`
  const note = { workspaceId: a.workspace.id, kind: 'NOTE', submissionId: '00000000-0000-4000-8000-000000000001', note: 'Installed isolator' }
  assert.equal((await request(a.user.id, 'POST', url, note)).status, 403)
  // The owner is a manager and may read without assignment (see
  // technician-evidence-manager-read.test.ts); an ordinary member may not.
  const member = await seedUser('member-noassign@example.test')
  await prisma.membership.create({ data: { workspaceId: a.workspace.id, userId: member.id, role: 'member' } })
  await prisma.opsCrewMember.create({ data: {
    workspaceId: a.workspace.id, employeeCode: 'TECH-M', fullName: 'Unassigned member', role: 'TECH', userId: member.id,
  } })
  assert.equal((await request(member.id, 'GET', `${url}?workspaceId=${a.workspace.id}`)).status, 403)
  const assigned = await request(a.user.id, 'POST', `/api/ops/technician/${a.job.id}/assignments`, {
    workspaceId: a.workspace.id, crewMemberId: a.crew.id,
  })
  assert.equal(assigned.status, 201, JSON.stringify(assigned.body))
  const created = await request(a.user.id, 'POST', url, note)
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const list = await request(a.user.id, 'GET', `${url}?workspaceId=${a.workspace.id}`)
  assert.equal(list.status, 200)
  assert.equal(list.body.evidence.length, 1)
  assert.deepEqual(list.body.evidence[0].content, { note: 'Installed isolator' })
})

test('cross-workspace job and crew references are rejected at API and database layers', async () => {
  const a = await setup('tech-a@example.test')
  const b = await setup('tech-b@example.test')
  const path = `/api/ops/technician/${a.job.id}/assignments`
  assert.equal((await request(a.user.id, 'POST', path, {
    workspaceId: a.workspace.id, crewMemberId: b.crew.id,
  })).status, 404)
  assert.equal((await request(b.user.id, 'POST', path, {
    workspaceId: a.workspace.id, crewMemberId: b.crew.id,
  })).status, 403)
  await assert.rejects(prisma.jobTechnicianAssignment.create({ data: {
    workspaceId: a.workspace.id, jobId: a.job.id, crewMemberId: b.crew.id,
  } }))
  await assert.rejects(prisma.jobTechnicianEvidence.create({ data: {
    workspaceId: a.workspace.id, jobId: a.job.id, crewMemberId: b.crew.id,
    kind: 'NOTE', submissionId: '00000000-0000-4000-8000-000000000004', content: { note: 'invalid cross-tenant author' },
  } }))
})

test('evidence is blocked after job closeout and malformed payloads are rejected', async () => {
  const a = await setup('tech-a@example.test')
  const assignment = await request(a.user.id, 'POST', `/api/ops/technician/${a.job.id}/assignments`, {
    workspaceId: a.workspace.id, crewMemberId: a.crew.id,
  })
  assert.equal(assignment.status, 201)
  const url = `/api/ops/technician/${a.job.id}/evidence`
  assert.equal((await request(a.user.id, 'POST', url, { workspaceId: a.workspace.id, kind: 'CHECKLIST', submissionId: '00000000-0000-4000-8000-000000000002', checklist: [] })).status, 400)
  await prisma.job.update({ where: { id: a.job.id }, data: { status: 'COMPLETE' } })
  assert.equal((await request(a.user.id, 'POST', url, { workspaceId: a.workspace.id, kind: 'NOTE', submissionId: '00000000-0000-4000-8000-000000000003', note: 'late note' })).status, 409)
})

test('duplicate mobile retry returns the original evidence', async () => {
  const a = await setup('retry@example.test')
  assert.equal((await request(a.user.id, 'POST', `/api/ops/technician/${a.job.id}/assignments`, {
    workspaceId: a.workspace.id, crewMemberId: a.crew.id,
  })).status, 201)
  const path = `/api/ops/technician/${a.job.id}/evidence`
  const body = { workspaceId: a.workspace.id, kind: 'NOTE', note: 'Inspection complete', submissionId: '00000000-0000-4000-8000-000000000005' }
  const first = await request(a.user.id, 'POST', path, body)
  const second = await request(a.user.id, 'POST', path, body)
  assert.equal(first.status, 201)
  assert.equal(second.status, 200)
  assert.equal(first.body.evidence.id, second.body.evidence.id)
  assert.equal(await prisma.jobTechnicianEvidence.count({ where: { jobId: a.job.id } }), 1)
})

test('revoked assignment immediately prevents technician evidence access', async () => {
  const a = await setup('revoke@example.test')
  const assignPath = `/api/ops/technician/${a.job.id}/assignments`
  assert.equal((await request(a.user.id, 'POST', assignPath, {
    workspaceId: a.workspace.id, crewMemberId: a.crew.id,
  })).status, 201)
  assert.equal((await request(a.user.id, 'DELETE', `${assignPath}/${a.crew.id}?workspaceId=${a.workspace.id}`)).status, 200)
  // Revocation removes the technician's write access (managers keep read access).
  assert.equal((await request(a.user.id, 'POST', `/api/ops/technician/${a.job.id}/evidence`, {
    workspaceId: a.workspace.id, kind: 'NOTE', submissionId: '00000000-0000-4000-8000-0000000000aa', note: 'after revoke',
  })).status, 403)
})


test('reusing a submission ID with different content is rejected', async () => {
  const a = await setup('collision@example.test')
  const assignments = `/api/ops/technician/${a.job.id}/assignments`
  assert.equal((await request(a.user.id, 'POST', assignments, {
    workspaceId: a.workspace.id, crewMemberId: a.crew.id,
  })).status, 201)
  const path = `/api/ops/technician/${a.job.id}/evidence`
  const base = { workspaceId: a.workspace.id, kind: 'NOTE', submissionId: '00000000-0000-4000-8000-000000000006' }
  assert.equal((await request(a.user.id, 'POST', path, { ...base, note: 'Original' })).status, 201)
  assert.equal((await request(a.user.id, 'POST', path, { ...base, note: 'Altered' })).status, 409)
  assert.equal(await prisma.jobTechnicianEvidence.count({ where: { jobId: a.job.id } }), 1)
})

test('ordinary member linked to a crew record can submit and read evidence without ops:manage', async () => {
  const a = await setup('owner-w@example.test')
  const worker = await seedUser('worker@example.test')
  await prisma.membership.create({ data: { workspaceId: a.workspace.id, userId: worker.id, role: 'member' } })
  const wc = await prisma.opsCrewMember.create({ data: {
    workspaceId: a.workspace.id, employeeCode: 'TECH-2', fullName: 'Worker', role: 'TECH', userId: worker.id,
  } })
  const assignments = `/api/ops/technician/${a.job.id}/assignments`
  // Worker cannot self-assign.
  assert.equal((await request(worker.id, 'POST', assignments, { workspaceId: a.workspace.id, crewMemberId: wc.id })).status, 403)
  assert.equal((await request(a.user.id, 'POST', assignments, { workspaceId: a.workspace.id, crewMemberId: wc.id })).status, 201)
  const path = `/api/ops/technician/${a.job.id}/evidence`
  const body = { workspaceId: a.workspace.id, kind: 'CHECKLIST', submissionId: '00000000-0000-4000-8000-000000000007',
    checklist: [{ label: 'Isolated', checked: true }] }
  assert.equal((await request(worker.id, 'POST', path, body)).status, 201)
  // Identical retry is idempotent despite JSONB key reordering.
  assert.equal((await request(worker.id, 'POST', path, body)).status, 200)
  const list = await request(worker.id, 'GET', `${path}?workspaceId=${a.workspace.id}`)
  assert.equal(list.status, 200)
  assert.equal(list.body.evidence.length, 1)
  // Worker cannot revoke.
  assert.equal((await request(worker.id, 'DELETE', `${assignments}/${wc.id}?workspaceId=${a.workspace.id}`)).status, 403)
})
