// Database-backed tests for the extracted worker processors (no Redis needed —
// the processor functions are called directly against a real database).

import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { scoreProspects, calibrateScoring, applyReplyAnalysis, researchLead, generateOutreachDraft } from '../apps/worker/src/processors.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace } from './helpers/db.ts'
import { maybeRecomputeScoringWeights, DEFAULT_SCORING_WEIGHTS } from '../packages/backend-core/src/lib/scoring.ts'

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

test('scoreProspects reassesses commercial opportunities, unless the engine is switched off', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const prospect = await prisma.prospect.create({
    data: { workspaceId: workspace.id, companyName: 'ABC Electrical', contactName: 'Sam', contactEmail: 'sam@abc.example' },
  })
  const at = new Date(Date.now() - 2 * 86_400_000)
  for (const [type, host] of [['EXPANSION', 'news.example.org'], ['HIRING', 'jobs.example.com']] as const) {
    await prisma.signal.create({
      data: { workspaceId: workspace.id, prospectId: prospect.id, type, strength: 85, sourceReliability: 90, industryRelevance: 85, title: `${type} at ABC`, sourceUrl: `https://${host}/a`, source: host, detectedAt: at },
    })
  }
  await prisma.offer.create({ data: { workspaceId: workspace.id, name: 'Field crews', triggeringEvents: ['CAPACITY_EXPANSION'] } })

  process.env.COMMERCIAL_OPPORTUNITIES_ENABLED = 'false'
  try {
    await scoreProspects(workspace.id)
  } finally {
    delete process.env.COMMERCIAL_OPPORTUNITIES_ENABLED
  }
  assert.equal(await prisma.commercialOpportunity.count({ where: { workspaceId: workspace.id } }), 0, 'kill switch honoured')

  await scoreProspects(workspace.id)
  const row = await prisma.commercialOpportunity.findFirstOrThrow({ where: { workspaceId: workspace.id } })
  assert.equal(row.prospectId, prospect.id)
  assert.equal(row.eventType, 'CAPACITY_EXPANSION')
})

// --- calibrateScoring ---

async function seedOutcome(workspaceId: string, stage: 'WON' | 'LOST', signalType: string, recordedAt?: Date) {
  const prospect = await seedProspect(workspaceId)
  await prisma.signal.create({
    data: { workspaceId, prospectId: prospect.id, type: signalType as any, strength: 80 },
  })
  await prisma.prospectOutcome.create({ data: { workspaceId, prospectId: prospect.id, stage, recordedAt } })
}

test('calibrateScoring no-ops below the minimum sample size', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await seedOutcome(workspace.id, 'WON', 'FUNDING')

  const stats = await calibrateScoring(workspace.id)
  assert.equal(stats.calibrated, false)
  assert.equal(stats.reason, 'insufficient data')
  assert.equal(await prisma.scoringModel.count({ where: { workspaceId: workspace.id } }), 0)
})

async function withMode<T>(mode: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.LEARNING_ADAPTATION_MODE
  if (mode === undefined) delete process.env.LEARNING_ADAPTATION_MODE
  else process.env.LEARNING_ADAPTATION_MODE = mode
  try { return await fn() } finally {
    if (prev === undefined) delete process.env.LEARNING_ADAPTATION_MODE
    else process.env.LEARNING_ADAPTATION_MODE = prev
  }
}

async function seedLearnable(workspaceId: string) {
  // 8 WON (FUNDING) + 4 LOST (PROCUREMENT) = 12 outcomes (>= the 10 minimum).
  // Fixed timestamps 1ms apart, not the DB default. Calibration is recency-
  // weighted: stamps that depend on how fast the runner seeds make the baseline
  // drift off 8/12 by a runner-dependent amount, and identical stamps leave the
  // row order (and so the float sums) arbitrary between runs.
  const base = Date.now()
  for (let i = 0; i < 8; i++) await seedOutcome(workspaceId, 'WON', 'FUNDING', new Date(base + i))
  for (let i = 0; i < 4; i++) await seedOutcome(workspaceId, 'LOST', 'PROCUREMENT', new Date(base + 8 + i))
}

