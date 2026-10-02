// Commercial Event Engine — raw signals never drive outreach directly.
//
//   RAW SIGNALS ─▶ EVIDENCE ─▶ COMMERCIAL EVENTS ─▶ (offer) ─▶ OPPORTUNITY
//
// detectCommercialEvents() reads a company's signals and returns every
// commercially meaningful event the evidence supports ("hiring surge", "tender
// opportunity", "geographic expansion", ...), each with its confidence, what it
// likely means for a seller, and the exact signals behind it. One company can
// have several events at once; each is a hypothesis with traceable evidence.
//
// Each event kind belongs to a family — the coarse CommercialEventType from
// commercialEvent.ts — so offers and the next-best-action policy written
// against families keep working. Deterministic: rules over signal types,
// evidence wording and velocity; no model call.
import type { SignalType } from '@acaos/shared'
import type { CommercialEvent, CommercialEventType } from './commercialEvent.js'
import {
  assessSignalQuality, eventDate, signalVelocity, sourceKey,
  type CanonicalSignal, type SignalQuality, type SignalQualityGrade,
} from './signalIntelligence.js'

export const COMMERCIAL_EVENT_KINDS = [
  'TENDER_OPPORTUNITY', 'CONTRACT_OPPORTUNITY', 'PROCUREMENT_CHANGE', 'NEW_PROJECT',
  'CAPACITY_SHORTAGE', 'HIRING_SURGE', 'CAPACITY_EXPANSION', 'GEOGRAPHIC_EXPANSION',
  'FUNDING_DEPLOYMENT', 'TECHNOLOGY_REPLACEMENT', 'REGULATORY_CHANGE',
  'OPERATIONAL_DISRUPTION', 'LEADERSHIP_RESET', 'EARLY_TRIGGER',
] as const
export type CommercialEventKind = (typeof COMMERCIAL_EVENT_KINDS)[number]

export type EventFamily = Exclude<CommercialEventType, 'NO_CLEAR_EVENT'>

/** Only evidence from this window can support an event (matches commercialEvent.ts). */
export const EVENT_WINDOW_DAYS = 30
/** Gate 1, shared with the opportunity engine: uncorroborated events can't be high-confidence. */
export const SINGLE_SOURCE_CONFIDENCE_CAP = 60
const DAY_MS = 86_400_000

export type EvidenceClaim = {
  signalId: string | null
  signalType: SignalType
  /** What this piece of evidence says, in words. */
  claim: string
  source: string
  sourceKey: string
  sourceUrl: string | null
  eventDate: string
  quality: number
  grade: SignalQualityGrade
  trustworthy: boolean
}

export type CommercialEventHypothesis = {
  kind: CommercialEventKind
  family: EventFamily
  title: string
  /** What the event likely means for a seller. */
  implication: string
  whyNow: string
  confidence: number
  independentSources: number
  trustworthySignals: number
  /** True when ≥2 independent sources and ≥1 trustworthy signal back it (gate 1). */
  corroborated: boolean
  supportingTypes: SignalType[]
  evidence: EvidenceClaim[]
}

type Rule = {
  kind: CommercialEventKind
  family: EventFamily
  title: string
  implication: string
  /** Base confidence before corroboration and evidence quality. */
  base: number
  /** Signal types that can carry this event. */
  types: readonly SignalType[]
  /** Wording a signal must contain to count (any of). Absent = type alone suffices. */
  cues?: RegExp
  /** Extra condition over the whole evidence set. */
  when?: (ctx: RuleContext) => boolean
}

type RuleContext = {
  usable: CanonicalSignal[]
  types: Set<SignalType>
  hiringRecent: number
  hiringAccelerating: boolean
}

