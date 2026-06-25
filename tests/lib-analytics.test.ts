import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { trackEvent, computeActivationFunnel, getActivationFunnel, getWorkspaceActivation, ACTIVATION_STAGES } from '../packages/backend-core/src/lib/analytics.ts'
import { createFakePrisma, installPrisma, resetPrisma } from './helpers/integration.ts'

afterEach(() => resetPrisma())

test('computeActivationFunnel computes per-stage and from-top conversion', () => {
  const f = computeActivationFunnel({ signup: 100, 'icp.configured': 60, 'campaign.sent': 30, 'reply.received': 9 })
  assert.deepEqual(f.map((s) => s.key), ['signup', 'icp.configured', 'campaign.sent', 'reply.received'])
  assert.equal(f[0].conversionFromPrev, 1)
  assert.equal(f[0].conversionFromTop, 1)
  assert.equal(f[1].conversionFromPrev, 0.6) // 60/100
  assert.equal(f[2].conversionFromPrev, 0.5) // 30/60
  assert.equal(f[2].conversionFromTop, 0.3)  // 30/100
  assert.equal(f[3].conversionFromTop, 0.09) // 9/100
})

test('computeActivationFunnel handles an empty funnel without dividing by zero', () => {
  const f = computeActivationFunnel({})
  assert.equal(f.length, ACTIVATION_STAGES.length)
  for (const s of f) { assert.equal(s.count, 0); assert.equal(s.conversionFromTop, 0) }
  assert.equal(f[0].conversionFromPrev, 1) // top stage is always 1
})

test('trackEvent writes an event row and is best-effort (never throws)', async () => {
  let created: Record<string, unknown> | undefined
  installPrisma(createFakePrisma({ analyticsEvent: { create: async (a: any) => { created = a.data; return { id: 'e1', ...a.data } } } }))
  await trackEvent({ name: 'signup', userId: 'u1', workspaceId: 'w1', properties: { plan: 'free' } })
  assert.equal(created?.name, 'signup')
  assert.equal(created?.workspaceId, 'w1')

  // A DB failure must not propagate (analytics can't break the action it instruments).
  installPrisma(createFakePrisma({ analyticsEvent: { create: async () => { throw new Error('db down') } } }))
  await assert.doesNotReject(() => trackEvent({ name: 'signup' }))
})

test('getWorkspaceActivation reports completed milestones + the next step', async () => {
  // This workspace has signed up and configured ICP, but not sent or replied yet.
  const completed = new Set(['signup', 'icp.configured'])
  installPrisma(createFakePrisma({
    analyticsEvent: {
      findFirst: async (a: any) =>
        completed.has(a.where.name) ? { occurredAt: new Date('2026-06-01T00:00:00Z') } : null,
    },
  }))
  const act = await getWorkspaceActivation('w1')
  assert.equal(act.completedCount, 2)
  assert.equal(act.totalStages, ACTIVATION_STAGES.length)
  assert.equal(act.nextStep, 'campaign.sent') // first incomplete stage
  assert.equal(act.stages.find((s) => s.key === 'signup')?.completed, true)
  assert.equal(act.stages.find((s) => s.key === 'campaign.sent')?.completed, false)
  assert.ok(act.stages.find((s) => s.key === 'signup')?.completedAt)
})

test('getWorkspaceActivation: a fully-activated workspace has no next step', async () => {
  installPrisma(createFakePrisma({
    analyticsEvent: { findFirst: async () => ({ occurredAt: new Date('2026-06-01T00:00:00Z') }) },
  }))
  const act = await getWorkspaceActivation('w1')
  assert.equal(act.completedCount, ACTIVATION_STAGES.length)
  assert.equal(act.nextStep, null)
})

test('getActivationFunnel counts distinct workspaces per stage', async () => {
  // Distinct workspaces that reached each stage: signup 3, icp 2, sent 1, reply 0.
  const byStage: Record<string, string[]> = {
    signup: ['wa', 'wb', 'wc'], 'icp.configured': ['wa', 'wb'], 'campaign.sent': ['wa'], 'reply.received': [],
  }
  installPrisma(createFakePrisma({
    analyticsEvent: {
      findMany: async (a: any) => (byStage[a.where.name] ?? []).map((w) => ({ workspaceId: w })),
    },
  }))
  const f = await getActivationFunnel()
  assert.deepEqual(f.map((s) => s.count), [3, 2, 1, 0])
  assert.equal(f[1].conversionFromPrev, 0.67) // 2/3 rounded
})
