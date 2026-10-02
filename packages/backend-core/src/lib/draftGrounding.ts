// Draft grounding — no claim about the buyer without evidence.
//
// An opportunity's outreach draft is written from a fixed list of verified
// facts (its recommendation's cited evidence claims). After the draft is
// generated it is checked here, deterministically:
//
//   - every specific it states (a number, an amount, a percentage) must come from
//     a fact or from the seller's own context (offer, proof points, business
//     context) — otherwise it is unsupported;
//   - it must use at least one fact, or it isn't grounded in the evidence at all.
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
  return ['Verified facts — state nothing about the company beyond these:', ...lines].join('\n')
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
  const problems = [
    ...unsupported.map(v => `States "${v}" without evidence`),
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
