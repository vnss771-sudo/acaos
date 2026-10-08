// Draft grounding — no claim about the buyer without evidence.
//
// An opportunity's outreach draft is written from a fixed list of verified
// facts (its recommendation's cited evidence claims). After the draft is
// generated it is checked here, deterministically:
//
//   - every specific it states (a number, an amount, a percentage) must come from
//     a fact or from the seller's own context (offer, proof points, business
//     context) — otherwise it is unsupported;
//   - it must use at least one fact, or it isn't grounded in the evidence at all;
//   - a small set of high-risk qualitative assertions (rapid growth, major scale,
//     market leadership, recent events) must be backed by a fact that itself
//     says so. This is deliberately a narrow deterministic vocabulary, not general
//     semantic entailment: fluent claims in these classes cannot slip past the
//     number check.
//
// The result is the grounding record: claim → evidence (signal) → source →
// confidence for each fact the draft uses, plus the problems found. A draft
// with problems can't be approved; the existing approval, suppression and
// send-cap path stays in charge of everything after that.
import type { RecommendationCitation } from './recommendationEngine.js'

export type GroundingFact = {
  /** F1, F2, … — how the draft prompt refers to the fact. */
  id: string
  claim: string
  signalId: string | null
  source: string
  sourceUrl: string | null
  eventDate: string
  ageDays: number
  /** 0..100 — the evidence quality behind the claim. */
  confidence: number
}

export type GroundedClaim = {
  factId: string
  claim: string
  signalId: string | null
  source: string
  sourceUrl: string | null
  confidence: number
  /** What in the draft tied it to the fact. */
  matchedOn: string[]
}

export type GroundingRecord = {
  facts: GroundingFact[]
  /** Seller-side text the draft may also draw on (offer, proof points). */
  context: string[]
  /** Null until a draft has been checked. */
  checkedAt: string | null
  grounded: boolean | null
  claims: GroundedClaim[]
  problems: string[]
}

export function factsFromCitations(citations: RecommendationCitation[]): GroundingFact[] {
  return citations.map((c, i) => ({
    id: `F${i + 1}`,
    claim: c.claim,
    signalId: c.signalId,
    source: c.source,
    sourceUrl: c.sourceUrl,
    eventDate: c.eventDate,
    ageDays: c.ageDays,
    confidence: Math.max(0, Math.min(100, Math.round(c.quality))),
  }))
}

export function initialGrounding(facts: GroundingFact[], context: string[]): GroundingRecord {
  return { facts, context: context.filter(t => t.trim()), checkedAt: null, grounded: null, claims: [], problems: [] }
}

/** The fact list a draft is written from — the only things it may state about the buyer. */
export function groundedSummary(facts: GroundingFact[]): string {
  const lines = facts.map(f => `${f.id}. ${f.claim} (${f.source}, ${f.ageDays <= 0 ? 'today' : f.ageDays === 1 ? '1 day ago' : `${f.ageDays} days ago`})`)
  return [
    'Verified facts — state nothing about the company beyond these:',
    ...lines,
    'Do not call the company fast-growing, a market leader, or say it recently did something unless a fact above says so.',
  ].join('\n')
}

/** Specific values a sentence can state: numbers, amounts, percentages ("$4.2M", "17", "18%"). */
export function specifics(text: string): string[] {
  const out = new Set<string>()
  const re = /\$?\d[\d,]*(?:\.\d+)?\s*(?:%|percent\b|million\b|billion\b|[kmb]\b)?/gi
  for (const m of text.matchAll(re)) {
    const v = m[0].toLowerCase().replace(/[\s,$]/g, '')
      .replace(/percent$/, '%').replace(/million$/, 'm').replace(/billion$/, 'b')
    out.add(v)
  }
  return [...out]
}

const STOPWORDS = new Set([
  'about', 'after', 'again', 'their', 'there', 'these', 'those', 'which', 'while', 'would', 'could', 'should',
  'other', 'where', 'being', 'reported', 'details', 'company', 'with', 'from', 'that', 'this', 'have',
])

function words(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z]{5,}/g) ?? []).filter(w => !STOPWORDS.has(w)))
}

/** A fact must be at most this old to back a "recently …" claim. */
export const RECENT_CLAIM_MAX_AGE_DAYS = 90

type QualitativeClaim = { label: string; supportedBy: (f: GroundingFact) => boolean; sellerMayState?: boolean }

