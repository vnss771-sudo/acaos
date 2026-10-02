// Persistence for the evidence graph and the Opportunity Engine. Per prospect:
//
// 1. Detect commercial events (commercialEventEngine.ts) and keep CommercialEvent
//    rows in step — ACTIVE while supported, STALE once not — each with its
//    EvidenceLink edges to the signals behind it. This runs with or without offers.
// 2. Assess the prospect against each offer that applies to it and keep
//    CommercialOpportunity rows in step, linked to the event they were built on.
//
// - An assessment upserts the (workspace, prospect, offerKey) row.
// - When the evidence no longer supports an OPEN opportunity (or its offer is
//   gone/inactive), the row becomes EXPIRED; fresh evidence re-opens it.
// - Operator statuses (PURSUING, WON, LOST, DISMISSED) are never overwritten:
//   the assessment fields refresh, the status stays the operator's.
// - Each assessment carries its recommendation (recommendationEngine.ts). An
//   outreach move on an OPEN or PURSUING row is mirrored into one Recommendation
//   row (the entry to the intent → approval → send bridge), refreshed in place
//   until someone acts on it; otherwise that row is retired (expiresAt = now).
//   Nothing is sent from here.
// Callers rescore first; this reads the persisted signals.
import { Prisma } from '@prisma/client'
import { prisma } from './prisma.js'
import { MAX_SIGNALS_FOR_SCORING } from './signalEngine.js'
import { toCanonicalSignal } from './signalIntelligence.js'
import { offerFromMission, offerFromRow, type OfferDefinition, type OfferRow } from './offerModel.js'
import { assessOpportunity, type OpportunityAssessment } from './opportunityEngine.js'
import { detectCommercialEvents, type CommercialEventHypothesis } from './commercialEventEngine.js'
import type { EngagementStage } from './buyingStage.js'
import type { OpportunityRecommendation } from './recommendationEngine.js'

export const COMMERCIAL_OPPORTUNITY_STATUSES = ['OPEN', 'PURSUING', 'WON', 'LOST', 'DISMISSED', 'EXPIRED'] as const
export type CommercialOpportunityStatus = (typeof COMMERCIAL_OPPORTUNITY_STATUSES)[number]
/** Statuses an operator sets; the engine never overwrites these. */
export const OPERATOR_STATUSES: readonly CommercialOpportunityStatus[] = ['PURSUING', 'WON', 'LOST', 'DISMISSED']

/** Kill switch for the worker hook. Default ON: the engine is local and never sends. */
export function isCommercialOpportunityEngineEnabled(): boolean {
  return process.env.COMMERCIAL_OPPORTUNITIES_ENABLED !== 'false'
}

/** Only prospects with a signal this recent (or an OPEN opportunity / ACTIVE event to retire) are reassessed. */
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
  outcomeStage: EngagementStage | null
  signals: Array<Parameters<typeof toCanonicalSignal>[0]>
}

type ExistingRow = { id: string; offerKey: string; status: string }

function assessmentData(a: OpportunityAssessment, commercialEventId: string | null) {
  return {
    offerId: a.offerId,
    missionId: a.missionId,
    eventType: a.eventType,
    eventFamily: a.eventFamily,
    eventTitle: a.eventTitle,
    implication: a.implication,
    whyNow: a.whyNow,
    commercialEventId,
    confidence: a.confidence,
    evidenceConfidence: a.evidenceConfidence,
    independentSources: a.independentSources,
    trustworthySignals: a.trustworthySignals,
    offerFit: a.offerFit,
    intentScore: a.intentScore,
    timingScore: a.timingScore,
    contactability: a.contactability,
    competition: a.competition,
    valueScore: a.valueScore,
    expectedValueCents: a.expectedValueCents,
    scorecard: a.scorecard,
    estimatedValueMinCents: a.estimatedValueMinCents,
    estimatedValueMaxCents: a.estimatedValueMaxCents,
    probability: a.probability,
    urgency: a.urgency,
    priority: a.priority,
    buyingStage: a.buyingStage,
    buyingStageDetail: a.buyingStageDetail,
    recommendedBuyer: a.recommendedBuyer,
    recommendedAction: a.recommendedAction,
    actionLabel: a.actionLabel,
    actionReason: a.actionReason,
    blockers: a.blockers,
    reasons: a.reasons,
    evidence: a.evidence,
    velocity: a.velocity,
    intelligenceGate: a.gates.intelligenceTruth,
    recommendationKind: a.recommendation?.kind ?? null,
    recommendation: a.recommendation ?? Prisma.JsonNull,
  }
}

/** Statuses whose outreach recommendation stays live in the bridge. */
const BRIDGE_STATUSES = new Set(['OPEN', 'PURSUING'])
/** How long a bridged recommendation stays live without a rescore. */
const BRIDGE_TTL_DAYS = 7

/** Whether an opportunity in this status keeps its bridged recommendation live. */
export function bridgesRecommendation(status: string): boolean {
  return BRIDGE_STATUSES.has(status)
}

