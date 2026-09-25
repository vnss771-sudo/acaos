// Work-discovery source connectors. Each one reads an upstream feed from a
// cursor and normalizes it into OpportunityCandidates; matching and persistence
// live elsewhere (opportunityMatch.ts, opportunitySweep.ts).
//
// Contract every source keeps:
//  - fetch() returns the items AFTER `cursor` plus the cursor to resume from.
//    The sweep only stores that cursor once every item is persisted, so a
//    failed run re-reads the same range (items are idempotent on externalId).
//  - Upstream payloads are validated with zod. An unexpected shape throws a
//    ProviderError-style failure rather than silently yielding nothing — "the
//    API changed" must never look like "no new work this week".
//  - A partial read (hit the page cap) returns a `warning` and a cursor that
//    only covers what was actually read.
//
// Upstream formats are coded against each provider's published documentation.
// scripts/smoke-discovery-sources.mjs checks them against the live APIs.
import { z } from 'zod'
import { callProvider } from './providerClient.js'
import { austenderBreaker, planningAlertsBreaker } from './circuit.js'
import {
  normalizeAuRegion, parseAuRegion,
  type DiscoveryProfileInput, type OpportunityCandidate, type OpportunityClassification, type OpportunityParty,
} from './opportunityTypes.js'

type FetchImpl = (url: string | URL, init: RequestInit, timeoutMs: number) => Promise<Response>

export type SourceFetchContext = {
  cursor: string | null
  profile: DiscoveryProfileInput
  now: Date
  /** Test seam: replaces the network. */
  fetchImpl?: FetchImpl
}

export type SourceFetchResult = {
  items: OpportunityCandidate[]
  /** Cursor to store once `items` are persisted. */
  nextCursor: string | null
  /** Set when the read stopped early (page cap) — surfaced on the source state. */
  warning?: string
}

export interface OpportunitySource {
  readonly name: string
  readonly label: string
  readonly description: string
  /** False when a required API key is missing; the sweep skips it. */
  readonly isConfigured: boolean
  /** Why the source can't run for this profile (e.g. no base location), or null. */
  unavailableReason(profile: DiscoveryProfileInput): string | null
  /**
   * Identical calls within one sweep share a result (a national feed is read
   * once, not once per workspace). Return the parameters the upstream call
   * depends on.
   */
  requestKey(ctx: SourceFetchContext): string
  fetch(ctx: SourceFetchContext): Promise<SourceFetchResult>
}

export class SourcePayloadError extends Error {
  constructor(source: string, detail: string) {
    super(`${source}: unexpected response shape — ${detail}`)
    this.name = 'SourcePayloadError'
  }
}

function parseOrThrow<T>(source: string, schema: z.ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data)
  if (!r.success) {
    const first = r.error.issues[0]
    throw new SourcePayloadError(source, `${first?.path.join('.') || '(root)'}: ${first?.message ?? 'invalid'}`)
  }
  return r.data
}

function toDate(v: string | null | undefined): Date | undefined {
  if (!v) return undefined
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? undefined : d
}

function clip(s: string | null | undefined, n: number): string | undefined {
  if (!s) return undefined
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t || undefined
}

// ── AusTender (Australian Government contract notices, OCDS) ───────────────────
// Open data (no key). Each contract notice (CN) is a contract a supplier has
// been awarded — for a subcontractor, the supplier is the head contractor to
// call. Read by publication date in one-day windows so a busy day can resume.

const AUSTENDER_BASE = process.env.AUSTENDER_API_BASE || 'https://api.tenders.gov.au/ocds'
const AUSTENDER_MAX_DAYS_PER_RUN = 7
const AUSTENDER_MAX_PAGES_PER_DAY = 40
const AUSTENDER_INITIAL_LOOKBACK_DAYS = 14

const ocdsAddress = z.object({
  streetAddress: z.string().nullish(),
  locality: z.string().nullish(),
  region: z.string().nullish(),
  postalCode: z.string().nullish(),
  countryName: z.string().nullish(),
}).passthrough()

const ocdsIdentifier = z.object({ id: z.union([z.string(), z.number()]).nullish(), scheme: z.string().nullish() }).passthrough()

const ocdsParty = z.object({
  id: z.union([z.string(), z.number()]).nullish(),
  name: z.string().nullish(),
  roles: z.array(z.string()).nullish(),
  address: ocdsAddress.nullish(),
  identifier: ocdsIdentifier.nullish(),
  additionalIdentifiers: z.array(ocdsIdentifier).nullish(),
  contactPoint: z.object({ name: z.string().nullish(), email: z.string().nullish(), telephone: z.string().nullish() }).passthrough().nullish(),
}).passthrough()

