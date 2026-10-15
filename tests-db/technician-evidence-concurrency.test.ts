// Concurrency tests for technician evidence against a real Postgres. Evidence
// submission, assignment revocation and job closeout must serialise on the Job
// row: no evidence row without a 201, no 201 without a row, no evidence accepted
// after revocation or closeout has completed, and no deadlock between them.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { technicianRouter } from '../apps/api/src/routes/ops/technician.ts'
import { deliveryRouter } from '../apps/api/src/routes/delivery.ts'
import { prisma, resetDb, disconnect, seedUser, seedUserWithWorkspace, startTestServer, bearer, type TestServer } from './helpers/db.ts'

let tech: TestServer
let delivery: TestServer
before(async () => {
  tech = await startTestServer('/api/ops/technician', technicianRouter)
  delivery = await startTestServer('/api/delivery', deliveryRouter)
})
after(async () => { await tech.close(); await delivery.close(); await disconnect() })
beforeEach(async () => { await resetDb() })

function call(s: TestServer, userId: string, method: string, path: string, body?: unknown) {
  return s.request(path, {
    method,
    headers: { Authorization: bearer(userId), 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function setup(workerCount: number) {
  const { user: admin, workspace } = await seedUserWithWorkspace('admin@example.test')
  const site = await prisma.opsJobSite.create({ data: {
    workspaceId: workspace.id, jobCode: 'STRESS', siteName: 'Stress site',
  } })
  const workers: Array<{ userId: string; crewId: string }> = []
  for (let i = 0; i < workerCount; i++) {
    const u = await seedUser(`worker-${i}@example.test`)
    await prisma.membership.create({ data: { workspaceId: workspace.id, userId: u.id, role: 'member' } })
    const c = await prisma.opsCrewMember.create({ data: {
      workspaceId: workspace.id, employeeCode: `W-${i}`, fullName: `Worker ${i}`, role: 'TECH', userId: u.id,
    } })
    workers.push({ userId: u.id, crewId: c.id })
  }
  async function newJob() {
    const job = await prisma.job.create({ data: { workspaceId: workspace.id, opsJobSiteId: site.id } })
    for (const w of workers) {
      const r = await call(tech, admin.id, 'POST', `/api/ops/technician/${job.id}/assignments`, {
        workspaceId: workspace.id, crewMemberId: w.crewId,
      })
      assert.equal(r.status, 201, JSON.stringify(r.body))
    }
    return job
  }
  const ws = workspace.id
  const submit = (w: { userId: string }, jobId: string, submissionId = randomUUID()) =>
    call(tech, w.userId, 'POST', `/api/ops/technician/${jobId}/evidence`, {
      workspaceId: ws, kind: 'NOTE', submissionId, note: `note ${submissionId}`,
    })
  const revoke = (jobId: string, crewId: string) =>
    call(tech, admin.id, 'DELETE', `/api/ops/technician/${jobId}/assignments/${crewId}?workspaceId=${ws}`)
  const closeout = (jobId: string) =>
    call(delivery, admin.id, 'POST', `/api/delivery/jobs/${jobId}/closeout`, { workspaceId: ws })
  return { admin, ws, workers, newJob, submit, revoke, closeout }
}

const ROUNDS = 8
const SUBMITS = 6

test('closeout racing concurrent submissions is atomic: every 201 has a row, no row without a 201', async () => {
  const s = await setup(3)
  for (let round = 0; round < ROUNDS; round++) {
    const job = await s.newJob()
    const submits = Array.from({ length: SUBMITS }, (_, i) => s.submit(s.workers[i % 3], job.id))
    const [closed, ...results] = await Promise.all([s.closeout(job.id), ...submits])
    assert.equal(closed.status, 200, JSON.stringify(closed.body))
    const created = results.filter(r => r.status === 201).map(r => r.body.evidence.id as string)
    for (const r of results) assert.ok([201, 409].includes(r.status), `unexpected ${r.status} ${JSON.stringify(r.body)}`)
    const rows = await prisma.jobTechnicianEvidence.findMany({ where: { jobId: job.id }, select: { id: true } })
    assert.deepEqual(rows.map(r => r.id).sort(), created.sort(), 'rows must match accepted submissions exactly')
    assert.equal((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status, 'COMPLETE')
    // Once closeout has returned, nothing more is accepted.
    assert.equal((await s.submit(s.workers[0], job.id)).status, 409)
    assert.equal(await prisma.jobTechnicianEvidence.count({ where: { jobId: job.id } }), rows.length)
  }
})

test('revocation racing in-flight submissions: accepted evidence is committed, later submissions are refused', async () => {
  const s = await setup(2)
  const victim = s.workers[0]
  for (let round = 0; round < ROUNDS; round++) {
    const job = await s.newJob()
    const submits = Array.from({ length: SUBMITS }, () => s.submit(victim, job.id))
    const [revoked, ...results] = await Promise.all([s.revoke(job.id, victim.crewId), ...submits])
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body))
    const created = results.filter(r => r.status === 201).map(r => r.body.evidence.id as string)
    for (const r of results) assert.ok([201, 403].includes(r.status), `unexpected ${r.status} ${JSON.stringify(r.body)}`)
    const rows = await prisma.jobTechnicianEvidence.findMany({ where: { jobId: job.id }, select: { id: true } })
    assert.deepEqual(rows.map(r => r.id).sort(), created.sort())
    assert.equal(await prisma.jobTechnicianAssignment.count({ where: { jobId: job.id, crewMemberId: victim.crewId } }), 0)
    assert.equal((await s.submit(victim, job.id)).status, 403)
    // Historical evidence is retained, and an untouched colleague is unaffected.
    assert.equal(await prisma.jobTechnicianEvidence.count({ where: { jobId: job.id } }), rows.length)
    assert.equal((await s.submit(s.workers[1], job.id)).status, 201)
  }
})

test('revocation and closeout both wait for a submission holding the Job lock, and then resolve without deadlock', async () => {
  const s = await setup(1)
  const w = s.workers[0]
  const job = await s.newJob()

  let release!: () => void
  const held = new Promise<void>((r) => { release = r })
  let locked!: () => void
  const lockedP = new Promise<void>((r) => { locked = r })
  const holder = prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Job" WHERE "id" = ${job.id} FOR UPDATE`
    locked()
    await held
  }, { timeout: 20_000 })
  await lockedP

  const settled = { revoke: false, closeout: false, submit: false }
  const revoke = s.revoke(job.id, w.crewId).then((r) => { settled.revoke = true; return r })
  const closeout = s.closeout(job.id).then((r) => { settled.closeout = true; return r })
  const submit = s.submit(w, job.id).then((r) => { settled.submit = true; return r })
  await new Promise((r) => setTimeout(r, 500))
  assert.deepEqual(settled, { revoke: false, closeout: false, submit: false }, 'all three must block on the held Job lock')

  release()
  await holder
  const [rv, co, sb] = await Promise.all([revoke, closeout, submit])
  assert.equal(rv.status, 200, JSON.stringify(rv.body))
  assert.equal(co.status, 200, JSON.stringify(co.body))
  assert.ok([201, 403, 409].includes(sb.status), `unexpected ${sb.status} ${JSON.stringify(sb.body)}`)
  const rows = await prisma.jobTechnicianEvidence.count({ where: { jobId: job.id } })
  assert.equal(rows, sb.status === 201 ? 1 : 0)
})

test('many concurrent retries of one submissionId create exactly one row', async () => {
  const s = await setup(1)
  const w = s.workers[0]
  const job = await s.newJob()
  const submissionId = randomUUID()
  const results = await Promise.all(Array.from({ length: 8 }, () => s.submit(w, job.id, submissionId)))
  assert.equal(results.filter(r => r.status === 201).length, 1, JSON.stringify(results.map(r => r.status)))
  assert.equal(results.filter(r => r.status === 200).length, 7)
  assert.equal(new Set(results.map(r => r.body.evidence.id)).size, 1)
  assert.equal(await prisma.jobTechnicianEvidence.count({ where: { jobId: job.id } }), 1)
})
