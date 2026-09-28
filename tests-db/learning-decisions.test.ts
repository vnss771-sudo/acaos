// Human decisions on learning recommendations (lib/learningDecisions.ts)
// against real Postgres: apply, reject, revert, races, staleness, expiry,
// tenant isolation, validation, audit.

import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { prisma, resetDb, disconnect, seedUserWithWorkspace } from './helpers/db.ts'
import { decideRecommendation, DecisionError } from '../packages/backend-core/src/lib/learningDecisions.ts'

after(async () => { await disconnect() })
beforeEach(async () => { await resetDb() })

async function setup(opts: { type?: string; currentValue?: unknown; proposedValue?: unknown; createdAt?: Date } = {}) {
  const { user, workspace } = await seedUserWithWorkspace()
  await prisma.workspaceICP.create({
    data: { workspaceId: workspace.id, targetIndustries: ['HVAC', 'Plumbing'], targetGeos: [], minEmployees: 5, maxEmployees: 500 },
  })
  const rec = await prisma.learningRecommendation.create({
    data: {
      workspaceId: workspace.id,
      type: opts.type ?? 'ICP_INDUSTRY',
      currentValue: (opts.currentValue ?? ['HVAC', 'Plumbing']) as never,
      proposedValue: (opts.proposedValue ?? ['electrical']) as never,
      evidence: { baselineWinRate: 0.2 }, sampleSize: 40, mode: 'shadow',
      ...(opts.createdAt && { createdAt: opts.createdAt }),
    },
  })
  return { user, workspace, rec }
}
const icpOf = (workspaceId: string) => prisma.workspaceICP.findUniqueOrThrow({ where: { workspaceId } })
const decide = (w: { id: string }, r: { id: string }, u: { id: string }, action: 'approve' | 'reject' | 'revert') =>
  decideRecommendation({ workspaceId: w.id, recommendationId: r.id, actorUserId: u.id, action })
async function rejectsWith(p: Promise<unknown>, status: number) {
  await assert.rejects(p, (e: unknown) => e instanceof DecisionError && e.status === status)
}

test('approve applies the proposal, records who/when, and writes a durable audit event', async () => {
  const { user, workspace, rec } = await setup()
  const out = await decide(workspace, rec, user, 'approve')
  assert.equal(out.status, 'APPROVED')
  assert.equal(out.decidedBy, user.id)
  assert.deepEqual((await icpOf(workspace.id)).targetIndustries, ['electrical'])
  const audit = await prisma.auditEvent.findFirst({ where: { workspaceId: workspace.id, type: 'learning.recommendation.approved' } })
  assert.deepEqual((audit!.metadata as { before: unknown; after: unknown }).before, ['HVAC', 'Plumbing'])
  assert.deepEqual((audit!.metadata as { before: unknown; after: unknown }).after, ['electrical'])
})

