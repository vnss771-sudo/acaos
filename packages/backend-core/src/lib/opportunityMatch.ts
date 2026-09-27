// Decides whether a discovered opportunity is worth showing a workspace, scores
// it 0–100, and says why in plain language. Pure and deterministic (no I/O, no
// AI) so every surfaced job can be explained and every rejection reproduced.
//
// Score = trade fit (≤40) + location (≤25) + size (≤20) + recency (≤15).
// Hard rejections: no trade fit, outside the service area, below the value floor.
import { createHash } from 'node:crypto'
import type { DiscoveryProfileInput, OpportunityCandidate } from './opportunityTypes.js'
import {
  TRADES, IMPLIED_BY_BUILD, LARGE_SCALE_KEYWORDS, MINOR_SCALE_KEYWORDS,
  findKeyword, tradeById, type TradeId,
} from './opportunityTaxonomy.js'

export const MIN_OPPORTUNITY_SCORE = 30

// Past these ages the window to win the work has usually closed: a head
// contractor lines up subcontractors soon after award; a development
// application is usually decided and built on within a year.
export const MAX_AGE_DAYS: Record<OpportunityCandidate['kind'], number> = {
  CONTRACT_AWARD: 120,
  DEVELOPMENT_APPLICATION: 365,
}

// UNSPSC segment 72: Building and Facility Construction and Maintenance Services.
const CONSTRUCTION_UNSPSC_SEGMENT = '72'

export type OpportunityMatch = {
  score: number
  matchedTrades: TradeId[]
  reasons: string[]
  recommendedAction: string
  distanceKm: number | null
}

export type MatchRejection = { rejected: true; reason: string }

/** Great-circle distance in km. */
export function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const rad = (d: number) => (d * Math.PI) / 180
  const dLat = rad(bLat - aLat)
  const dLng = rad(bLng - aLng)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)))
}

