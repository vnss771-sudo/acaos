// Work-discovery sweep: for every workspace with an enabled DiscoveryProfile,
// read each of its sources from the stored cursor, keep what matches the
// profile, and upsert it as an Opportunity. Scheduled by the worker
// (discover-opportunities) and runnable on demand for one workspace.
//
// Durability rules (same lesson as the mailbox cursor):
//  - The cursor advances only after every fetched item has been persisted. Any
//    failure leaves it where it was; the next run re-reads the range and the
//    (workspaceId, source, externalId) unique key makes that harmless.
//  - One source failing never stops the others, or other workspaces.
//  - Re-delivery never touches a user's status (PURSUING / WON / ...). A real
//    content change (contentHash) bumps lastChangedAt so the UI can flag it.
import type { Prisma } from '@prisma/client'
import { prisma } from './prisma.js'
import { runInWorkspaceContext } from './tenantContext.js'
import { matchOpportunity, isRejection, candidateContentHash } from './opportunityMatch.js'
import { OPPORTUNITY_SOURCES, type OpportunitySource, type SourceFetchContext, type SourceFetchResult } from './opportunitySources.js'
import type { DiscoveryProfileInput, OpportunityCandidate } from './opportunityTypes.js'

/** Opt-in (default OFF): the sweep calls third-party APIs on a schedule. */
export function isOpportunityDiscoveryEnabled(): boolean {
  return process.env.OPPORTUNITY_DISCOVERY_ENABLED === 'true'
}

/** Sweep interval; default 6 hours, never below 15 minutes. */
export function opportunityDiscoveryIntervalMs(): number {
  const n = Number(process.env.OPPORTUNITY_DISCOVERY_INTERVAL_MS)
  return Number.isFinite(n) && n >= 15 * 60_000 ? n : 6 * 60 * 60 * 1000
}

export type SourceRunStatus = 'ok' | 'skipped' | 'failed'

export type SourceRunResult = {
  workspaceId: string
  source: string
  status: SourceRunStatus
  fetched: number
  matched: number
  created: number
  updated: number
  reason?: string
  warning?: string
}

export type SweepResult = { workspaces: number; runs: SourceRunResult[] }

type ProfileRow = DiscoveryProfileInput & { workspaceId: string; sources: string[] }

type SweepDeps = {
  sources?: readonly OpportunitySource[]
  now?: Date
  fetchImpl?: SourceFetchContext['fetchImpl']
}

function profileInput(p: ProfileRow): DiscoveryProfileInput {
  return {
    trades: p.trades, keywords: p.keywords, baseLat: p.baseLat, baseLng: p.baseLng,
    radiusKm: p.radiusKm, regions: p.regions, minValue: p.minValue,
  }
}

function errorMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500)
}

type Persisted = { created: number; updated: number; matched: number }

async function persistCandidates(workspaceId: string, source: string, items: OpportunityCandidate[], profile: DiscoveryProfileInput, now: Date): Promise<Persisted> {
  const out: Persisted = { created: 0, updated: 0, matched: 0 }
  for (const c of items) {
    const m = matchOpportunity(c, profile, now)
    if (isRejection(m)) continue
    out.matched++
    const contentHash = candidateContentHash(c)
    const fields = {
      kind: c.kind,
      title: c.title,
      description: c.description ?? null,
      address: c.address ?? null,
      locality: c.locality ?? null,
      region: c.region ?? null,
      postcode: c.postcode ?? null,
      lat: c.lat ?? null,
      lng: c.lng ?? null,
      distanceKm: m.distanceKm,
      valueAmount: c.valueAmount ?? null,
      currency: c.currency ?? null,
      publishedAt: c.publishedAt ?? null,
      sourceUrl: c.sourceUrl ?? null,
      counterpartyName: c.counterparty?.name ?? null,
      counterpartyAbn: c.counterparty?.abn ?? null,
      counterpartyEmail: c.counterparty?.email ?? null,
      counterpartyPhone: c.counterparty?.phone ?? null,
      buyerName: c.buyer?.name ?? null,
      score: m.score,
      matchedTrades: m.matchedTrades,
      reasons: m.reasons as Prisma.InputJsonValue,
      recommendedAction: m.recommendedAction,
      rawData: { raw: c.raw ?? null, classifications: c.classifications ?? [], authority: c.authority ?? null } as Prisma.InputJsonValue,
      contentHash,
    }
    const key = { workspaceId_source_externalId: { workspaceId, source, externalId: c.externalId } }
    const existing = await prisma.opportunity.findUnique({ where: key, select: { id: true, contentHash: true } })
    if (!existing) {
      try {
        await prisma.opportunity.create({ data: { workspaceId, source, externalId: c.externalId, ...fields, firstSeenAt: now, lastSeenAt: now, lastChangedAt: now } })
        out.created++
        continue
      } catch (err) {
        // A concurrent sweep created it first — fall through to the update path.
        if ((err as { code?: string })?.code !== 'P2002') throw err
      }
    }
    const changed = !existing || existing.contentHash !== contentHash
    // Score/reasons are refreshed every time (the profile may have changed);
    // status and first-seen are never touched by a re-delivery.
    await prisma.opportunity.updateMany({
      where: { workspaceId, source, externalId: c.externalId },
      data: { ...fields, lastSeenAt: now, ...(changed ? { lastChangedAt: now } : {}) },
    })
    if (changed) out.updated++
  }
  return out
}

