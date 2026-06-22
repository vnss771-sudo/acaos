import type { Router } from 'express'
import { asyncHandler, ApiError } from '../../lib/http.js'
import { prisma } from '../../lib/prisma.js'
import {
  calculateOpportunityScores,
  detectBuyingStage,
  calcWinProbability,
  getOpportunityTier,
  toRawSignal,
  MAX_SIGNALS_FOR_SCORING,
  type SignalType,
} from '../../lib/signalEngine.js'
import { assertMinimumWorkspaceRole } from '../../lib/workspaces.js'
import { enrichProspect } from '../../services/apollo.js'
import { ingestSignal } from '../../lib/signalIngest.js'
import { findContactEmail, isHunterConfigured } from '../../services/hunter.js'
import { withDollars, getICP } from './helpers.js'

export function registerEnrichmentRoutes(prospectsRouter: Router) {
  // POST /api/prospects/:id/enrich — Apollo.io enrichment → auto signals → rescore
  prospectsRouter.post('/:id/enrich', asyncHandler(async (req, res) => {
    const prospect = await prisma.prospect.findUnique({ where: { id: req.params.id as string } })
    if (!prospect) throw new ApiError(404, 'Prospect not found')

    const userId = req.user!.id
    await assertMinimumWorkspaceRole(userId, prospect.workspaceId, 'admin')

    if (prospect.isExample) throw new ApiError(400, 'Example prospects cannot be enriched — add real prospects first')

    const result = await enrichProspect(prospect)

    const created: string[] = []
    for (const sig of result.signals) {
      // Apollo-detected signals now carry provenance (EvidenceSource) so they get
      // the same "where from / how fresh" treatment as manually-added ones.
      const s = await ingestSignal({
        workspaceId:       prospect.workspaceId,
        prospectId:        prospect.id,
        type:              sig.type as SignalType,
        strength:          sig.strength,
        sourceReliability: sig.sourceReliability,
        industryRelevance: sig.industryRelevance,
        title:             sig.title,
        description:       sig.description,
        source:            sig.source,
        detectedAt:        sig.detectedAt,
        evidence: {
          provider: sig.source,
          sourceType: 'enrichment',
          confidence: Math.max(0, Math.min(1, sig.sourceReliability / 100)),
          observedAt: sig.detectedAt,
        },
      })
      created.push(s.id)
    }

    const [allSignals, icp] = await Promise.all([
      prisma.signal.findMany({ where: { prospectId: prospect.id }, orderBy: { detectedAt: 'desc' }, take: MAX_SIGNALS_FOR_SCORING }),
      getICP(prospect.workspaceId)
    ])
    const rawSignals = allSignals.map(toRawSignal)
    const u          = result.updates
    const scores     = calculateOpportunityScores(rawSignals, {
      industry:      (u.industry      as string | null | undefined) ?? prospect.industry,
      employeeCount: (u.employeeCount as number | null | undefined) ?? prospect.employeeCount,
      contactEmail:  (u.contactEmail  as string | null | undefined) ?? prospect.contactEmail,
      contactName:   (u.contactName   as string | null | undefined) ?? prospect.contactName,
      domain:        (u.domain        as string | null | undefined) ?? prospect.domain,
      location:      prospect.location,
    }, icp)
    const buyingStage    = detectBuyingStage(rawSignals, scores.opportunityScore)
    const winProbability = calcWinProbability(buyingStage, scores.opportunityScore)

    // Most recent signal detectedAt — use as lastSignalAt
    const latestSignalAt = (allSignals as Array<{ detectedAt: Date }>).reduce((max: Date | null, s: { detectedAt: Date }) => {
      return !max || s.detectedAt > max ? s.detectedAt : max
    }, null)

    // Hunter email finder — if prospect has domain but no contact email, try Hunter
    if (prospect.domain && !prospect.contactEmail && !result.updates.contactEmail && isHunterConfigured()) {
      try {
        const contact = await findContactEmail(prospect.domain)
        if (contact) {
          result.updates.contactEmail = contact.email
          if (contact.firstName && !prospect.contactName) {
            result.updates.contactName = [contact.firstName, contact.lastName].filter(Boolean).join(' ')
          }
          if (contact.position && !prospect.contactTitle) {
            result.updates.contactTitle = contact.position
          }
        }
      } catch { /* non-fatal */ }
    }

    const updated = await prisma.prospect.update({
      where: { id: prospect.id },
      data: {
        ...scores,
        buyingStage,
        winProbability,
        ...(latestSignalAt && { lastSignalAt: latestSignalAt }),
        ...(Object.keys(u).length > 0 && u),
      }
    })

    res.json({
      prospect:       withDollars({ ...updated, tier: getOpportunityTier(updated.opportunityScore) }),
      signalsCreated: created.length,
      signalIds:      created
    })
  }))
}