const CUE = {
  tender: /\b(tender|rfq|rfp|rft|request for (quote|quotation|tender|proposal)s?|expressions? of interest|eoi|invitation to (tender|quote))\b/,
  contractWon: /\b(awarded|award of|won (a|the)? ?contract|secured (a|the)? ?(\$?[\d.,]+[mk]? )?contract|contract (win|award)|appointed (as )?(the )?(head |principal )?contractor)\b/,
  procurementChange: /\b(new suppliers?|supplier (review|panel|change)|preferred suppliers?|supplier panel|procurement (review|change|reform)|switch(ing|ed)? (suppliers?|providers?|vendors?)|re-?tender)\b/,
  project: /\b(new project|project (awarded|commenc\w*|launch\w*|start\w*)|construction (commenc\w*|start\w*)|development (approv\w*|application approved)|breaks? ground|groundbreaking|commenc\w+ (works|construction))\b/,
  shortage: /\b(urgent(ly)?|immediate start|shortage|backlog|overtime|struggling to (staff|fill|hire)|multiple (vacancies|positions|roles)|short[- ]staffed)\b/,
  geo: /\b(new (office|depot|branch|site|location|warehouse|store|facility|yard|plant|showroom)|opens? (a |its )?(new )?\w* ?(office|depot|branch|site|location|warehouse|store|facility)|expand(s|ed|ing)? (into|to|across)|relocat\w+|interstate expansion)\b/,
  techReplace: /\b(replac\w+|migrat\w+|switch(ed|ing)? (to|from)|implement\w*|new (system|platform|software|erp|crm)|upgrad\w+|legacy|digital transformation|roll(ing|ed)? out)\b/,
  regulatory: /\b(regulat\w+|compliance|legislation|mandatory|new (standard|code|requirement)s?|licen[cs]e (change|requirement)s?|accreditation|audit)\b/,
  disruption: /\b(outage|disruption|fire|flood\w*|storm damage|recall|breach|shut ?down|strike|industrial action|insolven\w*|administration|supply chain (issue|problem|disruption)s?)\b/,
}

const RULES: readonly Rule[] = [
  {
    kind: 'TENDER_OPPORTUNITY', family: 'ACTIVE_PROCUREMENT', title: 'Tender opportunity', base: 74,
    implication: 'An open buying process — a chance to bid or quote now.',
    types: ['PROCUREMENT', 'NEWS_MENTION', 'WEBSITE_CHANGE'], cues: CUE.tender,
  },
  {
    kind: 'CONTRACT_OPPORTUNITY', family: 'ACTIVE_PROCUREMENT', title: 'Contract opportunity', base: 70,
    implication: 'Procurement activity indicates an active buying process for goods or services.',
    types: ['PROCUREMENT'],
    // Procurement that isn't a tender, a won contract or a supplier change.
    when: ctx => ctx.usable.some(s => s.type === 'PROCUREMENT' && !CUE.tender.test(text(s)) && !CUE.contractWon.test(text(s)) && !CUE.procurementChange.test(text(s))),
  },
  {
    kind: 'PROCUREMENT_CHANGE', family: 'ACTIVE_PROCUREMENT', title: 'Procurement change', base: 68,
    implication: 'Suppliers are being reviewed or replaced — incumbents are open to challenge.',
    types: ['PROCUREMENT', 'NEWS_MENTION', 'LEADERSHIP_CHANGE', 'WEBSITE_CHANGE'], cues: CUE.procurementChange,
  },
  {
    kind: 'NEW_PROJECT', family: 'CAPACITY_EXPANSION', title: 'New project', base: 70,
    implication: 'Awarded or starting work that must be delivered — likely demand for labour, subcontractors and supplies.',
    types: ['PROCUREMENT', 'NEWS_MENTION', 'EXPANSION', 'BUSINESS_REGISTRATION'],
    when: ctx => ctx.usable.some(s => CUE.project.test(text(s)) || CUE.contractWon.test(text(s))),
  },
  {
    kind: 'CAPACITY_SHORTAGE', family: 'CAPACITY_EXPANSION', title: 'Capacity shortage', base: 66,
    implication: 'Demand is outrunning capacity — likely need for extra people, equipment or outsourced delivery.',
    types: ['HIRING', 'NEWS_MENTION'], cues: CUE.shortage,
  },
  {
    kind: 'HIRING_SURGE', family: 'CAPACITY_EXPANSION', title: 'Hiring surge', base: 64,
    implication: 'Workforce is growing fast — onboarding, equipment, training and field support needs follow.',
    types: ['HIRING'],
    when: ctx => ctx.hiringAccelerating || ctx.hiringRecent >= 3
      || ctx.usable.some(s => s.type === 'HIRING' && /\b([5-9]|[1-9]\d+) (new )?([a-z-]+ )?(roles|positions|jobs|vacancies|staff|workers|technicians|electricians|people|hires)\b/.test(text(s))),
  },
  {
    kind: 'CAPACITY_EXPANSION', family: 'CAPACITY_EXPANSION', title: 'Capacity expansion', base: 70,
    implication: 'Expansion and workforce growth together indicate rising operational demand.',
    types: ['EXPANSION', 'HIRING'],
    when: ctx => ctx.types.has('EXPANSION') && ctx.types.has('HIRING'),
  },
  {
    kind: 'GEOGRAPHIC_EXPANSION', family: 'GROWTH_EVENT', title: 'Geographic expansion', base: 66,
    implication: 'Moving into a new location — fit-out, local suppliers, staffing and services are needed there.',
    types: ['EXPANSION', 'NEWS_MENTION', 'BUSINESS_REGISTRATION', 'WEBSITE_CHANGE'], cues: CUE.geo,
  },
  {
    kind: 'FUNDING_DEPLOYMENT', family: 'GROWTH_EVENT', title: 'Funding deployment', base: 62,
    implication: 'New capital is about to be spent — budgets are open for growth initiatives.',
    types: ['FUNDING'],
  },
  {
    kind: 'TECHNOLOGY_REPLACEMENT', family: 'DIGITAL_CHANGE', title: 'Technology replacement', base: 62,
    implication: 'A system is being replaced or introduced — integration, migration and training needs follow.',
    types: ['TECH_ADOPTION', 'WEBSITE_CHANGE', 'NEWS_MENTION'], cues: CUE.techReplace,
  },
  {
    kind: 'REGULATORY_CHANGE', family: 'ORGANISATIONAL_CHANGE', title: 'Regulatory change', base: 60,
    implication: 'New obligations create deadlines — compliance work, upgrades and advice are needed.',
    types: ['NEWS_MENTION', 'WEBSITE_CHANGE', 'BUSINESS_REGISTRATION', 'TECH_ADOPTION'], cues: CUE.regulatory,
  },
  {
    kind: 'OPERATIONAL_DISRUPTION', family: 'ORGANISATIONAL_CHANGE', title: 'Operational disruption', base: 60,
    implication: 'Something has gone wrong — urgent remediation, replacement or continuity support may be needed.',
    types: ['NEWS_MENTION', 'WEBSITE_CHANGE', 'LEADERSHIP_CHANGE'], cues: CUE.disruption,
  },
  {
    kind: 'LEADERSHIP_RESET', family: 'ORGANISATIONAL_CHANGE', title: 'Leadership reset', base: 58,
    implication: 'New leaders reset priorities and supplier relationships in their first months.',
    types: ['LEADERSHIP_CHANGE'],
  },
]