test('race: two interleaved approvals apply once; the other gets 409', async () => {
  const { user, workspace, rec } = await setup()
  // Force a true interleave: a third transaction holds the row lock, so both
  // approvals read PENDING and then queue on the same row. Only the atomic
  // conditional transition can stop the second one from applying again.
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  const holder = prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "LearningRecommendation" WHERE id = ${rec.id} FOR UPDATE`
    await gate
  }, { timeout: 15_000 })
  await new Promise((r) => setTimeout(r, 100))
  const both = Promise.allSettled([decide(workspace, rec, user, 'approve'), decide(workspace, rec, user, 'approve')])
  await new Promise((r) => setTimeout(r, 500))
  release()
  await holder
  const results = await both
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  const rejected = results.find(r => r.status === 'rejected') as PromiseRejectedResult
  assert.ok(rejected.reason instanceof DecisionError && rejected.reason.status === 409)
  assert.equal(await prisma.auditEvent.count({ where: { type: 'learning.recommendation.approved' } }), 1)
})

test('stale: if the ICP was edited after the proposal, approval is refused and the edit is kept', async () => {
  const { user, workspace, rec } = await setup()
  await prisma.workspaceICP.update({ where: { workspaceId: workspace.id }, data: { targetIndustries: ['Roofing'] } })
  await rejectsWith(decide(workspace, rec, user, 'approve'), 409)
  assert.deepEqual((await icpOf(workspace.id)).targetIndustries, ['Roofing'])
  assert.equal((await prisma.learningRecommendation.findUniqueOrThrow({ where: { id: rec.id } })).status, 'PENDING')
})

test('expired proposals cannot be approved', async () => {
  const { user, workspace, rec } = await setup({ createdAt: new Date(Date.now() - 31 * 86_400_000) })
  await rejectsWith(decide(workspace, rec, user, 'approve'), 410)
  assert.equal((await prisma.learningRecommendation.findUniqueOrThrow({ where: { id: rec.id } })).status, 'EXPIRED')
  assert.deepEqual((await icpOf(workspace.id)).targetIndustries, ['HVAC', 'Plumbing'])
})

test('reject changes nothing, and a rejected proposal cannot later be approved', async () => {
  const { user, workspace, rec } = await setup()
  assert.equal((await decide(workspace, rec, user, 'reject')).status, 'REJECTED')
  await rejectsWith(decide(workspace, rec, user, 'approve'), 409)
  assert.deepEqual((await icpOf(workspace.id)).targetIndustries, ['HVAC', 'Plumbing'])
})

test('revert restores the previous value; a pending proposal cannot be reverted', async () => {
  const { user, workspace, rec } = await setup()
  await rejectsWith(decide(workspace, rec, user, 'revert'), 409)
  await decide(workspace, rec, user, 'approve')
  assert.equal((await decide(workspace, rec, user, 'revert')).status, 'REVERTED')
  assert.deepEqual((await icpOf(workspace.id)).targetIndustries, ['HVAC', 'Plumbing'])
  assert.equal(await prisma.auditEvent.count({ where: { type: 'learning.recommendation.reverted' } }), 1)
})

test('revert is refused when settings changed after the approval (newer edits are kept)', async () => {
  const { user, workspace, rec } = await setup()
  await decide(workspace, rec, user, 'approve')
  await prisma.workspaceICP.update({ where: { workspaceId: workspace.id }, data: { targetIndustries: ['Solar'] } })
  await rejectsWith(decide(workspace, rec, user, 'revert'), 409)
  assert.deepEqual((await icpOf(workspace.id)).targetIndustries, ['Solar'])
})

test('size and signal-weight proposals apply to the right place', async () => {
  const size = await setup({ type: 'ICP_SIZE', currentValue: { minEmployees: 5, maxEmployees: 500 }, proposedValue: { minEmployees: 20, maxEmployees: 80 } })
  await decide(size.workspace, size.rec, size.user, 'approve')
  const icp = await icpOf(size.workspace.id)
  assert.deepEqual([icp.minEmployees, icp.maxEmployees], [20, 80])

  const sig = await setup({ type: 'SIGNAL_WEIGHT', currentValue: {}, proposedValue: { FUNDING: 90, HIRING: 40 } })
  await decide(sig.workspace, sig.rec, sig.user, 'approve')
  const model = await prisma.scoringModel.findUniqueOrThrow({ where: { workspaceId: sig.workspace.id } })
  assert.deepEqual(model.signalWeights, { FUNDING: 90, HIRING: 40 })
})

test('tenant isolation: a recommendation cannot be decided through another workspace', async () => {
  const a = await setup()
  const b = await seedUserWithWorkspace()
  await rejectsWith(decide(b.workspace, a.rec, b.user, 'approve'), 404)
  assert.deepEqual((await icpOf(a.workspace.id)).targetIndustries, ['HVAC', 'Plumbing'])
})

test('an invalid stored value is never applied', async () => {
  const { user, workspace, rec } = await setup({ proposedValue: [{ not: 'a string' }] })
  await rejectsWith(decide(workspace, rec, user, 'approve'), 422)
  assert.deepEqual((await icpOf(workspace.id)).targetIndustries, ['HVAC', 'Plumbing'])
  assert.equal((await prisma.learningRecommendation.findUniqueOrThrow({ where: { id: rec.id } })).status, 'PENDING')
})

test('atomic: if the audit write fails, neither the config change nor the status change persists', async () => {
  const { user, workspace, rec } = await setup()
  await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION acaos_test_fail_audit() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$ LANGUAGE plpgsql`)
  await prisma.$executeRawUnsafe(`CREATE TRIGGER acaos_test_fail_audit BEFORE INSERT ON "AuditEvent" FOR EACH ROW EXECUTE FUNCTION acaos_test_fail_audit()`)
  try {
    await assert.rejects(decide(workspace, rec, user, 'approve'), /audit unavailable/)
  } finally {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS acaos_test_fail_audit ON "AuditEvent"`)
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS acaos_test_fail_audit()`)
  }
  assert.deepEqual((await icpOf(workspace.id)).targetIndustries, ['HVAC', 'Plumbing'], 'config unchanged')
  assert.equal((await prisma.learningRecommendation.findUniqueOrThrow({ where: { id: rec.id } })).status, 'PENDING', 'status unchanged')
})

test('undo restores the exact stored previous value (not a recomputed one), and is audited in the same transaction', async () => {
  const { user, workspace, rec } = await setup({ type: 'ICP_SIZE', currentValue: { minEmployees: 7, maxEmployees: 333 }, proposedValue: { minEmployees: 20, maxEmployees: 80 } })
  await prisma.workspaceICP.update({ where: { workspaceId: workspace.id }, data: { minEmployees: 7, maxEmployees: 333 } })
  await decide(workspace, rec, user, 'approve')
  await decide(workspace, rec, user, 'revert')
  const icp = await icpOf(workspace.id)
  assert.deepEqual([icp.minEmployees, icp.maxEmployees], [7, 333])
  const undo = await prisma.auditEvent.findFirstOrThrow({ where: { type: 'learning.recommendation.reverted' } })
  assert.deepEqual((undo.metadata as { after: unknown }).after, { minEmployees: 7, maxEmployees: 333 })
})
