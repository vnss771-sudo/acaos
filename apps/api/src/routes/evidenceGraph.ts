import { Router } from 'express'
import { z } from 'zod'
import { requireAuth } from '../middleware/auth.js'
import { asyncHandler, ApiError, requireUser } from '../lib/http.js'
import { prisma } from '@acaos/backend-core/lib/prisma.js'
import { assessSignalQuality, toCanonicalSignal } from '@acaos/backend-core/lib/signalIntelligence.js'
import { userBelongsToWorkspace } from '../lib/workspaces.js'
import { parseQuery, parseParams, workspaceIdField, idField } from '../lib/validate.js'

// The evidence graph for one company: every claim ACAOS makes is traceable.
//
//   source ─REPORTED─▶ signal ─SUPPORTS─▶ commercial event ─CREATES─▶ opportunity ◀─FOR_OFFER─ offer
//
// Read-only and member-level. Signal quality is computed now (freshness moves
// with time); event confidence and the claim on each link are as last assessed.
export const evidenceGraphRouter = Router()
evidenceGraphRouter.use(requireAuth)

/** Most-recent signals included in one graph. */
const MAX_GRAPH_SIGNALS = 200

type GraphNode = { id: string; kind: 'company' | 'source' | 'signal' | 'event' | 'opportunity' | 'offer'; label: string; data: Record<string, unknown> }
type GraphEdge = { from: string; to: string; kind: 'OBSERVED' | 'REPORTED' | 'SUPPORTS' | 'CREATES' | 'FOR_OFFER'; data?: Record<string, unknown> }

type SignalRow = Parameters<typeof toCanonicalSignal>[0] & {
  id: string
  evidenceSourceId: string | null
  evidenceSource: { id: string; provider: string; sourceType: string; sourceUrl: string | null; observedAt: Date; confidence: number } | null
}
type EventRow = {
  id: string; kind: string; family: string; title: string; implication: string; whyNow: string; confidence: number
  independentSources: number; corroborated: boolean; status: string; firstDetectedAt: Date; lastConfirmedAt: Date
  evidenceLinks: Array<{ signalId: string; claim: string; sourceKey: string; sourceUrl: string | null; eventDate: Date; quality: number; grade: string; trustworthy: boolean }>
}
type OpportunityRow = {
  id: string; commercialEventId: string | null; offerId: string | null; offerKey: string; eventTitle: string; confidence: number
  offerFit: number; priority: number; status: string; recommendedAction: string; actionLabel: string
  offer: { id: string; name: string } | null
}

