// Database-backed tests for the extracted worker processors (no Redis needed —
// the processor functions are called directly against a real database).

import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { scoreProspects, calibrateScoring, applyReplyAnalysis, researchLead, generateOutreachDraft } from '../apps/worker/src/processors.ts'
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

test('applyReplyAnalysis on a HIGH-confidence NOT_INTERESTED marks the lead DEAD and outcome not-replied', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const { lead } = await seedRepliedLeadWithSend(workspace.id)

  await applyReplyAnalysis(lead.id, { classification: 'NOT_INTERESTED', confidence: 95, isAutoReply: false })

  const updatedLead = await prisma.lead.findUnique({ where: { id: lead.id } })
  assert.equal(updatedLead!.stage, 'DEAD')
  const outcome = await prisma.scoringOutcome.findFirst({ where: { leadId: lead.id } })
  assert.equal(outcome!.replied, false)
})

test('applyReplyAnalysis confidence-gates a LOW-confidence NOT_INTERESTED: lead kept (REPLIED), not DEAD', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const { lead, send } = await seedRepliedLeadWithSend(workspace.id)

  // The model says NOT_INTERESTED but is only 30% confident — must NOT irreversibly
  // kill the lead. It's downgraded to a conservative REPLIED for human review.
  await applyReplyAnalysis(lead.id, { classification: 'NOT_INTERESTED', confidence: 30, isAutoReply: false })

  const updatedLead = await prisma.lead.findUnique({ where: { id: lead.id } })
  assert.equal(updatedLead!.stage, 'REPLIED', 'a shaky negative does not auto-kill the lead')
  // The RAW classification + confidence are still recorded on the send for the inbox.
  const updatedSend = await prisma.outreachSent.findUnique({ where: { id: send.id } })
  assert.equal(updatedSend!.replyIntent, 'NOT_INTERESTED')
  assert.equal(updatedSend!.replyConfidence, 30)
  // The scoring outcome reflects the gated (conservative) value, not a false negative.
  const outcome = await prisma.scoringOutcome.findFirst({ where: { leadId: lead.id } })
  assert.equal(outcome!.replied, true)
})

test('applyReplyAnalysis: a NOT_INTERESTED with no confidence is treated conservatively (kept)', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const { lead } = await seedRepliedLeadWithSend(workspace.id)

  await applyReplyAnalysis(lead.id, { classification: 'NOT_INTERESTED', isAutoReply: false })

  const updatedLead = await prisma.lead.findUnique({ where: { id: lead.id } })
  assert.equal(updatedLead!.stage, 'REPLIED', 'absent confidence fails safe — lead is kept, not killed')
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

test('applyReplyAnalysis feeds the SAME learning loop as POST /api/outcomes: the 7th outcome retunes weights', async () => {
  const { workspace } = await seedUserWithWorkspace()

  // The first 6 replies must not trigger a recompute yet.
  for (let i = 0; i < 6; i += 1) {
    const { lead } = await seedRepliedLeadWithSend(workspace.id, `replier-${i}@x.test`)
    await applyReplyAnalysis(lead.id, { classification: 'INTERESTED', confidence: 90, isAutoReply: false })
  }
  const modelBefore = await prisma.scoringModel.findUnique({ where: { workspaceId: workspace.id } })
  assert.ok(modelBefore, 'a scoring model exists after the first outcome')
  assert.equal(modelBefore!.updateCount, 0, 'fewer than 7 outcomes must not retune weights yet')

  // The 7th reply crosses the recompute threshold.
  const { lead: seventhLead } = await seedRepliedLeadWithSend(workspace.id, 'replier-6@x.test')
  await applyReplyAnalysis(seventhLead.id, { classification: 'INTERESTED', confidence: 90, isAutoReply: false })

  const modelAfter = await prisma.scoringModel.findUnique({ where: { workspaceId: workspace.id } })
  assert.equal(await prisma.scoringOutcome.count({ where: { workspaceId: workspace.id } }), 7)
  assert.equal(modelAfter!.updateCount, 1, 'the 7th outcome from the product\'s own reply pipeline must trigger a retune, matching the external FieldOps ingest path')
  assert.ok(modelAfter!.lastWeightUpdate, 'lastWeightUpdate must be stamped')
})

// --- researchLead (extracted from worker.ts's research-lead handler) ---

test('researchLead persists the intelligence snapshot, evidence rows, and score; advances the lead to RESEARCHED', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const lead = await prisma.lead.create({
    data: { workspaceId: workspace.id, businessName: 'Acme Plumbing', website: 'https://acmeplumbing.test', category: 'plumbing', stage: 'NEW' },
  })

  const raw = JSON.stringify({
    aiSummary: 'Growing plumbing contractor hiring field technicians.',
    outreachAngle: 'Scaling dispatch across crews',
    evidence: [{ signal: 'Hiring plumbers', type: 'confirmed', confidence: 'high', sourceUrl: 'https://acmeplumbing.test/careers' }],
    riskFlags: [],
    recommendedAction: 'auto_draft',
    confidence: 'high',
    icpScore: 80,
    estimatedTeamSize: '10-50',
  })

  const result = await researchLead(lead.id, workspace.id, undefined, {
    generateLeadResearch: async () => raw,
  })

  assert.equal(result.leadId, lead.id)
  assert.ok(result.score > 0)
  assert.equal(result.recommendedAction, 'auto_draft')

  const updated = await prisma.lead.findUnique({ where: { id: lead.id } })
  assert.equal(updated!.stage, 'RESEARCHED')
  assert.equal(updated!.score, result.score)
  assert.ok(updated!.aiIntelligence, 'aiIntelligence snapshot must be persisted')

  const evidenceRows = await prisma.leadEvidenceSource.findMany({ where: { leadId: lead.id } })
  assert.equal(evidenceRows.length, 1)
  assert.equal(evidenceRows[0]!.sourceUrl, 'https://acmeplumbing.test/careers', 'sourceUrl matches the lead\'s own website domain, so it is kept')
})