/** Retire the un-acted bridge row for an opportunity, if it's still live. */
export async function retireBridge(workspaceId: string, commercialOpportunityId: string, now: Date): Promise<void> {
  await prisma.recommendation.updateMany({
    where: { workspaceId, commercialOpportunityId, actedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    data: { expiresAt: now },
  })
}

/**
 * Keep the opportunity's Recommendation row in step with its recommendation.
 * Only an outreach move on an OPEN/PURSUING opportunity is bridged; a row
 * someone has acted on is never rewritten.
 */
async function syncBridge(
  prospect: ProspectWithSignals,
  opp: { id: string; status: string },
  rec: OpportunityRecommendation | null,
  recommendedBuyer: string | null,
  now: Date,
): Promise<void> {
  if (!rec || !rec.outreach || !bridgesRecommendation(opp.status)) {
    await retireBridge(prospect.workspaceId, opp.id, now)
    return
  }
  const data = {
    bestContact: recommendedBuyer,
    bestTiming: rec.urgency === 'HIGH' ? 'Now' : 'This week',
    bestChannel: 'email',
    messageAngle: rec.headline,
    reasoning: rec.why.join(' · '),
    actionText: rec.label,
    urgency: rec.urgency,
    priority: rec.priority,
    expiresAt: new Date(now.getTime() + BRIDGE_TTL_DAYS * 86_400_000),
  }
  const existing = await prisma.recommendation.findFirst({
    where: { workspaceId: prospect.workspaceId, commercialOpportunityId: opp.id },
    select: { id: true, actedAt: true },
  }) as { id: string; actedAt: Date | null } | null
  if (!existing) {
    await prisma.recommendation.create({
      data: { workspaceId: prospect.workspaceId, prospectId: prospect.id, commercialOpportunityId: opp.id, ...data },
    })
  } else if (!existing.actedAt) {
    await prisma.recommendation.update({ where: { id: existing.id }, data })
  }
}

export type RefreshResult = { assessed: number; upserted: number; expired: number; events: number; staleEvents: number }

type ExistingEvent = { id: string; kind: string; status: string }

/**
 * Upsert one row per detected event kind and replace its evidence links; any
 * ACTIVE event no longer detected becomes STALE (kept, links and all, as
 * history). Returns the event id per kind for the opportunities to link to.
 */
async function syncEvents(
  prospect: ProspectWithSignals,
  detected: CommercialEventHypothesis[],
  existing: ExistingEvent[],
  now: Date,
): Promise<{ idByKind: Map<string, string>; stale: number }> {
  const idByKind = new Map<string, string>()
  for (const e of detected) {
    const data = {
      family: e.family, title: e.title, implication: e.implication, whyNow: e.whyNow,
      confidence: e.confidence, independentSources: e.independentSources,
      trustworthySignals: e.trustworthySignals, corroborated: e.corroborated,
    }
    const links = e.evidence
      .filter((c): c is typeof c & { signalId: string } => c.signalId != null)
      .map(c => ({
        workspaceId: prospect.workspaceId, signalId: c.signalId, claim: c.claim, sourceKey: c.sourceKey,
        sourceUrl: c.sourceUrl, eventDate: new Date(c.eventDate), quality: c.quality, grade: c.grade, trustworthy: c.trustworthy,
      }))
    const row = await prisma.$transaction(async (tx) => {
      const ev = await tx.commercialEvent.upsert({
        where: { workspaceId_prospectId_kind: { workspaceId: prospect.workspaceId, prospectId: prospect.id, kind: e.kind } },
        create: { workspaceId: prospect.workspaceId, prospectId: prospect.id, kind: e.kind, ...data, status: 'ACTIVE', firstDetectedAt: now, lastConfirmedAt: now, lastAssessedAt: now },
        update: { ...data, status: 'ACTIVE', lastConfirmedAt: now, lastAssessedAt: now },
        select: { id: true },
      })
      // The links are a snapshot of the current evidence: replace, don't accumulate.
      await tx.evidenceLink.deleteMany({ where: { workspaceId: prospect.workspaceId, commercialEventId: ev.id } })
      if (links.length) await tx.evidenceLink.createMany({ data: links.map(l => ({ ...l, commercialEventId: ev.id })) })
      return ev
    })
    idByKind.set(e.kind, row.id)
  }
  const detectedKinds = new Set(detected.map(e => e.kind))
  const goneStale = existing.filter(r => r.status === 'ACTIVE' && !detectedKinds.has(r.kind as CommercialEventHypothesis['kind']))
  if (goneStale.length) {
    await prisma.commercialEvent.updateMany({
      where: { workspaceId: prospect.workspaceId, id: { in: goneStale.map(r => r.id) } },
      data: { status: 'STALE', lastAssessedAt: now },
    })
  }
  return { idByKind, stale: goneStale.length }
}

async function refreshOne(
  prospect: ProspectWithSignals,
  catalog: OfferCatalog,
  existing: ExistingRow[],
  existingEvents: ExistingEvent[],
  now: Date,
  eventKindWeights: Record<string, number> | null,
): Promise<RefreshResult> {
  const offers = offersForProspect(catalog, prospect.missionId)
  const signals = prospect.signals.map(s => toCanonicalSignal({ ...s, prospectId: prospect.id, prospect: { companyName: prospect.companyName } }))
  const detected = detectCommercialEvents(signals, { now: now.getTime() })
  const { idByKind, stale } = await syncEvents(prospect, detected, existingEvents, now)
  const byKey = new Map(existing.map(r => [r.offerKey, r]))
  const seen = new Set<string>()
  let upserted = 0
  let expired = 0

  for (const offer of offers) {
    seen.add(offer.key)
    const a = assessOpportunity({ prospect, signals, offer, events: detected, now: now.getTime(), eventKindWeights })
    const row = byKey.get(offer.key)
    if (a) {
      const data = assessmentData(a, idByKind.get(a.eventType) ?? null)
      const saved = await prisma.commercialOpportunity.upsert({
        where: { workspaceId_prospectId_offerKey: { workspaceId: prospect.workspaceId, prospectId: prospect.id, offerKey: offer.key } },
        create: { workspaceId: prospect.workspaceId, prospectId: prospect.id, offerKey: offer.key, ...data, firstDetectedAt: now, lastAssessedAt: now },
        // Re-open an EXPIRED row on fresh evidence; never touch an operator status.
        update: { ...data, lastAssessedAt: now, ...(row?.status === 'EXPIRED' ? { status: 'OPEN', statusChangedAt: now, statusChangedByUserId: null } : {}) },
        select: { id: true, status: true },
      }) as { id: string; status: string }
      await syncBridge(prospect, saved, a.recommendation, a.recommendedBuyer, now)
      upserted++
    } else if (row?.status === 'OPEN') {
      await prisma.commercialOpportunity.update({ where: { id: row.id }, data: { status: 'EXPIRED', statusChangedAt: now, statusChangedByUserId: null, lastAssessedAt: now } })
      await retireBridge(prospect.workspaceId, row.id, now)
      expired++
    }
  }

  // The offer this row was assessed against no longer applies (deleted, inactive,
  // or the prospect moved mission): an OPEN row can't stay open on its own.
  for (const row of existing) {
    if (!seen.has(row.offerKey) && row.status === 'OPEN') {
      await prisma.commercialOpportunity.update({ where: { id: row.id }, data: { status: 'EXPIRED', statusChangedAt: now, statusChangedByUserId: null, lastAssessedAt: now } })
      await retireBridge(prospect.workspaceId, row.id, now)
      expired++
    }
  }
  return { assessed: offers.length, upserted, expired, events: detected.length, staleEvents: stale }
}

const PROSPECT_SELECT = {
  id: true, workspaceId: true, companyName: true, missionId: true, industry: true, employeeCount: true,
  location: true, description: true, domain: true, contactName: true, contactEmail: true, contactTitle: true, outcomeStage: true,
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
  const total = { assessed: 0, upserted: 0, expired: 0, events: 0, staleEvents: 0, prospects: 0 }
  if (prospectIds.length === 0) return total
  const now = opts.now ?? new Date()
  const catalog = opts.catalog ?? await loadOfferCatalog(workspaceId)
  // Approved calibration weights (phase 12); none until a human approves some.
  const model = await prisma.scoringModel.findUnique({ where: { workspaceId }, select: { eventKindWeights: true } }) as { eventKindWeights: unknown } | null
  const eventKindWeights = (model?.eventKindWeights ?? null) as Record<string, number> | null
  const cutoff = new Date(now.getTime() - REASSESS_SIGNAL_DAYS * 86_400_000)

  const prospects = await prisma.prospect.findMany({
    where: {
      workspaceId,
      id: { in: prospectIds },
      isExample: false,
      OR: [
        { signals: { some: { detectedAt: { gte: cutoff } } } },
        { commercialOpportunities: { some: { status: 'OPEN' } } },
        { commercialEvents: { some: { status: 'ACTIVE' } } },
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
  const existingEvents = await prisma.commercialEvent.findMany({
    where: { workspaceId, prospectId: { in: prospects.map(p => p.id) } },
    select: { id: true, prospectId: true, kind: true, status: true },
  }) as Array<ExistingEvent & { prospectId: string }>
  const eventsByProspect = new Map<string, ExistingEvent[]>()
  for (const r of existingEvents) eventsByProspect.set(r.prospectId, [...(eventsByProspect.get(r.prospectId) ?? []), r])

  for (const p of prospects) {
    const r = await refreshOne(p, catalog, byProspect.get(p.id) ?? [], eventsByProspect.get(p.id) ?? [], now, eventKindWeights)
    total.assessed += r.assessed
    total.upserted += r.upserted
    total.expired += r.expired
    total.events += r.events
    total.staleEvents += r.staleEvents
    total.prospects++
  }
  return total
}
