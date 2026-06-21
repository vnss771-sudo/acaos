// Database-backed tests for the extracted worker processors (no Redis needed —
// the processor functions are called directly against a real database).

import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { scoreProspects, calibrateScoring, applyReplyAnalysis } from '../apps/worker/src/processors.ts'
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

// --- applyReplyAnalysis (analyze-reply DB effects) ---

async function seedRepliedLeadWithSend(workspaceId: string, email = 'replier@x.test') {
  const lead = await prisma.lead.create({
    data: { workspaceId, businessName: 'Acme', email, stage: 'OUTREACH_SENT', score: 60 },
  })
  const send = await prisma.outreachSent.create({
    data: { workspaceId, leadId: lead.id, toEmail: email, subject: 's', body: 'b', status: 'REPLIED', repliedAt: new Date() },
  })
  return { lead, send }
}

test('applyReplyAnalysis stamps reply metadata on the send, advances the lead, and records an outcome', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const { lead, send } = await seedRepliedLeadWithSend(workspace.id)

  await applyReplyAnalysis(lead.id, {
    classification: 'INTERESTED',
    summary: 'Wants a call next week',
    keyQuote: 'send some times',
    suggestedAction: 'Propose three slots',
    urgency: 'this_week',
    confidence: 91,
    isAutoReply: false,
  })

  const updatedSend = await prisma.outreachSent.findUnique({ where: { id: send.id } })
  assert.equal(updatedSend!.replyIntent, 'INTERESTED')
  assert.equal(updatedSend!.replySummary, 'Wants a call next week')
  assert.equal(updatedSend!.replySuggestedAction, 'Propose three slots')
  assert.equal(updatedSend!.replyConfidence, 91)

  const updatedLead = await prisma.lead.findUnique({ where: { id: lead.id } })
  assert.equal(updatedLead!.stage, 'REPLIED')

  const outcome = await prisma.scoringOutcome.findFirst({ where: { leadId: lead.id } })
  assert.ok(outcome, 'a scoring outcome was recorded')
  assert.equal(outcome!.replied, true)
  assert.equal(outcome!.prospectId, null) // lead-sourced outcome
})

test('applyReplyAnalysis on a NOT_INTERESTED reply marks the lead DEAD and outcome not-replied', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const { lead } = await seedRepliedLeadWithSend(workspace.id)

  await applyReplyAnalysis(lead.id, { classification: 'NOT_INTERESTED', isAutoReply: false })

  const updatedLead = await prisma.lead.findUnique({ where: { id: lead.id } })
  assert.equal(updatedLead!.stage, 'DEAD')
  const outcome = await prisma.scoringOutcome.findFirst({ where: { leadId: lead.id } })
  assert.equal(outcome!.replied, false)
})

test('applyReplyAnalysis on an auto-reply stamps the send but does NOT advance the lead or score', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const { lead, send } = await seedRepliedLeadWithSend(workspace.id)

  await applyReplyAnalysis(lead.id, { classification: 'OUT_OF_OFFICE', isAutoReply: true })

  const updatedSend = await prisma.outreachSent.findUnique({ where: { id: send.id } })
  assert.equal(updatedSend!.replyIsAutoReply, true)
  assert.equal(updatedSend!.replyIntent, 'OUT_OF_OFFICE')

  const updatedLead = await prisma.lead.findUnique({ where: { id: lead.id } })
  assert.equal(updatedLead!.stage, 'OUTREACH_SENT') // unchanged
  assert.equal(await prisma.scoringOutcome.count({ where: { leadId: lead.id } }), 0)
})
