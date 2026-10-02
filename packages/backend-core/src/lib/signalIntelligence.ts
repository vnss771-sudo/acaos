// Signal Intelligence Layer — one canonical shape for every signal, independent
// quality scores per signal, and velocity (change over time, not just state).
//
// Every discovery provider's output is read through toCanonicalSignal(), so no
// provider gets to invent its own interpretation: reliability, freshness,
// specificity, relevance, offer fit and corroboration are scored here, the same
// way for everyone. Deterministic and explainable — no model calls, and the
// existing opportunity-score maths in signalEngine.ts is untouched.
import type { SignalType } from '@acaos/shared'
import { freshnessRemaining, type RawSignal } from './signalEngine.js'

const DAY_MS = 86_400_000

export type SignalEvidence = {
  provider: string
  sourceType: string
  sourceUrl: string | null
  observedAt: Date
  /** 0..1, as stored on EvidenceSource. */
  confidence: number
}

export type CanonicalSignal = {
  id: string | null
  type: SignalType
  /** Provider / source name; 'unknown' when the producer didn't say. */
  source: string
  /** When ACAOS observed it. */
  observedAt: Date
  /** When the source says it happened; null when unknown. */
  publishedAt: Date | null
  entity: { prospectId: string | null; companyName: string | null }
  title: string | null
  description: string | null
  sourceUrl: string | null
  rawValue: unknown
  /** Signal strength, 0..100. */
  normalizedValue: number
  /** 0..100. */
  sourceReliability: number
  /** Industry/ICP relevance, 0..100. */
  relevance: number
  evidence: SignalEvidence | null
}

/** A DB Signal row (optionally with its EvidenceSource and Prospect) → CanonicalSignal. */
export function toCanonicalSignal(row: {
  id?: string | null
  type: SignalType
  strength: number
  sourceReliability: number
  industryRelevance: number
  detectedAt: Date
  publishedAt?: Date | null
  source?: string | null
  sourceUrl?: string | null
  title?: string | null
  description?: string | null
  rawData?: unknown
  prospectId?: string | null
  prospect?: { companyName?: string | null } | null
  evidenceSource?: {
    provider: string
    sourceType: string
    sourceUrl?: string | null
    observedAt: Date
    confidence: number
  } | null
}): CanonicalSignal {
  const ev = row.evidenceSource
  return {
    id: row.id ?? null,
    type: row.type,
    source: row.source?.trim() || ev?.provider || 'unknown',
    observedAt: row.detectedAt,
    publishedAt: row.publishedAt ?? null,
    entity: { prospectId: row.prospectId ?? null, companyName: row.prospect?.companyName ?? null },
    title: row.title ?? null,
    description: row.description ?? null,
    sourceUrl: row.sourceUrl ?? ev?.sourceUrl ?? null,
    rawValue: row.rawData ?? null,
    normalizedValue: clamp(row.strength),
    sourceReliability: clamp(row.sourceReliability),
    relevance: clamp(row.industryRelevance),
    evidence: ev
      ? { provider: ev.provider, sourceType: ev.sourceType, sourceUrl: ev.sourceUrl ?? null, observedAt: ev.observedAt, confidence: Math.max(0, Math.min(1, ev.confidence)) }
      : null,
  }
}

/** When the underlying event happened: the published date when known, else when we saw it. */
export function eventDate(s: CanonicalSignal): Date {
  return s.publishedAt ?? s.observedAt
}

/** CanonicalSignal → the RawSignal the scoring/event engines take (dated by eventDate). */
export function toRawFromCanonical(s: CanonicalSignal): RawSignal {
  return {
    type: s.type,
    strength: s.normalizedValue,
    sourceReliability: s.sourceReliability,
    industryRelevance: s.relevance,
    detectedAt: eventDate(s),
    source: s.source,
    evidenceSourceId: null,
    title: s.title,
    description: s.description,
  }
}

/**
 * The key two signals must differ on to count as independent confirmation: the
 * host of the cited URL when there is one, else the provider. Two signals from
 * the same site or the same provider are one source, however many there are.
 */
export function sourceKey(s: CanonicalSignal): string {
  const url = s.evidence?.sourceUrl ?? s.sourceUrl
  if (url) {
    try {
      return `host:${new URL(url).hostname.replace(/^www\./, '').toLowerCase()}`
    } catch { /* not a URL — fall through to the provider */ }
  }
  return `provider:${(s.evidence?.provider ?? s.source).toLowerCase()}`
}

// ── Quality ────────────────────────────────────────────────────────────────

export type SignalQualityGrade = 'HIGH' | 'MEDIUM' | 'LOW' | 'UNUSABLE'

export type SignalQuality = {
  /** How trustworthy is the source? */
  reliability: number
  /** How recently did this happen? */
  freshness: number
  /** Commercially meaningful detail, or generic activity? */
  specificity: number
  /** Does it relate to the customer's ICP? */
  relevance: number
  /** Does it suggest demand for what the customer sells? null = no offer to judge against. */
  offerFit: number | null
  /** Do independent sources confirm activity around the same time? */
  corroboration: number
  /** Number of other independent sources within the corroboration window. */
  independentSources: number
  overall: number
  grade: SignalQualityGrade
  /** Fit to be used as evidence for a high-confidence claim. */
  trustworthy: boolean
  reasons: string[]
}

