// Intelligence → execution: opportunity → recommendation → OutreachIntent.
//
// An operator turns an opportunity's live, bridged outreach recommendation into
// a PROPOSED OutreachIntent. The intent carries the evidence snapshot and the
// grounding record (the verified facts its draft may use). From there the
// existing path takes over: draft → approval → materialise → send, with its
// policy checks, approval mode, suppression and send caps. Nothing sends here.
//
// Idempotent: one intent per bridged recommendation; asking again returns it.
// Creating the intent marks the recommendation acted on, so rescoring no longer
// rewrites what the intent was proposed from.
import { prisma } from './prisma.js'
import { bridgesRecommendation } from './commercialOpportunityStore.js'
import { factsFromCitations, initialGrounding } from './draftGrounding.js'
import type { OpportunityRecommendation } from './recommendationEngine.js'

export const OPPORTUNITY_INTENT_ORIGIN = 'OPPORTUNITY'

export type ProposeIntentResult =
  | { ok: true; created: boolean; intentId: string }
  | { ok: false; status: 404 | 409; error: string }

type OpportunityRow = {
  id: string
  prospectId: string
  missionId: string | null
  status: string
  recommendation: OpportunityRecommendation | null
  offer: { name: string; problemSolved: string | null; proofPoints: string[]; recommendedActions: string[] } | null
}

type BridgeRow = { id: string; expiresAt: Date | null; outreachIntent: { id: string } | null }

export async function proposeIntentForOpportunity(input: {
  workspaceId: string
  opportunityId: string
  now?: Date
}): Promise<ProposeIntentResult> {
  const now = input.now ?? new Date()
  const opp = await prisma.commercialOpportunity.findFirst({
    where: { id: input.opportunityId, workspaceId: input.workspaceId },
    select: {
      id: true, prospectId: true, missionId: true, status: true, recommendation: true,
      offer: { select: { name: true, problemSolved: true, proofPoints: true, recommendedActions: true } },
    },
  }) as OpportunityRow | null
  if (!opp) return { ok: false, status: 404, error: 'Opportunity not found' }

  const bridge = await prisma.recommendation.findFirst({
    where: { workspaceId: input.workspaceId, commercialOpportunityId: opp.id },
    select: { id: true, expiresAt: true, outreachIntent: { select: { id: true } } },
  }) as BridgeRow | null
  if (bridge?.outreachIntent) return { ok: true, created: false, intentId: bridge.outreachIntent.id }

  if (!bridgesRecommendation(opp.status)) {
    return { ok: false, status: 409, error: `Opportunity is ${opp.status.toLowerCase()} — only open or pursued opportunities get outreach` }
  }
  const rec = opp.recommendation
  if (!rec || !rec.outreach) {
    return { ok: false, status: 409, error: rec ? `The recommendation is "${rec.label}" — not an outreach move` : 'No recommendation — the opportunity can\'t be explained yet' }
  }
  // Gate 2 carried into execution: no outreach without cited evidence.
  if (rec.citations.length === 0) return { ok: false, status: 409, error: 'The recommendation cites no evidence' }
  if (!bridge || (bridge.expiresAt && bridge.expiresAt <= now)) {
    return { ok: false, status: 409, error: 'The recommendation is no longer live — refresh the opportunity' }
  }

  const facts = factsFromCitations(rec.citations)
  const context = opp.offer
    ? [opp.offer.name, opp.offer.problemSolved ?? '', ...opp.offer.proofPoints, ...opp.offer.recommendedActions]
    : []
  const create = () => prisma.$transaction(async (tx) => {
    const created = await tx.outreachIntent.create({
      data: {
        workspaceId: input.workspaceId,
        prospectId: opp.prospectId,
        recommendationId: bridge.id,
        commercialOpportunityId: opp.id,
        missionId: opp.missionId,
        status: 'PROPOSED',
        origin: OPPORTUNITY_INTENT_ORIGIN,
        messageAngle: rec.headline,
        channel: 'email',
        evidenceSnapshot: {
          capturedAt: now.toISOString(),
          source: 'COMMERCIAL_OPPORTUNITY',
          opportunityId: opp.id,
          recommendationKind: rec.kind,
          why: rec.why,
          citations: rec.citations,
        },
        grounding: initialGrounding(facts, context),
      },
      select: { id: true },
    })
    await tx.recommendation.update({ where: { id: bridge.id }, data: { actedAt: now } })
    return created as { id: string }
  })
  try {
    const intent = await create()
    return { ok: true, created: true, intentId: intent.id }
  } catch (e) {
    // A concurrent request won the unique recommendationId: return its intent.
    if ((e as { code?: string }).code !== 'P2002') throw e
    const existing = await prisma.outreachIntent.findFirst({
      where: { workspaceId: input.workspaceId, recommendationId: bridge.id },
      select: { id: true },
    }) as { id: string } | null
    if (!existing) throw e
    return { ok: true, created: false, intentId: existing.id }
  }
}