export function formatAud(amount: number): string {
  if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(amount >= 10_000_000 ? 0 : 1)}M`
  if (amount >= 1_000) return `$${Math.round(amount / 1_000)}k`
  return `$${Math.round(amount)}`
}

function ageDays(from: Date, now: Date): number {
  return Math.max(0, (now.getTime() - from.getTime()) / 86_400_000)
}

function describeAge(days: number): string {
  if (days < 1) return 'today'
  if (days < 2) return 'yesterday'
  return `${Math.floor(days)} days ago`
}

type TradeFit = { points: number; trades: TradeId[]; reason: string } | null

function tradeFit(c: OpportunityCandidate, p: DiscoveryProfileInput): TradeFit {
  const classText = (c.classifications ?? []).map(k => k.description ?? '').join(' · ')
  const construction = (c.classifications ?? []).some(k => /unspsc/i.test(k.scheme) && k.id.startsWith(CONSTRUCTION_UNSPSC_SEGMENT))
  const selected = p.trades.map(tradeById).filter((t): t is NonNullable<typeof t> => Boolean(t))

  // No trades chosen: any construction work qualifies, at a modest score.
  if (selected.length === 0 && p.keywords.length === 0) {
    const anyBuild = construction || c.kind === 'DEVELOPMENT_APPLICATION' || findKeyword(`${c.title} ${c.description ?? ''}`, TRADES.flatMap(t => t.keywords))
    return anyBuild ? { points: 15, trades: [], reason: 'Construction work (no trades selected in your profile yet)' } : null
  }

  let best: TradeFit = null
  const consider = (fit: NonNullable<TradeFit>) => { if (!best || fit.points > best.points) best = fit }

  for (const t of selected) {
    const inClass = findKeyword(classText, t.keywords)
    if (inClass && construction) {
      consider({ points: 40, trades: [t.id], reason: `Classified as ${t.label.toLowerCase()} work (“${(c.classifications ?? []).find(k => findKeyword(k.description, t.keywords))?.description ?? inClass}”)` })
      continue
    }
    const inTitle = findKeyword(c.title, t.keywords)
    if (inTitle) { consider({ points: 32, trades: [t.id], reason: `Mentions “${inTitle}” — ${t.label.toLowerCase()} work` }); continue }
    const inBody = findKeyword(c.description, t.keywords) ?? inClass
    if (inBody) consider({ points: 24, trades: [t.id], reason: `Description mentions “${inBody}” — ${t.label.toLowerCase()} work` })
  }

  // Custom keywords from the profile.
  const custom = findKeyword(`${c.title} ${c.description ?? ''} ${classText}`, p.keywords)
  if (custom) consider({ points: 28, trades: [], reason: `Matches your keyword “${custom}”` })

  // Implied: a general build / fit-out needs most trades even when it never names them.
  if (!best) {
    const text = `${c.title} ${c.description ?? ''} ${classText}`
    const buildWord = findKeyword(text, tradeById('building')!.keywords)
    const large = findKeyword(text, LARGE_SCALE_KEYWORDS)
    const minor = findKeyword(text, MINOR_SCALE_KEYWORDS)
    // Specialist work for another trade ("Electrical system services") is not a
    // general build that gets subcontracted out — it goes to that trade.
    const specialist = TRADES.some(t => t.id !== 'building' && findKeyword(text, t.keywords))
    const isBuild = c.kind === 'CONTRACT_AWARD' ? Boolean((buildWord || construction) && !specialist) : Boolean(buildWord && large && !minor)
    const implied = selected.filter(t => IMPLIED_BY_BUILD.has(t.id))
    if (isBuild && implied.length > 0) {
      const labels = implied.map(t => t.label.toLowerCase()).join(', ')
      consider({
        points: 20,
        trades: implied.map(t => t.id),
        reason: c.kind === 'CONTRACT_AWARD'
          ? `General building contract (“${buildWord ?? 'construction services'}”) — head contractors subcontract ${labels}`
          : `New ${large} development — it will need ${labels}`,
      })
    }
  }
  return best
}

type LocationFit = { points: number; reason: string; distanceKm: number | null } | MatchRejection

function locationFit(c: OpportunityCandidate, p: DiscoveryProfileInput): LocationFit {
  const hasBase = p.baseLat != null && p.baseLng != null
  const regions = p.regions.map(r => r.toUpperCase())
  if (hasBase && c.lat != null && c.lng != null) {
    const d = haversineKm(p.baseLat!, p.baseLng!, c.lat, c.lng)
    if (d > p.radiusKm) return { rejected: true, reason: `${Math.round(d)} km away (outside ${p.radiusKm} km)` }
    return { points: Math.round(25 * (1 - 0.6 * (d / Math.max(1, p.radiusKm)))), reason: `${d < 1 ? '<1' : Math.round(d)} km from your base`, distanceKm: d }
  }
  if (regions.length > 0 && c.region) {
    if (!regions.includes(c.region.toUpperCase())) return { rejected: true, reason: `In ${c.region}, outside your regions` }
    return { points: 18, reason: `In your service area (${c.region.toUpperCase()}${c.locality ? `, ${c.locality}` : ''})`, distanceKm: null }
  }
  if (hasBase || regions.length > 0) {
    return { points: 8, reason: 'Location not stated — check it’s in your area', distanceKm: null }
  }
  return { points: 12, reason: 'No service area set in your profile', distanceKm: null }
}

function sizeFit(c: OpportunityCandidate, p: DiscoveryProfileInput): { points: number; reason?: string } | MatchRejection {
  if (c.valueAmount != null && c.valueAmount > 0) {
    if (p.minValue != null && c.valueAmount < p.minValue) return { rejected: true, reason: `${formatAud(c.valueAmount)} is below your ${formatAud(p.minValue)} minimum` }
    // $10k → 0 … $10M+ → 20, on a log scale.
    const pts = Math.round(20 * Math.min(1, Math.max(0, (Math.log10(c.valueAmount) - 4) / 3)))
    return { points: pts, reason: `Contract value ${formatAud(c.valueAmount)}` }
  }
  const text = `${c.title} ${c.description ?? ''}`
  const large = findKeyword(text, LARGE_SCALE_KEYWORDS)
  if (large) return { points: 12, reason: `Larger job (“${large}”)` }
  if (findKeyword(text, MINOR_SCALE_KEYWORDS)) return { points: 0 }
  return { points: 6 }
}

function recommend(c: OpportunityCandidate, trades: TradeId[]): string {
  const label = trades.length === 1 ? tradeById(trades[0])!.label.toLowerCase() : 'your'
  if (c.kind === 'CONTRACT_AWARD') {
    return c.counterparty?.name
      ? `Contact ${c.counterparty.name} — they won this contract and may need ${label} subcontractors.`
      : `Find the head contractor on the contract notice and offer ${label} subcontracting.`
  }
  return `Check the council record for the applicant and builder, and offer a ${label} quote before works start.`
}

/**
 * Match a candidate against a workspace's discovery profile. Returns the scored
 * match, or a rejection with the reason (useful in logs and tests).
 */
export function matchOpportunity(c: OpportunityCandidate, p: DiscoveryProfileInput, now: Date = new Date()): OpportunityMatch | MatchRejection {
  if (c.publishedAt && ageDays(c.publishedAt, now) > MAX_AGE_DAYS[c.kind]) {
    return { rejected: true, reason: `Too old (${Math.floor(ageDays(c.publishedAt, now))} days)` }
  }
  const trade = tradeFit(c, p)
  if (!trade) return { rejected: true, reason: 'No trade fit' }
  const loc = locationFit(c, p)
  if ('rejected' in loc) return loc
  const size = sizeFit(c, p)
  if ('rejected' in size) return size

  const reasons = [trade.reason, loc.reason]
  if (size.reason) reasons.push(size.reason)
  let recency = 5
  if (c.publishedAt) {
    const days = ageDays(c.publishedAt, now)
    recency = Math.round(15 * Math.exp(-days / 21))
    reasons.push(`${c.kind === 'CONTRACT_AWARD' ? 'Awarded' : 'Lodged'} ${describeAge(days)}`)
  }
  if (c.kind === 'CONTRACT_AWARD' && c.counterparty?.name) reasons.push(`Head contractor: ${c.counterparty.name}`)
  if (c.buyer?.name) reasons.push(`For ${c.buyer.name}`)
  if (c.authority) reasons.push(`Lodged with ${c.authority}`)

  const score = Math.max(0, Math.min(100, trade.points + loc.points + size.points + recency))
  if (score < MIN_OPPORTUNITY_SCORE) return { rejected: true, reason: `Score ${score} below ${MIN_OPPORTUNITY_SCORE}` }
  return { score, matchedTrades: trade.trades, reasons, recommendedAction: recommend(c, trade.trades), distanceKm: loc.distanceKm }
}

export function isRejection(m: OpportunityMatch | MatchRejection): m is MatchRejection {
  return 'rejected' in m
}

/** Stable hash of the fields a user sees, to tell a real change from a re-delivery. */
export function candidateContentHash(c: OpportunityCandidate): string {
  const view = {
    title: c.title, description: c.description ?? null, address: c.address ?? null, region: c.region ?? null,
    valueAmount: c.valueAmount ?? null, counterparty: c.counterparty?.name ?? null, buyer: c.buyer?.name ?? null,
    publishedAt: c.publishedAt?.toISOString() ?? null,
  }
  return createHash('sha256').update(JSON.stringify(view)).digest('hex').slice(0, 32)
}