const ocdsValue = z.object({ amount: z.union([z.number(), z.string()]).nullish(), currency: z.string().nullish() }).passthrough()

const ocdsContract = z.object({
  id: z.union([z.string(), z.number()]),
  awardID: z.union([z.string(), z.number()]).nullish(),
  title: z.string().nullish(),
  description: z.string().nullish(),
  value: ocdsValue.nullish(),
  dateSigned: z.string().nullish(),
  period: z.object({ startDate: z.string().nullish(), endDate: z.string().nullish() }).passthrough().nullish(),
  items: z.array(z.object({
    classification: z.object({ scheme: z.string().nullish(), id: z.union([z.string(), z.number()]).nullish(), description: z.string().nullish() }).passthrough().nullish(),
  }).passthrough()).nullish(),
}).passthrough()

const ocdsRelease = z.object({
  ocid: z.string(),
  id: z.union([z.string(), z.number()]).nullish(),
  date: z.string().nullish(),
  parties: z.array(ocdsParty).nullish(),
  awards: z.array(z.object({
    id: z.union([z.string(), z.number()]).nullish(),
    suppliers: z.array(z.object({ id: z.union([z.string(), z.number()]).nullish(), name: z.string().nullish() }).passthrough()).nullish(),
  }).passthrough()).nullish(),
  contracts: z.array(ocdsContract).nullish(),
}).passthrough()

const ocdsPackage = z.object({
  releases: z.array(ocdsRelease),
  links: z.object({ next: z.string().nullish() }).passthrough().nullish(),
}).passthrough()

type OcdsRelease = z.infer<typeof ocdsRelease>
type OcdsParty = z.infer<typeof ocdsParty>

function abnOf(p: OcdsParty): string | undefined {
  for (const idf of [p.identifier, ...(p.additionalIdentifiers ?? [])]) {
    if (idf?.id != null && /abn/i.test(idf.scheme ?? '')) return String(idf.id).replace(/\s+/g, '')
  }
  return undefined
}

function partyOf(p: OcdsParty | undefined): OpportunityParty | undefined {
  if (!p?.name) return undefined
  return {
    name: p.name.trim(),
    ...(abnOf(p) ? { abn: abnOf(p) } : {}),
    ...(p.contactPoint?.email ? { email: p.contactPoint.email } : {}),
    ...(p.contactPoint?.telephone ? { phone: p.contactPoint.telephone } : {}),
  }
}

/** One candidate per contract in the release. Exported for tests. */
export function austenderReleaseToCandidates(release: OcdsRelease): OpportunityCandidate[] {
  const parties = release.parties ?? []
  const byRole = (role: string) => parties.find(p => (p.roles ?? []).some(r => r.toLowerCase() === role.toLowerCase()))
  const supplierParty = byRole('supplier')
  const buyerParty = byRole('procuringEntity') ?? byRole('buyer')
  const out: OpportunityCandidate[] = []

  for (const c of release.contracts ?? []) {
    // Prefer the supplier named on this contract's award when parties list several.
    const award = (release.awards ?? []).find(a => a.id != null && String(a.id) === String(c.awardID))
    const awardSupplier = award?.suppliers?.[0]
    const supplier = (awardSupplier?.id != null ? parties.find(p => p.id != null && String(p.id) === String(awardSupplier.id)) : undefined) ?? supplierParty
    const amount = c.value?.amount != null ? Number(c.value.amount) : NaN
    const classifications: OpportunityClassification[] = (c.items ?? [])
      .map(i => i.classification)
      .filter((k): k is NonNullable<typeof k> => Boolean(k?.id))
      .map(k => ({ scheme: k.scheme ?? 'UNSPSC', id: String(k.id), ...(k.description ? { description: k.description } : {}) }))
    const contractId = String(c.id)
    const addr = supplier?.address
    out.push({
      externalId: contractId,
      kind: 'CONTRACT_AWARD',
      title: clip(c.title, 160) ?? clip(c.description, 160) ?? `Contract ${contractId}`,
      ...(clip(c.description, 2000) ? { description: clip(c.description, 2000) } : {}),
      // AusTender gives no site address; the head contractor's own address is
      // the best proxy for where it operates.
      ...(addr?.locality ? { locality: addr.locality } : {}),
      ...(normalizeAuRegion(addr?.region) ? { region: normalizeAuRegion(addr?.region) } : {}),
      ...(addr?.postalCode ? { postcode: addr.postalCode } : {}),
      ...(Number.isFinite(amount) && amount > 0 ? { valueAmount: amount, currency: c.value?.currency ?? 'AUD' } : {}),
      ...(toDate(c.dateSigned ?? release.date) ? { publishedAt: toDate(c.dateSigned ?? release.date) } : {}),
      sourceUrl: `${AUSTENDER_BASE}/findById/${encodeURIComponent(contractId)}`,
      classifications,
      ...(partyOf(supplier) ? { counterparty: partyOf(supplier) } : {}),
      ...(partyOf(buyerParty) ? { buyer: { name: partyOf(buyerParty)!.name } } : {}),
      raw: { ocid: release.ocid, releaseId: release.id, contractId, awardId: c.awardID ?? null },
    })
  }
  return out
}

function dayStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

function iso(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export const austenderSource: OpportunitySource = {
  name: 'austender',
  label: 'AusTender contracts',
  description: 'Australian Government contracts just awarded — the winning head contractor may need subcontractors.',
  isConfigured: true,
  unavailableReason: () => null,
  // The feed is national: the same cursor means the same read for every workspace.
  requestKey: (ctx) => `austender:${ctx.cursor ?? 'initial'}:${dayStart(ctx.now).toISOString()}`,
  async fetch(ctx) {
    const today = dayStart(ctx.now)
    let from = ctx.cursor ? dayStart(new Date(ctx.cursor)) : new Date(today.getTime() - AUSTENDER_INITIAL_LOOKBACK_DAYS * 86_400_000)
    if (Number.isNaN(from.getTime())) from = new Date(today.getTime() - AUSTENDER_INITIAL_LOOKBACK_DAYS * 86_400_000)
    const items: OpportunityCandidate[] = []
    let completedThrough: Date | null = null
    let warning: string | undefined

    // Whole days only, oldest first; today is left for the next run so a day is
    // never marked done while notices are still being published into it.
    for (let d = 0; d < AUSTENDER_MAX_DAYS_PER_RUN; d++) {
      const start = new Date(from.getTime() + d * 86_400_000)
      const end = new Date(start.getTime() + 86_400_000)
      if (end > today) break
      let url: string | null = `${AUSTENDER_BASE}/findByDates/contractPublished/${iso(start)}/${iso(end)}`
      const dayItems: OpportunityCandidate[] = []
      let pages = 0
      while (url && pages < AUSTENDER_MAX_PAGES_PER_DAY) {
        const pageUrl: string = url
        const pkg = await callProvider({
          provider: 'austender',
          operation: 'findByDates/contractPublished',
          url: pageUrl,
          init: { method: 'GET', headers: { Accept: 'application/json' } },
          timeoutMs: 30_000,
          breaker: austenderBreaker,
          ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl, sleepImpl: async () => {} } : {}),
          onSuccess: async (res) => parseOrThrow('austender', ocdsPackage, await res.json()),
        })
        for (const r of pkg.releases) dayItems.push(...austenderReleaseToCandidates(r))
        url = pkg.links?.next || null
        pages++
      }
      if (url) {
        // A day too big to finish: keep what was read, but don't mark the day done.
        items.push(...dayItems)
        warning = `AusTender: ${iso(start).slice(0, 10)} has more than ${AUSTENDER_MAX_PAGES_PER_DAY} pages; it will be re-read next run`
        break
      }
      items.push(...dayItems)
      completedThrough = end
    }
    return {
      items,
      nextCursor: completedThrough ? completedThrough.toISOString() : ctx.cursor ?? from.toISOString(),
      ...(warning ? { warning } : {}),
    }
  },
}

// ── PlanningAlerts (development applications from Australian councils) ───────
// Needs PLANNINGALERTS_API_KEY; commercial use requires a paid plan from its
// operator (OpenAustralia Foundation). Queried by a bounding box around the
// workspace's base. Newest first, so the cursor is the highest id stored.

const PLANNINGALERTS_BASE = process.env.PLANNINGALERTS_API_BASE || 'https://api.planningalerts.org.au'
const PLANNINGALERTS_PAGE_SIZE = 100
const PLANNINGALERTS_MAX_PAGES = 10

const paApplication = z.object({
  application: z.object({
    id: z.number(),
    council_reference: z.string().nullish(),
    address: z.string(),
    description: z.string().nullish(),
    info_url: z.string().nullish(),
    lat: z.number().nullish(),
    lng: z.number().nullish(),
    date_received: z.string().nullish(),
    date_scraped: z.string().nullish(),
    authority: z.object({ full_name: z.string().nullish() }).passthrough().nullish(),
  }).passthrough(),
})
const paResponse = z.array(paApplication)
type PaApplication = z.infer<typeof paApplication>['application']

