// Persistence for the Opportunity Engine: assess each prospect against each
// offer that applies to it and keep CommercialOpportunity rows in step.
//
// - An assessment upserts the (workspace, prospect, offerKey) row.
// - When the evidence no longer supports an OPEN opportunity (or its offer is
//   gone/inactive), the row becomes EXPIRED; fresh evidence re-opens it.
// - Operator statuses (PURSUING, WON, LOST, DISMISSED) are never overwritten:
//   the assessment fields refresh, the status stays the operator's.
// Callers rescore first; this reads the persisted signals.
import { prisma } from './prisma.js'
import { MAX_SIGNALS_FOR_SCORING } from './signalEngine.js'
import { toCanonicalSignal } from './signalIntelligence.js'
import { offerFromMission, offerFromRow, type OfferDefinition, type OfferRow } from './offerModel.js'
import { assessOpportunity, type OpportunityAssessment } from './opportunityEngine.js'

export const COMMERCIAL_OPPORTUNITY_STATUSES = ['OPEN', 'PURSUING', 'WON', 'LOST', 'DISMISSED', 'EXPIRED'] as const
export type CommercialOpportunityStatus = (typeof COMMERCIAL_OPPORTUNITY_STATUSES)[number]
/** Statuses an operator sets; the engine never overwrites these. */
export const OPERATOR_STATUSES: readonly CommercialOpportunityStatus[] = ['PURSUING', 'WON', 'LOST', 'DISMISSED']

/** Kill switch for the worker hook. Default ON: the engine is local and never sends. */
export function isCommercialOpportunityEngineEnabled(): boolean {
  return process.env.COMMERCIAL_OPPORTUNITIES_ENABLED !== 'false'
}

/** Only prospects with a signal this recent (or an OPEN opportunity to expire) are reassessed. */
const REASSESS_SIGNAL_DAYS = 30

export type OfferCatalog = {
  /** Active structured offers with no mission: apply to every prospect. */
  workspaceWide: OfferDefinition[]
  /** Active structured offers by mission id. */
  byMission: Map<string, OfferDefinition[]>
  /** A mission's free-text offer, used when the mission has no structured offer. */
  missionText: Map<string, OfferDefinition>
  /** The workspace's business context as a last-resort free-text offer. */
  workspaceText: OfferDefinition | null
}

export async function loadOfferCatalog(workspaceId: string): Promise<OfferCatalog> {
  const [offers, missions, icp] = await Promise.all([
    prisma.offer.findMany({ where: { workspaceId, active: true }, orderBy: { createdAt: 'asc' } }),
    prisma.mission.findMany({
      where: { workspaceId, offer: { not: null } },
      select: { id: true, name: true, offer: true, targetCustomer: true },
    }),
    prisma.workspaceICP.findUnique({ where: { workspaceId }, select: { businessContext: true } }),
  ])
  const workspaceWide: OfferDefinition[] = []
  const byMission = new Map<string, OfferDefinition[]>()
  for (const row of offers as OfferRow[]) {
    const def = offerFromRow(row)
    if (row.missionId) byMission.set(row.missionId, [...(byMission.get(row.missionId) ?? []), def])
    else workspaceWide.push(def)
  }
  const missionText = new Map<string, OfferDefinition>()
  for (const m of missions as Array<{ id: string; name: string; offer: string | null; targetCustomer: string | null }>) {
    if (m.offer?.trim()) missionText.set(m.id, offerFromMission(m))
  }
  const ctx = (icp as { businessContext: string | null } | null)?.businessContext?.trim()
  const workspaceText: OfferDefinition | null = ctx
    ? { ...offerFromMission({ id: 'workspace', name: 'Workspace offer', offer: ctx, targetCustomer: null }), key: 'workspace:default', missionId: null }
    : null
  return { workspaceWide, byMission, missionText, workspaceText }
}

/**
 * The offers a prospect is assessed against: its mission's structured offers
 * (else the mission's free-text offer) plus every workspace-wide offer. With
 * none of those, the workspace business context stands in. Nothing at all → [].
 */
export function offersForProspect(catalog: OfferCatalog, missionId: string | null): OfferDefinition[] {
  const out: OfferDefinition[] = []
  if (missionId) {
    const structured = catalog.byMission.get(missionId) ?? []
    if (structured.length) out.push(...structured)
    else {
      const text = catalog.missionText.get(missionId)
      if (text) out.push(text)
    }
  }
  out.push(...catalog.workspaceWide)
  if (out.length === 0 && catalog.workspaceText) out.push(catalog.workspaceText)
  return out
}

type ProspectWithSignals = {
  id: string
  workspaceId: string
  companyName: string
  missionId: string | null
  industry: string | null
  employeeCount: number | null
  location: string | null
  description: string | null
  domain: string | null
  contactName: string | null
  contactEmail: string | null
  contactTitle: string | null
  signals: Array<Parameters<typeof toCanonicalSignal>[0]>
}

type ExistingRow = { id: string; offerKey: string; status: string }

