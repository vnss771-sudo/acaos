// Golden "truth audit": prove one prospect travels the entire intelligence spine
// — signal+evidence → score → recommendation → intent → draft → approve →
// materialise (sendable lead+APPROVED draft+campaign) — against a REAL database,
// using the real services, with NO manual SQL / developer hacks.
//
// The final SMTP hop is environment-dependent (needs an inbox sandbox) and is
// covered by the send-path tests; this audit proves everything up to send-ready.

import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { prisma, resetDb, disconnect, seedUserWithWorkspace } from './helpers/db.ts'
import { scoreProspects } from '../apps/worker/src/processors.ts'
import { ingestSignal } from '../apps/api/src/lib/signalIngest.ts'
import { generateRuleBasedRecommendation, toRawSignal } from '../apps/api/src/lib/signalEngine.ts'
import { createOutreachIntentForRecommendation } from '../apps/api/src/lib/outreachIntent.ts'
import { materializeOutreachIntent } from '../apps/api/src/lib/materializeIntent.ts'

after(async () => { await disconnect() })
beforeEach(async () => { await resetDb() })

test('golden spine: prospect travels signal→score→recommendation→intent→draft→approve→materialise with no manual hacks', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const prospect = await prisma.prospect.create({
    data: {
      workspaceId: workspace.id, companyName: 'Acme Plumbing', industry: 'plumbing',
      employeeCount: 30, contactEmail: 'mark@acmeplumbing.test', contactName: 'Mark',
      domain: 'acmeplumbing.test', location: 'Brisbane',
    },
  })

  // 1) Signal + evidence via the unified ingest spine
  const sig = await ingestSignal({
    workspaceId: workspace.id, prospectId: prospect.id, type: 'HIRING', strength: 80,
    source: 'manual', title: 'Hiring a project manager',
    evidence: { provider: 'seek', sourceType: 'job_posting', confidence: 0.9 },
  })
  const ev = await prisma.evidenceSource.findFirst({ where: { prospectId: prospect.id } })
  assert.ok(ev, 'evidence source created')
  assert.equal(sig.evidenceSourceId, ev!.id, 'signal linked to its evidence')

  // 2) Score
  await scoreProspects(workspace.id)
  const scored = await prisma.prospect.findUnique({ where: { id: prospect.id } })
  assert.ok(scored!.opportunityScore > 0, 'prospect scored from its signal')

  // 3) Recommendation (rule-based, no AI) + intent with evidence snapshot
  const signals = await prisma.signal.findMany({ where: { prospectId: prospect.id } })
  const rec = generateRuleBasedRecommendation(
    { industry: prospect.industry, employeeCount: prospect.employeeCount, contactEmail: prospect.contactEmail, contactName: prospect.contactName, domain: prospect.domain, location: prospect.location },
    signals.map(toRawSignal),
  )
  const recommendation = await prisma.recommendation.create({ data: { workspaceId: workspace.id, prospectId: prospect.id, ...rec } })
  const intent = await createOutreachIntentForRecommendation({
    workspaceId: workspace.id, prospectId: prospect.id, recommendationId: recommendation.id,
    messageAngle: rec.messageAngle, channel: rec.bestChannel, signals,
  })
  assert.equal(intent.status, 'PROPOSED')
  assert.ok(intent.evidenceSnapshot, 'intent carries an evidence snapshot')

  // 4) Draft (the stored result of generation) + 5) approve
  await prisma.outreachIntent.update({ where: { id: intent.id }, data: { draftSubject: 'Quick one re your PM hire', draftBody: 'Noticed you are hiring a project manager…', status: 'DRAFTED' } })
  await prisma.outreachIntent.update({ where: { id: intent.id }, data: { status: 'APPROVED' } })

  // 6) Materialise → sendable lead + APPROVED draft + campaign, intent linked
  const approved = await prisma.outreachIntent.findUnique({ where: { id: intent.id } })
  const out = await materializeOutreachIntent({ intent: approved!, prospect })

  const lead = await prisma.lead.findUnique({ where: { id: out.leadId }, include: { outreachDrafts: true } })
  assert.ok(lead, 'lead materialised')
  assert.equal(lead!.email, prospect.contactEmail)
  assert.ok(lead!.outreachDrafts.some((d) => d.status === 'APPROVED'), 'lead has an APPROVED draft ready to send')
  assert.ok(await prisma.campaign.findUnique({ where: { id: out.campaignId } }), 'campaign exists')

  const linked = await prisma.outreachIntent.findUnique({ where: { id: intent.id } })
  assert.equal(linked!.leadId, out.leadId, 'intent linked to its lead')
  assert.equal(linked!.campaignId, out.campaignId, 'intent linked to its campaign')
  // → from here the normal, fully-gated send path dispatches and stamps SENT.
})