export type SignalQualityContext = {
  /** Every signal on the same entity — used for corroboration. */
  all: CanonicalSignal[]
  /** Lower-cased terms describing what the customer sells. Empty/absent = no offer fit. */
  offerTerms?: string[]
  now?: number
}

/** Generic activity types are less specific evidence than direct buying events. */
const TYPE_SPECIFICITY: Record<SignalType, number> = {
  PROCUREMENT: 70, FUNDING: 65, EXPANSION: 60, HIRING: 55, LEADERSHIP_CHANGE: 55,
  TECH_ADOPTION: 50, BUSINESS_REGISTRATION: 50, NEWS_MENTION: 35, WEBSITE_CHANGE: 30,
}

export const CORROBORATION_WINDOW_DAYS = 30
const NO_PROVENANCE_RELIABILITY_CAP = 60

function clamp(n: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, Math.round(Number.isFinite(n) ? n : 0)))
}

function signalText(s: CanonicalSignal): string {
  return `${s.title ?? ''} ${s.description ?? ''}`.toLowerCase()
}

/** Lower-cased word tokens of 4+ chars — the unit offer fit matches on. */
export function textTerms(text: string): string[] {
  return [...new Set(text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(/\s+/).filter(t => t.length >= 4))]
}

export function assessSignalQuality(s: CanonicalSignal, ctx: SignalQualityContext): SignalQuality {
  const now = ctx.now ?? Date.now()
  const reasons: string[] = []

  // Reliability: provider reliability, blended with the evidence's own confidence.
  // A signal with no recorded provenance can't be more than moderately reliable.
  let reliability: number
  if (s.evidence) {
    reliability = clamp(s.sourceReliability * 0.6 + s.evidence.confidence * 100 * 0.4)
  } else {
    reliability = Math.min(s.sourceReliability, NO_PROVENANCE_RELIABILITY_CAP)
    reasons.push('No evidence source recorded — reliability capped')
  }

  const at = eventDate(s)
  const freshness = clamp(freshnessRemaining({ type: s.type, detectedAt: at }, now) * 100)
  if (freshness < 20) reasons.push('Evidence is stale')

  const text = signalText(s)
  let specificity = TYPE_SPECIFICITY[s.type] ?? 40
  if (/\d/.test(text)) specificity += 10 // a figure: an amount, a headcount, a date
  if (s.sourceUrl || s.evidence?.sourceUrl) specificity += 10
  if ((s.description ?? '').trim().length >= 40) specificity += 5
  if (!text.trim()) {
    specificity -= 15
    reasons.push('No title or description — generic activity')
  }
  specificity = clamp(specificity)

  const relevance = clamp(s.relevance)

  let offerFit: number | null = null
  const offerTerms = (ctx.offerTerms ?? []).filter(Boolean)
  if (offerTerms.length > 0) {
    const words = new Set(textTerms(text))
    const matched = offerTerms.filter(t => words.has(t))
    offerFit = clamp(30 + Math.min(70, matched.length * 25))
    if (matched.length) reasons.push(`Mentions offer terms: ${matched.slice(0, 4).join(', ')}`)
  }

  const ownKey = sourceKey(s)
  const otherKeys = new Set<string>()
  for (const o of ctx.all) {
    if (o === s || (o.id && o.id === s.id)) continue
    if (Math.abs(eventDate(o).getTime() - at.getTime()) > CORROBORATION_WINDOW_DAYS * DAY_MS) continue
    const k = sourceKey(o)
    if (k !== ownKey) otherKeys.add(k)
  }
  const independentSources = otherKeys.size
  const corroboration = independentSources === 0 ? 20 : independentSources === 1 ? 60 : independentSources === 2 ? 80 : 95
  if (independentSources > 0) reasons.push(`Corroborated by ${independentSources} independent source${independentSources === 1 ? '' : 's'}`)
  else reasons.push('Not yet corroborated by an independent source')

  const parts: Array<[number, number]> = [
    [reliability, 0.25], [freshness, 0.2], [specificity, 0.15], [relevance, 0.15], [corroboration, 0.15],
  ]
  if (offerFit !== null) parts.push([offerFit, 0.1])
  const weight = parts.reduce((a, [, w]) => a + w, 0)
  const overall = clamp(parts.reduce((a, [v, w]) => a + v * w, 0) / weight)

  // Hard floors: unreliable or expired evidence is unusable, whatever else it scores.
  const unusable = reliability < 40 || freshness < 10
  const grade: SignalQualityGrade = unusable ? 'UNUSABLE'
    : overall >= 75 ? 'HIGH' : overall >= 55 ? 'MEDIUM' : overall >= 35 ? 'LOW' : 'UNUSABLE'
  const trustworthy = !unusable && overall >= 55 && reliability >= 50 && freshness >= 20

  return { reliability, freshness, specificity, relevance, offerFit, corroboration, independentSources, overall, grade, trustworthy, reasons }
}