const TYPE_CLAIM: Record<SignalType, string> = {
  FUNDING: 'Funding activity', HIRING: 'Hiring activity', EXPANSION: 'Expansion activity',
  PROCUREMENT: 'Procurement activity', TECH_ADOPTION: 'Technology adoption', LEADERSHIP_CHANGE: 'Leadership change',
  NEWS_MENTION: 'News coverage', BUSINESS_REGISTRATION: 'Business registration', WEBSITE_CHANGE: 'Website change',
}

function text(s: CanonicalSignal): string {
  return `${s.title ?? ''} ${s.description ?? ''}`.toLowerCase()
}

function claimFor(s: CanonicalSignal): string {
  return s.title?.trim() || s.description?.trim().slice(0, 160) || TYPE_CLAIM[s.type]
}

function ruleMatches(rule: Rule, s: CanonicalSignal): boolean {
  if (!rule.types.includes(s.type)) return false
  return rule.cues ? rule.cues.test(text(s)) : true
}

/** For NEW_PROJECT and CONTRACT_OPPORTUNITY the cue lives in `when`; supporting signals are the cue-bearing ones. */
function supportingFor(rule: Rule, usable: CanonicalSignal[]): CanonicalSignal[] {
  if (rule.kind === 'NEW_PROJECT') return usable.filter(s => rule.types.includes(s.type) && (CUE.project.test(text(s)) || CUE.contractWon.test(text(s))))
  if (rule.kind === 'CONTRACT_OPPORTUNITY') return usable.filter(s => s.type === 'PROCUREMENT' && !CUE.tender.test(text(s)) && !CUE.contractWon.test(text(s)) && !CUE.procurementChange.test(text(s)))
  return usable.filter(s => ruleMatches(rule, s))
}

/**
 * Every commercial event the evidence supports, strongest first. Unusable
 * evidence (unreliable or expired) and evidence older than the event window are
 * excluded before any rule runs, so they can't manufacture an event.
 */