/** Exported for tests. */
export function planningAlertsToCandidate(a: PaApplication): OpportunityCandidate {
  const { region, postcode } = parseAuRegion(a.address)
  const description = clip(a.description, 2000)
  const firstClause = description?.split(/(?<=[.;])\s/)[0]
  return {
    externalId: String(a.id),
    kind: 'DEVELOPMENT_APPLICATION',
    title: clip(firstClause, 160) ?? `Development application at ${a.address}`,
    ...(description ? { description } : {}),
    address: a.address,
    ...(region ? { region } : {}),
    ...(postcode ? { postcode } : {}),
    ...(a.lat != null && a.lng != null ? { lat: a.lat, lng: a.lng } : {}),
    ...(toDate(a.date_received ?? a.date_scraped) ? { publishedAt: toDate(a.date_received ?? a.date_scraped) } : {}),
    ...(a.info_url ? { sourceUrl: a.info_url } : {}),
    ...(a.authority?.full_name ? { authority: a.authority.full_name } : {}),
    raw: { id: a.id, councilReference: a.council_reference ?? null },
  }
}

/** Bounding box (degrees) around a point. */
export function boundingBox(lat: number, lng: number, radiusKm: number) {
  const dLat = radiusKm / 111
  const dLng = radiusKm / (111 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)))
  return { bottomLeftLat: lat - dLat, bottomLeftLng: lng - dLng, topRightLat: lat + dLat, topRightLng: lng + dLng }
}

export const planningAlertsSource: OpportunitySource = {
  name: 'planningalerts',
  label: 'Council development applications',
  description: 'New development applications near you (via PlanningAlerts) — projects that will need trades before they start.',
  get isConfigured() { return Boolean(process.env.PLANNINGALERTS_API_KEY) },
  unavailableReason: (p) => (p.baseLat == null || p.baseLng == null ? 'Set a base location to search development applications near you' : null),
  requestKey: (ctx) => `planningalerts:${ctx.cursor ?? 'initial'}:${ctx.profile.baseLat},${ctx.profile.baseLng},${ctx.profile.radiusKm}`,
  async fetch(ctx) {
    const key = process.env.PLANNINGALERTS_API_KEY
    if (!key) throw new Error('planningalerts: PLANNINGALERTS_API_KEY not set')
    const { baseLat, baseLng, radiusKm } = ctx.profile
    if (baseLat == null || baseLng == null) throw new Error('planningalerts: profile has no base location')
    const box = boundingBox(baseLat, baseLng, radiusKm)
    const sinceId = ctx.cursor && /^\d+$/.test(ctx.cursor) ? Number(ctx.cursor) : null

    const items: OpportunityCandidate[] = []
    let maxId = sinceId ?? 0
    let page = 1
    let truncated = false
    for (;;) {
      const url = new URL(`${PLANNINGALERTS_BASE}/applications.json`)
      url.searchParams.set('key', key)
      url.searchParams.set('bottom_left_lat', box.bottomLeftLat.toFixed(5))
      url.searchParams.set('bottom_left_lng', box.bottomLeftLng.toFixed(5))
      url.searchParams.set('top_right_lat', box.topRightLat.toFixed(5))
      url.searchParams.set('top_right_lng', box.topRightLng.toFixed(5))
      url.searchParams.set('count', String(PLANNINGALERTS_PAGE_SIZE))
      url.searchParams.set('page', String(page))
      if (sinceId != null) url.searchParams.set('since_id', String(sinceId))
      const rows = await callProvider({
        provider: 'planningalerts',
        operation: 'applications',
        url,
        init: { method: 'GET', headers: { Accept: 'application/json' } },
        timeoutMs: 20_000,
        breaker: planningAlertsBreaker,
        ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl, sleepImpl: async () => {} } : {}),
        onSuccess: async (res) => parseOrThrow('planningalerts', paResponse, await res.json()),
      })
      for (const { application } of rows) {
        // since_id is honoured upstream; the filter is a guard, not the mechanism.
        if (sinceId != null && application.id <= sinceId) continue
        items.push(planningAlertsToCandidate(application))
        if (application.id > maxId) maxId = application.id
      }
      if (rows.length < PLANNINGALERTS_PAGE_SIZE) break
      if (page >= PLANNINGALERTS_MAX_PAGES) { truncated = true; break }
      page++
    }
    return {
      items,
      nextCursor: maxId > 0 ? String(maxId) : ctx.cursor,
      ...(truncated
        ? { warning: `PlanningAlerts: more than ${PLANNINGALERTS_MAX_PAGES * PLANNINGALERTS_PAGE_SIZE} new applications in your area; only the newest were read — consider a smaller radius` }
        : {}),
    }
  },
}

// ── Registry ─────────────────────────────────────────────────────────────────

export const OPPORTUNITY_SOURCES: readonly OpportunitySource[] = [austenderSource, planningAlertsSource]

export function getOpportunitySource(name: string): OpportunitySource | undefined {
  return OPPORTUNITY_SOURCES.find(s => s.name === name)
}