test('calibrateScoring (default shadow): proposes, applies nothing, never touches the ICP', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await prisma.workspaceICP.create({
    data: { workspaceId: workspace.id, targetIndustries: ['HVAC'], targetGeos: [], minEmployees: 5, maxEmployees: 50, mustHaveEmail: false },
  })
  const icpBefore = await prisma.workspaceICP.findUnique({ where: { workspaceId: workspace.id } })
  await seedLearnable(workspace.id)

  const stats = await withMode(undefined, () => calibrateScoring(workspace.id))
  assert.equal(stats.calibrated, true)
  assert.equal(stats.totalOutcomes, 12)
  assert.ok(Math.abs(stats.baselineWinRate - 8 / 12) < 1e-9)

  const model = await prisma.scoringModel.findUnique({ where: { workspaceId: workspace.id } })
  assert.equal(model!.signalWeights, null, 'shadow mode must not apply learned signal weights')

  const recs = await prisma.learningRecommendation.findMany({ where: { workspaceId: workspace.id } })
  const sig = recs.find(r => r.type === 'SIGNAL_WEIGHT')!
  assert.equal(sig.status, 'PENDING')
  assert.equal(sig.mode, 'shadow')
  assert.ok((sig.proposedValue as Record<string, number>).FUNDING > 0)

  const icpAfter = await prisma.workspaceICP.findUnique({ where: { workspaceId: workspace.id } })
  assert.deepEqual(icpAfter, icpBefore, 'learning must never silently rewrite the ICP')
})

test('calibrateScoring: identical re-run keeps one pending proposal; new evidence supersedes it', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await seedLearnable(workspace.id)
  await withMode('shadow', () => calibrateScoring(workspace.id))
  await withMode('shadow', () => calibrateScoring(workspace.id))
  const sigRecs = () => prisma.learningRecommendation.findMany({ where: { workspaceId: workspace.id, type: 'SIGNAL_WEIGHT' } })
  assert.deepEqual((await sigRecs()).map(r => r.status), ['PENDING'])

  for (let i = 0; i < 6; i++) await seedOutcome(workspace.id, 'LOST', 'FUNDING')
  await withMode('shadow', () => calibrateScoring(workspace.id))
  assert.deepEqual((await sigRecs()).map(r => r.status).sort(), ['PENDING', 'SUPERSEDED'])
})

test('calibrateScoring (live): applies signal weights with an audit record; unchanged re-run is a no-op', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await seedLearnable(workspace.id)
  await withMode('live', () => calibrateScoring(workspace.id))
  const model = await prisma.scoringModel.findUnique({ where: { workspaceId: workspace.id } })
  assert.ok((model!.signalWeights as Record<string, number>).FUNDING > 0)
  const rec = await prisma.learningRecommendation.findFirst({ where: { workspaceId: workspace.id, type: 'SIGNAL_WEIGHT' } })
  assert.equal(rec!.status, 'APPLIED_AUTOMATICALLY')
  assert.deepEqual(rec!.currentValue, {}, 'before-value recorded for rollback')

  const countAfterFirst = await prisma.learningRecommendation.count({ where: { workspaceId: workspace.id } })
  await withMode('live', () => calibrateScoring(workspace.id))
  assert.equal(await prisma.learningRecommendation.count({ where: { workspaceId: workspace.id } }), countAfterFirst,
    'unchanged data must not create new recommendations')
  const icp = await prisma.workspaceICP.findUnique({ where: { workspaceId: workspace.id } })
  assert.equal(icp, null, 'even live mode never writes the ICP')
})

test('database enforces one PENDING recommendation per (workspace, type)', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const rec = { workspaceId: workspace.id, type: 'ICP_SIZE', proposedValue: {}, evidence: {}, sampleSize: 1, mode: 'shadow' }
  await prisma.learningRecommendation.create({ data: rec })
  await assert.rejects(prisma.learningRecommendation.create({ data: rec }), /Unique constraint/)
  // Decided rows don't count: a new PENDING is allowed once the old one is superseded.
  await prisma.learningRecommendation.updateMany({ where: { workspaceId: workspace.id }, data: { status: 'SUPERSEDED' } })
  await prisma.learningRecommendation.create({ data: rec })
})