export function detectCommercialEvents(signals: CanonicalSignal[], opts: { now?: number } = {}): CommercialEventHypothesis[] {
  const now = opts.now ?? Date.now()
  const quality = new Map<CanonicalSignal, SignalQuality>(signals.map(s => [s, assessSignalQuality(s, { all: signals, now })]))
  const usable = signals.filter(s => {
    const q = quality.get(s)!
    const age = now - eventDate(s).getTime()
    return q.grade !== 'UNUSABLE' && age >= -DAY_MS && age <= EVENT_WINDOW_DAYS * DAY_MS
      && s.sourceReliability >= 40 && s.relevance >= 40
  })
  if (usable.length === 0) return []

  const hiring = signalVelocity(signals, { now }).find(v => v.type === 'HIRING')
  const ctx: RuleContext = {
    usable,
    types: new Set(usable.map(s => s.type)),
    hiringRecent: usable.filter(s => s.type === 'HIRING').length,
    hiringAccelerating: hiring?.trend === 'ACCELERATING',
  }

  const events: CommercialEventHypothesis[] = []
  for (const rule of RULES) {
    if (rule.when && !rule.when(ctx)) continue
    const supporting = supportingFor(rule, usable)
    if (supporting.length === 0) continue
    events.push(buildEvent(rule, supporting, quality, ctx))
  }

  // Nothing specific, but relevant recent activity: an early trigger, never more.
  if (events.length === 0) {
    events.push(buildEvent({
      kind: 'EARLY_TRIGGER', family: 'EARLY_BUYING_TRIGGER', title: 'Early buying trigger', base: 45,
      implication: 'Relevant recent activity that does not yet prove a specific commercial event.',
      types: [...ctx.types],
    }, usable, quality, ctx, 68))
  }
  return events.sort((a, b) => b.confidence - a.confidence || a.kind.localeCompare(b.kind))
}

function buildEvent(
  rule: Rule,
  supporting: CanonicalSignal[],
  quality: Map<CanonicalSignal, SignalQuality>,
  ctx: RuleContext,
  cap = 95,
): CommercialEventHypothesis {
  const independentSources = new Set(supporting.map(sourceKey)).size
  const trustworthySignals = supporting.filter(s => quality.get(s)!.trustworthy).length
  const avgQuality = supporting.reduce((a, s) => a + quality.get(s)!.overall, 0) / supporting.length
  // Corroboration from other event-relevant activity on the company counts too:
  // a tender plus a hiring signal is stronger than the tender alone.
  const otherTypes = [...ctx.types].filter(t => !supporting.some(s => s.type === t)).length
  let confidence = rule.base
    + Math.min(15, (independentSources - 1) * 6)
    + Math.min(8, otherTypes * 3)
    + Math.round((avgQuality - 60) / 4)
  const corroborated = independentSources >= 2 && trustworthySignals >= 1
  confidence = Math.max(1, Math.min(cap, corroborated ? confidence : Math.min(confidence, SINGLE_SOURCE_CONFIDENCE_CAP)))

  const evidence: EvidenceClaim[] = [...supporting]
    .sort((a, b) => quality.get(b)!.overall - quality.get(a)!.overall)
    .slice(0, 12)
    .map(s => {
      const q = quality.get(s)!
      return {
        signalId: s.id, signalType: s.type, claim: claimFor(s), source: s.source, sourceKey: sourceKey(s),
        sourceUrl: s.evidence?.sourceUrl ?? s.sourceUrl, eventDate: eventDate(s).toISOString(),
        quality: q.overall, grade: q.grade, trustworthy: q.trustworthy,
      }
    })

  const supportingTypes = [...new Set(supporting.map(s => s.type))]
  const whyNow = corroborated
    ? `${independentSources} independent sources in the last ${EVENT_WINDOW_DAYS} days: ${evidence.slice(0, 3).map(e => e.claim).join('; ')}`
    : `Single-source so far: ${evidence[0]?.claim ?? rule.title}`
  return {
    kind: rule.kind, family: rule.family, title: rule.title, implication: rule.implication, whyNow,
    confidence, independentSources, trustworthySignals, corroborated, supportingTypes, evidence,
  }
}

/** A hypothesis in the coarse CommercialEvent shape the next-best-action policy takes. */
export function toCommercialEvent(e: CommercialEventHypothesis): CommercialEvent {
  return { type: e.family, confidence: e.confidence, title: e.title, whyNow: `${e.implication} ${e.whyNow}`, supportingTypes: e.supportingTypes }
}

/** Does an offer trigger list (kinds and/or families) name this event? */
export function eventMatchesTriggers(e: Pick<CommercialEventHypothesis, 'kind' | 'family'>, triggers: readonly string[]): boolean {
  return triggers.includes(e.kind) || triggers.includes(e.family)
}