const GROWTH_CLAIM = /\b(?:rapid(?:ly)?|fast|explosive|booming|surging|accelerating|exponential(?:ly)?)\s+(?:grow\w*|expan\w*|scal\w*)|\bgrowing\s+(?:fast|rapidly|quickly)\b|\bhyper-?growth\b|\bskyrocket\w*/gi
const GROWTH_EVIDENCE = /\b(?:rapid|fast|explosive|boom|surg|accelerat|exponential|hyper-?growth|doubl|tripl|record|skyrocket)/i
const SCALE_CLAIM = /\b(?:major|significant|massive|huge|substantial|large-scale)\s+(?:expansion|growth|investment|contract|project|deal|win|funding|round|hiring|rollout|upgrade|acquisition)\b/gi
const SCALE_EVIDENCE = /\b(?:major|significant|massive|huge|substantial|large-scale|large|record|largest|multi-?million|billion)\b|\$\s?\d/i
const LEADERSHIP_CLAIM = /\b(?:market|industry|sector)[- ]lead(?:er|ing)\b|\bleading\s+(?:provider|supplier|company|firm|player|brand)\b|\b(?:largest|biggest|fastest-growing|number one|no\.\s?1)\b|#1\b/gi
const LEADERSHIP_EVIDENCE = /\b(?:lead(?:er|ing)|largest|biggest|fastest|number one|no\.\s?1|top|ranked)\b|#1\b/i
const RECENCY_CLAIM = /\b(?:recent(?:ly)?|just)\s+(open|launch|expand|won|win|award|announc|acquir|rais|hir|secur|mov)\w*/gi
const RECENCY_STEMS: Record<string, RegExp> = {
  open: /\bopen/i, launch: /\blaunch/i, expand: /\bexpan/i, won: /\b(?:won|win)/i, win: /\b(?:won|win)/i,
  award: /\baward/i, announc: /\bannounc/i, acquir: /\bacqui/i, rais: /\brais/i, hir: /\bhir/i,
  secur: /\bsecur/i, mov: /\b(?:mov|relocat)/i,
}

/** High-risk qualitative assertions in the draft, each with what would support it. */
function qualitativeClaims(text: string): QualitativeClaim[] {
  const out: QualitativeClaim[] = []
  for (const m of text.matchAll(GROWTH_CLAIM)) out.push({ label: m[0], supportedBy: f => GROWTH_EVIDENCE.test(f.claim) })
  for (const m of text.matchAll(SCALE_CLAIM)) out.push({ label: m[0], supportedBy: f => SCALE_EVIDENCE.test(f.claim) })
  for (const m of text.matchAll(LEADERSHIP_CLAIM)) {
    out.push({ label: m[0], supportedBy: f => LEADERSHIP_EVIDENCE.test(f.claim), sellerMayState: true })
  }
  for (const m of text.matchAll(RECENCY_CLAIM)) {
    const stem = RECENCY_STEMS[m[1].toLowerCase()]
    out.push({ label: m[0], supportedBy: f => f.ageDays <= RECENT_CLAIM_MAX_AGE_DAYS && stem.test(f.claim) })
  }
  return out
}

/** Two shared significant words tie a sentence to a fact. */
const MIN_SHARED_WORDS = 2

export function checkDraftGrounding(
  draft: { subject: string; body: string; followup?: string | null },
  record: Pick<GroundingRecord, 'facts' | 'context'>,
  opts: { now: number; extraContext?: Array<string | null | undefined> },
): GroundingRecord {
  const text = [draft.subject, draft.body, draft.followup ?? ''].join('\n')
  const draftSpecifics = specifics(text)
  const draftWords = words(text)
  const context = [...record.context, ...(opts.extraContext ?? []).filter((t): t is string => !!t && !!t.trim())]

  const claims: GroundedClaim[] = []
  for (const f of record.facts) {
    const factSpecifics = new Set(specifics(f.claim))
    const sharedValues = draftSpecifics.filter(v => factSpecifics.has(v))
    const sharedWords = [...words(f.claim)].filter(w => draftWords.has(w))
    if (sharedValues.length > 0 || sharedWords.length >= MIN_SHARED_WORDS) {
      claims.push({
        factId: f.id, claim: f.claim, signalId: f.signalId, source: f.source, sourceUrl: f.sourceUrl,
        confidence: f.confidence, matchedOn: [...sharedValues, ...sharedWords],
      })
    }
  }

  const allowed = new Set([...record.facts.map(f => f.claim), ...context].flatMap(specifics))
  const unsupported = draftSpecifics.filter(v => !allowed.has(v))
  // Seller self-description may repeat its own leadership wording; nothing on the
  // seller side can back a growth, scale or recency claim about the buyer.
  const sellerText = context.join('\n')
  const unsupportedQualitative = qualitativeClaims(text).filter(c =>
    !record.facts.some(c.supportedBy) && !(c.sellerMayState && sellerText.toLowerCase().includes(c.label.toLowerCase())))
  const problems = [
    ...unsupported.map(v => `States "${v}" without evidence`),
    ...[...new Set(unsupportedQualitative.map(c => c.label.toLowerCase()))].map(l => `Claims "${l}" without supporting evidence`),
    ...(claims.length === 0 ? ['Uses none of the verified facts'] : []),
  ]
  return {
    facts: record.facts,
    context: record.context,
    checkedAt: new Date(opts.now).toISOString(),
    grounded: problems.length === 0,
    claims,
    problems,
  }
}
