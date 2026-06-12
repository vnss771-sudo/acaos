// Database-backed tests for the extracted worker processors (no Redis needed —
// the processor functions are called directly against a real database).

import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { scoreProspects, calibrateScoring } from '../apps/worker/src/processors.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace } from './helpers/db.ts'

after(async () => { await disconnect() })
beforeEach(async () => { await resetDb() })

async function seedProspect(workspaceId: string, opts: { industry?: string; employeeCount?: number } = {}) {
  return prisma.prospect.create({
    data: {
      workspaceId,
      companyName: 'Acme',
      industry: opts.industry ?? 'construction',
      employeeCount: opts.employeeCount ?? 50,
      contactEmail: 'c@acme.test',
      contactName: 'Cee',
      domain: 'acme.test',
    },
  })
}

// --- scoreProspects ---

test('scoreProspects recomputes scores for every prospect and reports the count', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const p1 = await seedProspect(workspace.id)
  await prisma.signal.create({
    data: { workspaceId: workspace.id, prospectId: p1.id, type: 'FUNDING', strength: 90, sourceReliability: 90, industryRelevance: 90 },
  })
  await seedProspect(workspace.id) // a second prospect with no signals

  const result = await scoreProspects(workspace.id)
  assert.equal(result.updated, 2)

  const scored = await prisma.prospect.findUnique({ where: { id: p1.id } })
  assert.ok(scored!.opportunityScore > 0, 'a funded prospect should score above zero')
  assert.ok(scored!.winProbability !== null)
})

test('scoreProspects on an empty workspace updates nothing', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const result = await scoreProspects(workspace.id)
  assert.equal(result.updated, 0)
})

// --- calibrateScoring ---

async function seedOutcome(workspaceId: string, stage: 'WON' | 'LOST', signalType: string) {
  const prospect = await seedProspect(workspaceId)
  await prisma.signal.create({
    data: { workspaceId, prospectId: prospect.id, type: signalType as any, strength: 80 },
  })
  await prisma.prospectOutcome.create({ data: { workspaceId, prospectId: prospect.id, stage } })
}

test('calibrateScoring no-ops below the minimum sample size', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await seedOutcome(workspace.id, 'WON', 'FUNDING')

  const stats = await calibrateScoring(workspace.id)
  assert.equal(stats.calibrated, false)
  assert.equal(stats.reason, 'insufficient data')
  assert.equal(await prisma.scoringModel.count({ where: { workspaceId: workspace.id } }), 0)
})

test('calibrateScoring derives signal weights and an ICP from WON/LOST outcomes', async () => {
  const { workspace } = await seedUserWithWorkspace()
  // 8 WON (FUNDING) + 4 LOST (PROCUREMENT) = 12 outcomes (>= the 10 minimum).
  for (let i = 0; i < 8; i++) await seedOutcome(workspace.id, 'WON', 'FUNDING')
  for (let i = 0; i < 4; i++) await seedOutcome(workspace.id, 'LOST', 'PROCUREMENT')

  const stats = await calibrateScoring(workspace.id)
  assert.equal(stats.calibrated, true)
  assert.equal(stats.totalOutcomes, 12)
  assert.ok(Math.abs(stats.baselineWinRate - 8 / 12) < 1e-9)

  // A scoring model with signal weights was persisted.
  const model = await prisma.scoringModel.findUnique({ where: { workspaceId: workspace.id } })
  assert.ok(model, 'scoring model created')
  const weights = model!.signalWeights as Record<string, number>
  assert.ok(weights.FUNDING > 0, 'FUNDING weight learned')

  // The ICP was updated from the WON prospects (all construction).
  const icp = await prisma.workspaceICP.findUnique({ where: { workspaceId: workspace.id } })
  assert.ok(icp!.targetIndustries.includes('construction'))
})

test('calibrateScoring is idempotent-safe: a second run increments updateCount', async () => {
  const { workspace } = await seedUserWithWorkspace()
  for (let i = 0; i < 8; i++) await seedOutcome(workspace.id, 'WON', 'FUNDING')
  for (let i = 0; i < 4; i++) await seedOutcome(workspace.id, 'LOST', 'HIRING')

  await calibrateScoring(workspace.id)
  await calibrateScoring(workspace.id)
  const model = await prisma.scoringModel.findUnique({ where: { workspaceId: workspace.id } })
  assert.equal(model!.updateCount, 1) // create then one update
})