test('researchLead drops a sourceUrl whose domain is unrelated to the lead\'s own website', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const lead = await prisma.lead.create({
    data: { workspaceId: workspace.id, businessName: 'Acme Plumbing', website: 'https://acmeplumbing.test', stage: 'NEW' },
  })

  const raw = JSON.stringify({
    aiSummary: 'Summary.',
    evidence: [{ signal: 'Some claim', type: 'confirmed', confidence: 'high', sourceUrl: 'https://totally-unrelated-site.example/' }],
  })

  await researchLead(lead.id, workspace.id, undefined, { generateLeadResearch: async () => raw })

  const evidenceRows = await prisma.leadEvidenceSource.findMany({ where: { leadId: lead.id } })
  assert.equal(evidenceRows.length, 1)
  assert.equal(evidenceRows[0]!.sourceUrl, null, 'a citation for an unrelated domain must not be kept as provenance')
})

test('researchLead throws for a lead outside the given workspace (tenant isolation)', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const other = await seedUserWithWorkspace('other-research@x.test')
  const otherLead = await prisma.lead.create({ data: { workspaceId: other.workspace.id, businessName: 'Other Co', stage: 'NEW' } })

  await assert.rejects(
    () => researchLead(otherLead.id, workspace.id, undefined, { generateLeadResearch: async () => '{}' }),
    /not found in workspace/,
  )
})

// --- generateOutreachDraft (extracted from worker.ts's generate-outreach handler) ---

async function seedResearchedLead(workspaceId: string, recommendedAction: string | undefined = 'auto_draft') {
  return prisma.lead.create({
    data: {
      workspaceId, businessName: 'Acme Plumbing', stage: 'RESEARCHED', score: 75,
      aiIntelligence: recommendedAction ? { recommendedAction } : undefined,
    },
  })
}

test('generateOutreachDraft persists a draft with the gated status and tone warnings', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const lead = await seedResearchedLead(workspace.id)

  const raw = JSON.stringify({ subject: 'Quick idea for Acme', email: 'Hi there, worth a quick chat?', followup: 'Following up — any thoughts?' })
  const result = await generateOutreachDraft(lead.id, workspace.id, undefined, undefined, { generateOutreach: async () => raw })

  assert.equal(result.skipped, undefined)
  assert.equal(result.subject, 'Quick idea for Acme')

  const drafts = await prisma.outreachDraft.findMany({ where: { leadId: lead.id } })
  assert.equal(drafts.length, 1)
  assert.equal(drafts[0]!.status, 'DRAFTED', 'auto_draft recommendedAction -> normal DRAFTED flow')
})

test('generateOutreachDraft suppresses a poor-fit ("skip") lead without calling the model, and refunds the AI credit', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const lead = await seedResearchedLead(workspace.id, 'skip')

  let generatorCalled = false
  const result = await generateOutreachDraft(lead.id, workspace.id, undefined, undefined, {
    generateOutreach: async () => { generatorCalled = true; return '{}' },
  })

  assert.equal(result.skipped, true)
  assert.equal(generatorCalled, false, 'a suppressed lead must never reach the model')

  const drafts = await prisma.outreachDraft.findMany({ where: { leadId: lead.id } })
  assert.equal(drafts.length, 0)

  const updated = await prisma.lead.findUnique({ where: { id: lead.id } })
  assert.ok(updated!.outreachSkippedAt)
})

test('generateOutreachDraft: a human override on a skipped lead generates into POLICY_REVIEW', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const lead = await seedResearchedLead(workspace.id, 'skip')

  const raw = JSON.stringify({ subject: 's', email: 'Worth a look?' })
  const result = await generateOutreachDraft(lead.id, workspace.id, true, undefined, { generateOutreach: async () => raw })

  assert.equal(result.skipped, undefined)
  const drafts = await prisma.outreachDraft.findMany({ where: { leadId: lead.id } })
  assert.equal(drafts.length, 1)
  assert.equal(drafts[0]!.status, 'POLICY_REVIEW')
})

test('generateOutreachDraft throws for a lead outside the given workspace (tenant isolation)', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const other = await seedUserWithWorkspace('other-outreach@x.test')
  const otherLead = await seedResearchedLead(other.workspace.id)

  await assert.rejects(
    () => generateOutreachDraft(otherLead.id, workspace.id, undefined, undefined, { generateOutreach: async () => '{}' }),
    /not found in workspace/,
  )
})