async function runSource(
  profile: ProfileRow,
  source: OpportunitySource,
  now: Date,
  cache: Map<string, Promise<SourceFetchResult>>,
  fetchImpl: SourceFetchContext['fetchImpl'],
): Promise<SourceRunResult> {
  const { workspaceId } = profile
  const base: SourceRunResult = { workspaceId, source: source.name, status: 'skipped', fetched: 0, matched: 0, created: 0, updated: 0 }
  const input = profileInput(profile)

  const state = await prisma.discoverySourceState.upsert({
    where: { workspaceId_source: { workspaceId, source: source.name } },
    create: { workspaceId, source: source.name },
    update: {},
    select: { cursor: true },
  })

  const skipReason = !source.isConfigured ? `${source.label} is not configured on this server` : source.unavailableReason(input)
  if (skipReason) {
    await prisma.discoverySourceState.updateMany({ where: { workspaceId, source: source.name }, data: { lastRunAt: now, lastWarning: skipReason } })
    return { ...base, reason: skipReason }
  }

  const ctx: SourceFetchContext = { cursor: state.cursor, profile: input, now, ...(fetchImpl ? { fetchImpl } : {}) }
  try {
    const key = source.requestKey(ctx)
    let pending = cache.get(key)
    if (!pending) {
      pending = source.fetch(ctx)
      cache.set(key, pending)
    }
    const result = await pending
    const persisted = await persistCandidates(workspaceId, source.name, result.items, input, now)
    // Everything is stored — only now move the cursor.
    await prisma.discoverySourceState.updateMany({
      where: { workspaceId, source: source.name },
      data: {
        cursor: result.nextCursor,
        lastRunAt: now,
        lastSuccessAt: now,
        lastError: null,
        lastWarning: result.warning ?? null,
        lastFetched: result.items.length,
        lastMatched: persisted.matched,
      },
    })
    return { ...base, status: 'ok', fetched: result.items.length, ...persisted, ...(result.warning ? { warning: result.warning } : {}) }
  } catch (err) {
    const message = errorMessage(err)
    await prisma.discoverySourceState.updateMany({ where: { workspaceId, source: source.name }, data: { lastRunAt: now, lastError: message } }).catch(() => {})
    return { ...base, status: 'failed', reason: message }
  }
}

/**
 * Sweep every enabled profile (or just `workspaceId`'s). Never throws for a
 * source or workspace failure — those are recorded on DiscoverySourceState and
 * returned in `runs`.
 */
export async function runOpportunitySweep(opts: { workspaceId?: string } & SweepDeps = {}): Promise<SweepResult> {
  const now = opts.now ?? new Date()
  const sources = opts.sources ?? OPPORTUNITY_SOURCES
  const profiles = await prisma.discoveryProfile.findMany({
    where: { enabled: true, ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}) },
    select: { workspaceId: true, trades: true, keywords: true, baseLat: true, baseLng: true, radiusKm: true, regions: true, minValue: true, sources: true },
    orderBy: { workspaceId: 'asc' },
  })

  // Shared across workspaces for this sweep: a national feed is fetched once.
  const cache = new Map<string, Promise<SourceFetchResult>>()
  const runs: SourceRunResult[] = []
  for (const profile of profiles as ProfileRow[]) {
    for (const name of [...new Set(profile.sources)]) {
      const source = sources.find(s => s.name === name)
      if (!source) {
        runs.push({ workspaceId: profile.workspaceId, source: name, status: 'skipped', fetched: 0, matched: 0, created: 0, updated: 0, reason: 'Unknown source' })
        continue
      }
      runs.push(await runInWorkspaceContext(profile.workspaceId, () => runSource(profile, source, now, cache, opts.fetchImpl)))
    }
  }
  return { workspaces: profiles.length, runs }
}