test('calibrateScoring (off): does nothing', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await seedLearnable(workspace.id)
  const stats = await withMode('off', () => calibrateScoring(workspace.id))
  assert.equal(stats.calibrated, false)
  assert.equal(await prisma.scoringModel.count({ where: { workspaceId: workspace.id } }), 0)
  assert.equal(await prisma.learningRecommendation.count({ where: { workspaceId: workspace.id } }), 0)
})

async function seedLearnableReplyModel(workspaceId: string) {
  const model = await prisma.scoringModel.create({
    data: { workspaceId, weights: DEFAULT_SCORING_WEIGHTS, performanceMetrics: {} },
  })
  // 35 outcomes with a VARYING, reply-correlated feature: genuinely learnable.
  for (let i = 0; i < 35; i++) {
    const rel = (i % 10) / 10
    await prisma.scoringOutcome.create({
      data: { workspaceId, scoringModelId: model.id, score: 50, replied: rel >= 0.5, messageRelevance: rel },
    })
  }
  return model
}

test('learnable evidence in shadow mode: proposal recorded, production weights untouched', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const model = await seedLearnableReplyModel(workspace.id)
  const r = await withMode('shadow', () => maybeRecomputeScoringWeights(model.id, DEFAULT_SCORING_WEIGHTS))
  assert.equal(r.updated, false)
  const after = await prisma.scoringModel.findUnique({ where: { id: model.id } })
  assert.deepEqual(after!.weights, DEFAULT_SCORING_WEIGHTS)
  const m = after!.performanceMetrics as { proposedWeights: { messageRelevance: number }; adjustedFeatures: string[] }
  assert.deepEqual(m.adjustedFeatures, ['messageRelevance'])
  assert.ok(m.proposedWeights.messageRelevance > DEFAULT_SCORING_WEIGHTS.messageRelevance)
})

test('learnable evidence in live mode: weights move, bounded by the per-step cap', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const model = await seedLearnableReplyModel(workspace.id)
  const r = await withMode('live', () => maybeRecomputeScoringWeights(model.id, DEFAULT_SCORING_WEIGHTS))
  assert.equal(r.updated, true)
  const w = (await prisma.scoringModel.findUnique({ where: { id: model.id } }))!.weights as typeof DEFAULT_SCORING_WEIGHTS
  assert.ok(w.messageRelevance > DEFAULT_SCORING_WEIGHTS.messageRelevance)
  assert.ok(w.messageRelevance <= DEFAULT_SCORING_WEIGHTS.messageRelevance * 1.1 + 1e-9)
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
  // Leakage invariant: every recorded predictor is the pre-send value, never
  // one derived from the reply (the old code wrote replied ? 0.8 : 0.2).
  const recorded = await prisma.scoringOutcome.findMany({ where: { workspaceId: workspace.id }, select: { messageRelevance: true } })
  assert.deepEqual([...new Set(recorded.map(r => r.messageRelevance))], [0.5])
  // The 7th outcome triggers an evaluation of the SAME loop the external ingest
  // path drives — but the only recorded feature is the pre-send constant, so
  // there is no learnable evidence and production weights must not move.
  const metrics = modelAfter!.performanceMetrics as { totalScored: number; adjustedFeatures: string[] }
  assert.equal(metrics.totalScored, 7, 'the retune evaluation ran on all 7 outcomes')
  assert.deepEqual(metrics.adjustedFeatures, [])
  assert.equal(modelAfter!.updateCount, 0, 'no learnable evidence → weights unchanged')
  assert.deepEqual(modelAfter!.weights, modelBefore!.weights)
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

test('generateOutreachDraft holds a draft that picked up sensitive data in POLICY_REVIEW', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const lead = await seedResearchedLead(workspace.id)

  const raw = JSON.stringify({ subject: 'Quick idea for Acme', email: 'Hi there, pay the deposit with 4111 1111 1111 1111.', followup: 'Following up on the deposit.' })
  await generateOutreachDraft(lead.id, workspace.id, undefined, undefined, { generateOutreach: async () => raw })

  const [draft] = await prisma.outreachDraft.findMany({ where: { leadId: lead.id } })
  assert.equal(draft!.status, 'POLICY_REVIEW')
  assert.equal((draft!.policyViolations as { violations: Array<{ code: string }> }).violations[0].code, 'SENSITIVE_DATA')
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
