import { prisma } from '@acaos/backend-core/lib/prisma.js'
import { generateRuleBasedRecommendation, toRawSignal } from '@acaos/backend-core/lib/signalEngine.js'
import { evidenceGatedPriority } from '@acaos/backend-core/lib/recommendationPolicy.js'
import { createOutreachIntentForRecommendation, type OutreachIntentOrigin } from '@acaos/backend-core/lib/outreachIntent.js'

type ProspectWithSignals = NonNullable<Awaited<ReturnType<typeof loadProspectWithSignals>>>

export function loadProspectWithSignals(prospectId: string) {
  return prisma.prospect.findUnique({ where: { id: prospectId }, include: { signals: true } })
}

// Rule-based recommendation for one prospect, bridged into the outreach spine as
// an OutreachIntent. Shared by POST /:id/recommend (origin RECOMMENDATION) and the
// onboarding import (origin ONBOARDING). Intent creation is best-effort for the
// RECOMMENDATION path (additive bridge) but required for ONBOARDING, whose whole
// point is the intent.
export async function recommendProspect(prospect: ProspectWithSignals, origin: OutreachIntentOrigin = 'RECOMMENDATION') {
  const rec = generateRuleBasedRecommendation(
    {
      industry:      prospect.industry,
      employeeCount: prospect.employeeCount,
      contactEmail:  prospect.contactEmail,
      contactName:   prospect.contactName,
      contactPhone:  prospect.contactPhone,
      linkedinUrl:   prospect.linkedinUrl,
      domain:        prospect.domain,
      location:      prospect.location,
    },
    prospect.signals.map(toRawSignal)
  )

  // Evidence-first gate: high-confidence priority requires provable, fresh
  // evidence on a signal — otherwise it's capped below the high-confidence line.
  const priority = evidenceGatedPriority(rec.priority, prospect.signals)

  const recommendation = await prisma.recommendation.create({
    data: {
      workspaceId: prospect.workspaceId,
      prospectId:  prospect.id,
      ...rec,
      priority,
      expiresAt: new Date(Date.now() + 7 * 86_400_000),
    },
  })

  const createIntent = createOutreachIntentForRecommendation({
    workspaceId: prospect.workspaceId,
    prospectId:  prospect.id,
    recommendationId: recommendation.id,
    messageAngle: rec.messageAngle,
    channel: rec.bestChannel,
    signals: prospect.signals,
    missionId: prospect.missionId,
    origin,
  })
  const intent = origin === 'ONBOARDING' ? await createIntent : await createIntent.catch(() => null)

  return { recommendation, intent }
}