function assessmentData(a: OpportunityAssessment) {
  return {
    offerId: a.offerId,
    missionId: a.missionId,
    eventType: a.eventType,
    eventTitle: a.eventTitle,
    whyNow: a.whyNow,
    confidence: a.confidence,
    evidenceConfidence: a.evidenceConfidence,
    independentSources: a.independentSources,
    trustworthySignals: a.trustworthySignals,
    offerFit: a.offerFit,
    intentScore: a.intentScore,
    timingScore: a.timingScore,
    contactability: a.contactability,
    estimatedValueMinCents: a.estimatedValueMinCents,
    estimatedValueMaxCents: a.estimatedValueMaxCents,
    probability: a.probability,
    urgency: a.urgency,
    priority: a.priority,
    buyingStage: a.buyingStage,
    recommendedBuyer: a.recommendedBuyer,
    recommendedAction: a.recommendedAction,
    actionLabel: a.actionLabel,
    actionReason: a.actionReason,
    blockers: a.blockers,
    reasons: a.reasons,
    evidence: a.evidence,
    velocity: a.velocity,
    intelligenceGate: a.gates.intelligenceTruth,
  }
}

export type RefreshResult = { assessed: number; upserted: number; expired: number }

async function refreshOne(
  prospect: ProspectWithSignals,
  catalog: OfferCatalog,
  existing: ExistingRow[],
  now: Date,
): Promise<RefreshResult> {
  const offers = offersForProspect(catalog, prospect.missionId)
  const signals = prospect.signals.map(s => toCanonicalSignal({ ...s, prospectId: prospect.id, prospect: { companyName: prospect.companyName } }))
  const byKey = new Map(existing.map(r => [r.offerKey, r]))
  const seen = new Set<string>()
  let upserted = 0
  let expired = 0

  for (const offer of offers) {
    seen.add(offer.key)
    const a = assessOpportunity({ prospect, signals, offer, now: now.getTime() })
    const row = byKey.get(offer.key)
    if (a) {
      const data = assessmentData(a)
      await prisma.commercialOpportunity.upsert({
        where: { workspaceId_prospectId_offerKey: { workspaceId: prospect.workspaceId, prospectId: prospect.id, offerKey: offer.key } },
        create: { workspaceId: prospect.workspaceId, prospectId: prospect.id, offerKey: offer.key, ...data, firstDetectedAt: now, lastAssessedAt: now },
        // Re-open an EXPIRED row on fresh evidence; never touch an operator status.
        update: { ...data, lastAssessedAt: now, ...(row?.status === 'EXPIRED' ? { status: 'OPEN', statusChangedAt: now, statusChangedByUserId: null } : {}) },
      })
      upserted++
    } else if (row?.status === 'OPEN') {
      await prisma.commercialOpportunity.update({ where: { id: row.id }, data: { status: 'EXPIRED', statusChangedAt: now, statusChangedByUserId: null, lastAssessedAt: now } })
      expired++
    }
  }

  // The offer this row was assessed against no longer applies (deleted, inactive,
  // or the prospect moved mission): an OPEN row can't stay open on its own.
  for (const row of existing) {
    if (!seen.has(row.offerKey) && row.status === 'OPEN') {
      await prisma.commercialOpportunity.update({ where: { id: row.id }, data: { status: 'EXPIRED', statusChangedAt: now, statusChangedByUserId: null, lastAssessedAt: now } })
      expired++
    }
  }
  return { assessed: offers.length, upserted, expired }
}

const PROSPECT_SELECT = {
  id: true, workspaceId: true, companyName: true, missionId: true, industry: true, employeeCount: true,
  location: true, description: true, domain: true, contactName: true, contactEmail: true, contactTitle: true,
  signals: {
    orderBy: { detectedAt: 'desc' as const },
    take: MAX_SIGNALS_FOR_SCORING,
    include: { evidenceSource: { select: { provider: true, sourceType: true, sourceUrl: true, observedAt: true, confidence: true } } },
  },
}

/**
 * Reassess the given prospects (all tenant-scoped to workspaceId). Prospects
 * with no recent signal and no OPEN opportunity are skipped — there's nothing
 * to create and nothing to expire. The offer catalog is loaded once.
 */
export async function refreshCommercialOpportunities(
  workspaceId: string,
  prospectIds: string[],
  opts: { now?: Date; catalog?: OfferCatalog } = {},
): Promise<RefreshResult & { prospects: number }> {
  const total = { assessed: 0, upserted: 0, expired: 0, prospects: 0 }
  if (prospectIds.length === 0) return total
  const now = opts.now ?? new Date()
  const catalog = opts.catalog ?? await loadOfferCatalog(workspaceId)
  const cutoff = new Date(now.getTime() - REASSESS_SIGNAL_DAYS * 86_400_000)

  const prospects = await prisma.prospect.findMany({
    where: {
      workspaceId,
      id: { in: prospectIds },
      isExample: false,
      OR: [
        { signals: { some: { detectedAt: { gte: cutoff } } } },
        { commercialOpportunities: { some: { status: 'OPEN' } } },
      ],
    },
    select: PROSPECT_SELECT,
  }) as unknown as ProspectWithSignals[]
  if (prospects.length === 0) return total

  const existing = await prisma.commercialOpportunity.findMany({
    where: { workspaceId, prospectId: { in: prospects.map(p => p.id) } },
    select: { id: true, prospectId: true, offerKey: true, status: true },
  }) as Array<ExistingRow & { prospectId: string }>
  const byProspect = new Map<string, ExistingRow[]>()
  for (const r of existing) byProspect.set(r.prospectId, [...(byProspect.get(r.prospectId) ?? []), r])

  for (const p of prospects) {
    const r = await refreshOne(p, catalog, byProspect.get(p.id) ?? [], now)
    total.assessed += r.assessed
    total.upserted += r.upserted
    total.expired += r.expired
    total.prospects++
  }
  return total
}