// ── Velocity ───────────────────────────────────────────────────────────────

export type VelocityTrend = 'NEW' | 'ACCELERATING' | 'STEADY' | 'DECELERATING' | 'DORMANT'

export type SignalVelocity = {
  type: SignalType
  windowDays: number
  recentCount: number
  priorCount: number
  /** % change recent vs prior window; null when the prior window was empty. */
  changePct: number | null
  trend: VelocityTrend
  summary: string
}

const TYPE_LABEL: Record<SignalType, string> = {
  FUNDING: 'Funding', HIRING: 'Hiring', EXPANSION: 'Expansion', PROCUREMENT: 'Procurement',
  TECH_ADOPTION: 'Technology adoption', LEADERSHIP_CHANGE: 'Leadership change', NEWS_MENTION: 'News',
  BUSINESS_REGISTRATION: 'Business registration', WEBSITE_CHANGE: 'Website change',
}

/**
 * Per-type activity in the last `windowDays` vs the window before it. Change is
 * often worth more than state: "hiring up 340% in 30 days" beats "hiring = true".
 */
export function signalVelocity(
  signals: CanonicalSignal[],
  opts: { windowDays?: number; now?: number } = {},
): SignalVelocity[] {
  const windowDays = opts.windowDays ?? 30
  const now = opts.now ?? Date.now()
  const w = windowDays * DAY_MS
  const byType = new Map<SignalType, { recent: number; prior: number }>()
  for (const s of signals) {
    const age = now - eventDate(s).getTime()
    if (age < 0 || age > 2 * w) continue
    const c = byType.get(s.type) ?? { recent: 0, prior: 0 }
    if (age <= w) c.recent++
    else c.prior++
    byType.set(s.type, c)
  }

  const out: SignalVelocity[] = []
  for (const [type, { recent, prior }] of byType) {
    const changePct = prior > 0 ? Math.round(((recent - prior) / prior) * 100) : null
    const trend: VelocityTrend = recent === 0 ? 'DORMANT'
      : prior === 0 ? 'NEW'
      : changePct! >= 50 ? 'ACCELERATING'
      : changePct! <= -50 ? 'DECELERATING'
      : 'STEADY'
    const label = TYPE_LABEL[type]
    const summary = trend === 'NEW' ? `${label}: ${recent} new signal${recent === 1 ? '' : 's'} in ${windowDays} days (none before)`
      : trend === 'DORMANT' ? `${label}: no signals in the last ${windowDays} days (${prior} before)`
      : `${label} signals ${changePct! >= 0 ? 'up' : 'down'} ${Math.abs(changePct!)}% over ${windowDays} days (${recent} vs ${prior})`
    out.push({ type, windowDays, recentCount: recent, priorCount: prior, changePct, trend, summary })
  }
  return out.sort((a, b) => b.recentCount - a.recentCount || a.type.localeCompare(b.type))
}

export type MetricPoint = { at: Date; value: number }

export type MetricVelocity = {
  metric: string
  from: number
  to: number
  windowDays: number
  changePct: number
  summary: string
}

/**
 * Numeric series reported on signals as rawValue `{ metric, value }` (e.g.
 * `{ metric: 'headcount', value: 123 }`), oldest first.
 */
export function metricPoints(signals: CanonicalSignal[], metric: string): MetricPoint[] {
  const pts: MetricPoint[] = []
  for (const s of signals) {
    const raw = s.rawValue as { metric?: unknown; value?: unknown } | null
    if (!raw || typeof raw !== 'object' || raw.metric !== metric) continue
    const value = Number(raw.value)
    if (Number.isFinite(value)) pts.push({ at: eventDate(s), value })
  }
  return pts.sort((a, b) => a.at.getTime() - b.at.getTime())
}

/**
 * Change in a metric across the window: the latest value vs the latest value at
 * or before the window start. null without a point on each side, or a zero base.
 */
export function metricVelocity(
  metric: string,
  points: MetricPoint[],
  opts: { windowDays?: number; now?: number } = {},
): MetricVelocity | null {
  const windowDays = opts.windowDays ?? 30
  const now = opts.now ?? Date.now()
  const start = now - windowDays * DAY_MS
  const sorted = [...points].filter(p => p.at.getTime() <= now).sort((a, b) => a.at.getTime() - b.at.getTime())
  const before = sorted.filter(p => p.at.getTime() <= start).at(-1)
  const latest = sorted.at(-1)
  if (!before || !latest || latest === before || before.value === 0) return null
  const changePct = Math.round(((latest.value - before.value) / before.value) * 100)
  return {
    metric, from: before.value, to: latest.value, windowDays, changePct,
    summary: `${metric} ${changePct >= 0 ? '+' : ''}${changePct}% over ${windowDays} days (${before.value} → ${latest.value})`,
  }
}
