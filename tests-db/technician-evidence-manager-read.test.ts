// Manager read access and cursor pagination for technician evidence.
// Managers (ops:manage) read any job's evidence in their own workspace with no
// linked crew account; ordinary members keep the per-job assignment restriction;
// nothing crosses workspaces.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { technicianRouter } from '../apps/api/src/routes/ops/technician.ts'
import { prisma, resetDb, disconnect, seedUser, seedUserWithWorkspace, startTestServer, bearer, type TestServer } from './helpers/db.ts'

let server: TestServer
before(async () => { server = await startTestServer('/api/ops/technician', technicianRouter) })
after(async () => { await server.close(); await disconnect() })
beforeEach(async () => { await resetDb() })

function call(userId: string, method: string, path: string, body?: unknown) {
  return server.request(path, {
    method,
    headers: { Authorization: bearer(userId), 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}
const list = (userId: string, jobId: string, workspaceId: string, qs = '') =>
  call(userId, 'GET', `/api/ops/technician/${jobId}/evidence?workspaceId=${workspaceId}${qs}`)

async function workspaceWithSite(email: string) {
  const { user: owner, workspace } = await seedUserWithWorkspace(email)
  const site = await prisma.opsJobSite.create({ data: {
    workspaceId: workspace.id, jobCode: `S-${Math.random().toString(36).slice(2, 7)}`, siteName: 'Site',
  } })
  const makeJob = () => prisma.job.create({ data: { workspaceId: workspace.id, opsJobSiteId: site.id } })
  const makeMember = async (name: string, role: string, linkedCrew: boolean) => {
    const user = await seedUser(`${name}-${Math.random().toString(36).slice(2, 6)}@example.test`)
    await prisma.membership.create({ data: { workspaceId: workspace.id, userId: user.id, role } })
    const crew = linkedCrew
      ? await prisma.opsCrewMember.create({ data: {
        workspaceId: workspace.id, employeeCode: `C-${name}-${Math.random().toString(36).slice(2, 6)}`,
        fullName: name, role: 'TECH', userId: user.id,
      } })
      : null
    return { user, crew }
  }
  const assign = async (jobId: string, crewMemberId: string) => {
    const r = await call(owner.id, 'POST', `/api/ops/technician/${jobId}/assignments`, { workspaceId: workspace.id, crewMemberId })
    assert.equal(r.status, 201, JSON.stringify(r.body))
  }
  const addEvidence = (jobId: string, crewMemberId: string, note: string, createdAt?: Date) =>
    prisma.jobTechnicianEvidence.create({ data: {
      workspaceId: workspace.id, jobId, crewMemberId, submissionId: randomUUID(), kind: 'NOTE',
      content: { note }, ...(createdAt ? { createdAt } : {}),
    } })
  return { owner, workspace, makeJob, makeMember, assign, addEvidence }
}

test('owner and admin read all technicians\' evidence on a job without a linked crew account', async () => {
  const w = await workspaceWithSite('owner-r@example.test')
  const admin = await w.makeMember('admin', 'admin', false)
  const t1 = await w.makeMember('tech1', 'member', true)
  const t2 = await w.makeMember('tech2', 'member', true)
  const job = await w.makeJob()
  await w.assign(job.id, t1.crew!.id)
  await w.assign(job.id, t2.crew!.id)
  await w.addEvidence(job.id, t1.crew!.id, 'from t1')
  await w.addEvidence(job.id, t2.crew!.id, 'from t2')
  for (const viewer of [w.owner, admin.user]) {
    const r = await list(viewer.id, job.id, w.workspace.id)
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.evidence.length, 2)
    assert.deepEqual(new Set(r.body.evidence.map((e: { crewMemberId: string }) => e.crewMemberId)), new Set([t1.crew!.id, t2.crew!.id]))
    assert.equal(r.body.nextCursor, null)
  }
  // A manager needs no assignment either: evidence exists on a job nobody is assigned to.
  const other = await w.makeJob()
  await w.addEvidence(other.id, t1.crew!.id, 'legacy row')
  assert.equal((await list(w.owner.id, other.id, w.workspace.id)).body.evidence.length, 1)
})

test('ordinary members keep the per-job assignment restriction', async () => {
  const w = await workspaceWithSite('owner-m@example.test')
  const assigned = await w.makeMember('assigned', 'member', true)
  const unassigned = await w.makeMember('unassigned', 'member', true)
  const unlinked = await w.makeMember('unlinked', 'member', false)
  const jobA = await w.makeJob()
  const jobB = await w.makeJob()
  await w.assign(jobA.id, assigned.crew!.id)
  await w.assign(jobB.id, unassigned.crew!.id)
  await w.addEvidence(jobA.id, assigned.crew!.id, 'A note')
  await w.addEvidence(jobB.id, unassigned.crew!.id, 'B note')
  const own = await list(assigned.user.id, jobA.id, w.workspace.id)
  assert.equal(own.status, 200)
  assert.equal(own.body.evidence.length, 1)
  assert.equal('crewMemberId' in own.body.evidence[0], false, 'worker view must not gain manager-only fields')
  assert.equal((await list(assigned.user.id, jobB.id, w.workspace.id)).status, 403)
  assert.equal((await list(unlinked.user.id, jobA.id, w.workspace.id)).status, 403)
  // Revocation still removes read access.
  const revoked = await call(w.owner.id, 'DELETE', `/api/ops/technician/${jobA.id}/assignments/${assigned.crew!.id}?workspaceId=${w.workspace.id}`)
  assert.equal(revoked.status, 200)
  assert.equal((await list(assigned.user.id, jobA.id, w.workspace.id)).status, 403)
  // Non-member of the workspace.
  const stranger = await seedUser('stranger@example.test')
  assert.equal((await list(stranger.id, jobA.id, w.workspace.id)).status, 403)
})

test('nothing crosses workspaces, for managers or technicians', async () => {
  const a = await workspaceWithSite('owner-a@example.test')
  const b = await workspaceWithSite('owner-b@example.test')
  const techA = await a.makeMember('techa', 'member', true)
  const jobA = await a.makeJob()
  await a.assign(jobA.id, techA.crew!.id)
  await a.addEvidence(jobA.id, techA.crew!.id, 'secret A')
  // B's manager claiming A's workspace is not a member there.
  assert.equal((await list(b.owner.id, jobA.id, a.workspace.id)).status, 403)
  // B's manager using B's workspace id with A's job id: the job is not in B.
  assert.equal((await list(b.owner.id, jobA.id, b.workspace.id)).status, 404)
  // A's own manager cannot read through B's workspace id either.
  assert.equal((await list(a.owner.id, jobA.id, b.workspace.id)).status, 403)
  // Same for a technician.
  assert.equal((await list(techA.user.id, jobA.id, b.workspace.id)).status, 403)
  // A cursor minted in workspace A is inert against a job in workspace B.
  const jobB = await b.makeJob()
  const critA = await a.makeMember('crit', 'member', true)
  await a.addEvidence(jobA.id, critA.crew!.id, 'second A')
  const firstPage = await list(a.owner.id, jobA.id, a.workspace.id, '&limit=1')
  assert.ok(firstPage.body.nextCursor)
  const replay = await list(b.owner.id, jobB.id, b.workspace.id, `&cursor=${firstPage.body.nextCursor}`)
  assert.equal(replay.status, 200)
  assert.equal(replay.body.evidence.length, 0)
})

test('cursor pagination: newest first, no gaps or duplicates, stable across equal timestamps', async () => {
  const w = await workspaceWithSite('owner-p@example.test')
  const tech = await w.makeMember('pager', 'member', true)
  const job = await w.makeJob()
  await w.assign(job.id, tech.crew!.id)
  // 7 rows: 3 distinct times plus 4 sharing one timestamp to exercise the id tie-break.
  const shared = new Date('2026-10-01T00:00:00.000Z')
  const ids: string[] = []
  for (let i = 0; i < 3; i++) ids.push((await w.addEvidence(job.id, tech.crew!.id, `t${i}`, new Date(shared.getTime() + (i + 1) * 1000))).id)
  for (let i = 0; i < 4; i++) ids.push((await w.addEvidence(job.id, tech.crew!.id, `s${i}`, shared)).id)

  for (const viewer of [w.owner, tech.user]) {
    const seen: string[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const r: { status: number; body: { evidence: Array<{ id: string; createdAt: string }>; nextCursor: string | null } } =
        await list(viewer.id, job.id, w.workspace.id, `&limit=3${cursor ? `&cursor=${cursor}` : ''}`)
      assert.equal(r.status, 200, JSON.stringify(r.body))
      assert.ok(r.body.evidence.length <= 3)
      seen.push(...r.body.evidence.map(e => e.id))
      cursor = r.body.nextCursor
      pages++
    } while (cursor && pages < 10)
    assert.equal(pages, 3, '7 rows at limit 3 is 3 pages')
    assert.equal(seen.length, 7)
    assert.equal(new Set(seen).size, 7, 'no duplicates')
    assert.deepEqual([...seen].sort(), [...ids].sort(), 'no gaps')
    const rows = await prisma.jobTechnicianEvidence.findMany({ where: { jobId: job.id }, select: { id: true, createdAt: true } })
    const expected = rows.sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime() || (x.id < y.id ? 1 : -1)).map(r => r.id)
    assert.deepEqual(seen, expected, 'newest first, id desc within equal timestamps')
  }
  // Default page size serves more than the old hard cap of 100 across pages.
  for (let i = 0; i < 110; i++) await w.addEvidence(job.id, tech.crew!.id, `bulk${i}`, new Date(shared.getTime() + 100_000 + i))
  let total = 0
  let cursor: string | null = null
  do {
    const r: { body: { evidence: unknown[]; nextCursor: string | null } } =
      await list(w.owner.id, job.id, w.workspace.id, `&limit=100${cursor ? `&cursor=${cursor}` : ''}`)
    total += r.body.evidence.length
    cursor = r.body.nextCursor
  } while (cursor)
  assert.equal(total, 117)
})

test('invalid pagination input is rejected', async () => {
  const w = await workspaceWithSite('owner-v@example.test')
  const job = await w.makeJob()
  assert.equal((await list(w.owner.id, job.id, w.workspace.id, '&limit=0')).status, 400)
  assert.equal((await list(w.owner.id, job.id, w.workspace.id, '&limit=101')).status, 400)
  assert.equal((await list(w.owner.id, job.id, w.workspace.id, '&limit=abc')).status, 400)
  assert.equal((await list(w.owner.id, job.id, w.workspace.id, '&cursor=not-a-cursor')).status, 400)
  const forged = Buffer.from(JSON.stringify({ t: 'yesterday', i: 'x' })).toString('base64url')
  assert.equal((await list(w.owner.id, job.id, w.workspace.id, `&cursor=${forged}`)).status, 400)
})