// GET /api/evidence-graph/:prospectId?workspaceId=&includeStale=true
evidenceGraphRouter.get(
  '/:prospectId',
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
    const { prospectId } = parseParams(z.object({ prospectId: idField }), req)
    const q = parseQuery(z.object({ workspaceId: workspaceIdField, includeStale: z.enum(['true', 'false']).optional() }), req)
    if (!(await userBelongsToWorkspace(user.id, q.workspaceId))) throw new ApiError(403, 'Access denied')

    const prospect = await prisma.prospect.findFirst({
      where: { id: prospectId, workspaceId: q.workspaceId },
      select: { id: true, companyName: true, domain: true, industry: true, location: true },
    })
    if (!prospect) throw new ApiError(404, 'Prospect not found')

    const [signalRows, eventRows, opportunityRows] = await Promise.all([
      prisma.signal.findMany({
        where: { workspaceId: q.workspaceId, prospectId },
        orderBy: { detectedAt: 'desc' },
        take: MAX_GRAPH_SIGNALS,
        include: { evidenceSource: { select: { id: true, provider: true, sourceType: true, sourceUrl: true, observedAt: true, confidence: true } } },
      }),
      prisma.commercialEvent.findMany({
        where: { workspaceId: q.workspaceId, prospectId, ...(q.includeStale === 'true' ? {} : { status: 'ACTIVE' }) },
        orderBy: { confidence: 'desc' },
        include: { evidenceLinks: { select: { signalId: true, claim: true, sourceKey: true, sourceUrl: true, eventDate: true, quality: true, grade: true, trustworthy: true } } },
      }),
      prisma.commercialOpportunity.findMany({
        where: { workspaceId: q.workspaceId, prospectId },
        orderBy: { priority: 'desc' },
        select: {
          id: true, commercialEventId: true, offerId: true, offerKey: true, eventTitle: true, confidence: true,
          offerFit: true, priority: true, status: true, recommendedAction: true, actionLabel: true,
          offer: { select: { id: true, name: true } },
        },
      }),
    ])
    const signals = signalRows as unknown as SignalRow[]
    const events = eventRows as unknown as EventRow[]
    const opportunities = opportunityRows as unknown as OpportunityRow[]

    const nodes: GraphNode[] = []
    const edges: GraphEdge[] = []
    const companyId = `company:${prospect.id}`
    nodes.push({ id: companyId, kind: 'company', label: prospect.companyName, data: { domain: prospect.domain, industry: prospect.industry, location: prospect.location } })

    const canonical = signals.map(s => toCanonicalSignal({ ...s, prospectId, prospect: { companyName: prospect.companyName } }))
    const now = Date.now()
    const seenSources = new Set<string>()
    signals.forEach((s, i) => {
      const c = canonical[i]
      const quality = assessSignalQuality(c, { all: canonical, now })
      const signalNode = `signal:${s.id}`
      nodes.push({
        id: signalNode, kind: 'signal', label: c.title ?? c.type,
        data: {
          type: c.type, source: c.source, sourceUrl: c.sourceUrl, observedAt: c.observedAt, publishedAt: c.publishedAt,
          quality: quality.overall, grade: quality.grade, trustworthy: quality.trustworthy,
          reliability: quality.reliability, freshness: quality.freshness, specificity: quality.specificity,
          corroboration: quality.corroboration, independentSources: quality.independentSources, reasons: quality.reasons,
        },
      })
      edges.push({ from: companyId, to: signalNode, kind: 'OBSERVED' })
      if (s.evidenceSource) {
        const sourceNode = `source:${s.evidenceSource.id}`
        if (!seenSources.has(sourceNode)) {
          seenSources.add(sourceNode)
          nodes.push({
            id: sourceNode, kind: 'source', label: s.evidenceSource.provider,
            data: { sourceType: s.evidenceSource.sourceType, sourceUrl: s.evidenceSource.sourceUrl, observedAt: s.evidenceSource.observedAt, confidence: s.evidenceSource.confidence },
          })
        }
        edges.push({ from: sourceNode, to: signalNode, kind: 'REPORTED' })
      }
    })

    const signalIds = new Set(signals.map(s => s.id))
    const narratives: Array<{ eventId: string; text: string }> = []
    for (const e of events) {
      const eventNode = `event:${e.id}`
      nodes.push({
        id: eventNode, kind: 'event', label: e.title,
        data: {
          kind: e.kind, family: e.family, implication: e.implication, whyNow: e.whyNow, confidence: e.confidence,
          independentSources: e.independentSources, corroborated: e.corroborated, status: e.status,
          firstDetectedAt: e.firstDetectedAt, lastConfirmedAt: e.lastConfirmedAt,
        },
      })
      const links = [...e.evidenceLinks].sort((a, b) => b.quality - a.quality)
      for (const l of links) {
        // A link to a signal outside the graph's signal window still names its claim.
        if (!signalIds.has(l.signalId)) continue
        edges.push({ from: `signal:${l.signalId}`, to: eventNode, kind: 'SUPPORTS', data: { claim: l.claim, quality: l.quality, grade: l.grade, trustworthy: l.trustworthy } })
      }
      if (e.status === 'ACTIVE') {
        narratives.push({
          eventId: e.id,
          text: [
            `${prospect.companyName}: ${e.title.toLowerCase()} (confidence ${e.confidence}%).`,
            e.implication,
            'Evidence:',
            ...links.slice(0, 5).map(l => `• ${l.claim} — ${l.sourceKey.replace(/^(host|provider):/, '')}, ${l.eventDate.toISOString().slice(0, 10)}`),
          ].join('\n'),
        })
      }
    }

    const eventIds = new Set(events.map(e => e.id))
    const seenOffers = new Set<string>()
    for (const o of opportunities) {
      const oppNode = `opportunity:${o.id}`
      nodes.push({
        id: oppNode, kind: 'opportunity', label: `${o.eventTitle} — ${o.offer?.name ?? o.offerKey}`,
        data: { confidence: o.confidence, offerFit: o.offerFit, priority: o.priority, status: o.status, recommendedAction: o.recommendedAction, actionLabel: o.actionLabel },
      })
      if (o.commercialEventId && eventIds.has(o.commercialEventId)) edges.push({ from: `event:${o.commercialEventId}`, to: oppNode, kind: 'CREATES' })
      if (o.offer) {
        const offerNode = `offer:${o.offer.id}`
        if (!seenOffers.has(offerNode)) {
          seenOffers.add(offerNode)
          nodes.push({ id: offerNode, kind: 'offer', label: o.offer.name, data: {} })
        }
        edges.push({ from: offerNode, to: oppNode, kind: 'FOR_OFFER' })
      }
    }

    res.json({ prospect, nodes, edges, narratives, truncated: signals.length >= MAX_GRAPH_SIGNALS })
  })
)
