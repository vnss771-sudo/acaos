// Deterministic message relevance: how well a sent message fits the prospect
// and the seller's offer, scored 0–1 from evidence available BEFORE any
// outcome exists (the message, the lead's research, the workspace ICP).
//
// Invariant: no input to computeMessageRelevance can depend on a reply,
// bounce, unsubscribe or deal outcome. That is what makes it a legitimate
// learning feature (the old code wrote replied ? 0.8 : 0.2).
//
//   industry match      0.30  lead's industry is one the workspace targets
//   offer match         0.25  message mentions what the seller offers
//   signal alignment    0.20  message references a buying signal the research found
//   evidence relevance  0.15  message cites specifics about this prospect
//   context relevance   0.10  personalised, not a generic template opener
//
// Unknowns score a neutral 0.5 rather than 0, so missing ICP data doesn't read
// as "irrelevant". Bump MESSAGE_RELEVANCE_VERSION whenever the rules change so
// learned weights are never compared across incompatible definitions.

import { prisma } from './prisma.js'

export const MESSAGE_RELEVANCE_VERSION = 1

export const RELEVANCE_WEIGHTS = {
  industry: 0.3, offer: 0.25, signal: 0.2, evidence: 0.15, context: 0.1,
} as const

export type RelevanceInput = {
  subject: string | null
  body: string | null
  lead: {
    businessName: string | null
    category: string | null
    city: string | null
    aiSummary: string | null
    outreachAngle: string | null
    notes: string | null
  }
  icp: { targetIndustries: string[]; businessType: string | null; businessContext: string | null } | null
}

export type RelevanceResult = {
  score: number
  components: Record<keyof typeof RELEVANCE_WEIGHTS, number>
  reasons: string[]
  version: number
}

const STOPWORDS = new Set([
  'about', 'after', 'again', 'their', 'there', 'these', 'those', 'which', 'while', 'would', 'could', 'should',
  'other', 'where', 'being', 'every', 'business', 'businesses', 'company', 'companies', 'services', 'service',
  'with', 'from', 'that', 'this', 'your', 'have', 'will', 'into', 'more', 'than', 'they', 'what', 'when',
])

// Buying signals: [label, pattern]. A signal "aligns" when the research shows
// it AND the message references it.
const SIGNALS: Array<[string, RegExp]> = [
  ['hiring', /\b(hiring|recruit\w*|job openings?|open (roles|positions))\b/],
  ['expansion', /\b(expand\w*|expansion|new (site|location|office|branch|depot)|opened|opening)\b/],
  ['funding', /\b(funding|raised|investment|series [a-d])\b/],
  ['tender', /\b(tender|contract (win|awarded)|won (a|the) contract|awarded)\b/],
  ['launch', /\b(launch\w*|new (product|service|website))\b/],
  ['leadership', /\b(new (ceo|director|manager|owner)|appointed)\b/],
]

const norm = (s: string | null | undefined) => (s ?? '').toLowerCase()

function keywords(text: string, minLen: number, max: number): string[] {
  const seen = new Set<string>()
  for (const w of norm(text).split(/[^a-z0-9]+/)) {
    if (w.length >= minLen && !STOPWORDS.has(w)) seen.add(w)
    if (seen.size >= max) break
  }
  return [...seen]
}

const GENERIC_OPENERS = /\b(dear sir|dear madam|to whom it may concern|dear business owner|hello there)\b/

export function computeMessageRelevance(input: RelevanceInput): RelevanceResult {
  const message = norm(`${input.subject ?? ''} ${input.body ?? ''}`)
  const research = norm([input.lead.aiSummary, input.lead.outreachAngle, input.lead.notes].filter(Boolean).join(' '))
  const reasons: string[] = []

  // Industry match
  let industry = 0.5
  const targets = (input.icp?.targetIndustries ?? []).map(norm).filter(Boolean)
  const category = norm(input.lead.category)
  if (targets.length > 0 && category) {
    industry = targets.some(t => category.includes(t) || t.includes(category)) ? 1 : 0
    reasons.push(industry ? `Industry "${input.lead.category}" is a target industry` : `Industry "${input.lead.category}" is outside the target industries`)
  } else reasons.push('Industry fit unknown (no ICP industries or lead category)')

  // Offer match
  let offer = 0.5
  const offerTerms = keywords(`${input.icp?.businessType ?? ''} ${input.icp?.businessContext ?? ''}`, 5, 20)
  if (offerTerms.length > 0) {
    const hits = offerTerms.filter(t => message.includes(t)).length
    offer = Math.min(1, hits / 2)
    reasons.push(hits > 0 ? `Mentions the offer (${hits} offer term${hits === 1 ? '' : 's'})` : 'Does not mention what you offer')
  } else reasons.push('Offer unknown (no business type/context set)')

  // Signal alignment
  let signal = 0.5
  const found = SIGNALS.filter(([, re]) => re.test(research))
  if (found.length > 0) {
    const referenced = found.filter(([, re]) => re.test(message))
    signal = referenced.length > 0 ? 1 : 0.25
    reasons.push(referenced.length > 0
      ? `References a buying signal (${referenced.map(([l]) => l).join(', ')})`
      : `Ignores known buying signal (${found.map(([l]) => l).join(', ')})`)
  } else reasons.push('No buying signal in the research to reference')

  // Evidence relevance
  const facts = [norm(input.lead.businessName), norm(input.lead.city), ...keywords(`${input.lead.aiSummary ?? ''} ${input.lead.outreachAngle ?? ''}`, 6, 25)]
    .filter(f => f.length >= 3)
  const factHits = new Set(facts.filter(f => message.includes(f))).size
  const evidence = factHits >= 3 ? 1 : factHits === 2 ? 0.8 : factHits === 1 ? 0.5 : 0
  reasons.push(factHits > 0 ? `Cites ${factHits} prospect-specific detail${factHits === 1 ? '' : 's'}` : 'No prospect-specific details')

  // Context relevance
  let context = 1
  if (GENERIC_OPENERS.test(message)) { context -= 0.6; reasons.push('Generic template opener') }
  if (input.lead.businessName && !message.includes(norm(input.lead.businessName))) { context -= 0.4; reasons.push('Does not name the prospect') }
  context = Math.max(0, context)

  const components = { industry, offer, signal, evidence, context }
  const score = (Object.keys(RELEVANCE_WEIGHTS) as (keyof typeof RELEVANCE_WEIGHTS)[])
    .reduce((s, k) => s + RELEVANCE_WEIGHTS[k] * components[k], 0)
  return { score: Math.round(score * 1000) / 1000, components, reasons, version: MESSAGE_RELEVANCE_VERSION }
}

/**
 * Score a just-sent message once and store it on the send. Write-once (only
 * when unset) so a later recompute — after research or ICP edits — can never
 * rewrite the value that was true at send time. Best-effort: callers must
 * not let a failure here affect the send.
 */
export async function recordSendRelevance(outreachSentId: string): Promise<RelevanceResult | null> {
  const send = await prisma.outreachSent.findUnique({
    where: { id: outreachSentId },
    select: { workspaceId: true, leadId: true, subject: true, body: true, messageRelevanceScore: true },
  })
  if (!send || !send.leadId || send.messageRelevanceScore !== null) return null
  const [lead, icp] = await Promise.all([
    prisma.lead.findUnique({
      where: { id: send.leadId },
      select: { businessName: true, category: true, city: true, aiSummary: true, outreachAngle: true, notes: true },
    }),
    prisma.workspaceICP.findUnique({
      where: { workspaceId: send.workspaceId },
      select: { targetIndustries: true, businessType: true, businessContext: true },
    }),
  ])
  if (!lead) return null
  const result = computeMessageRelevance({ subject: send.subject, body: send.body, lead, icp })
  await prisma.outreachSent.updateMany({
    where: { id: outreachSentId, messageRelevanceScore: null },
    data: { messageRelevanceScore: result.score, messageRelevanceReasons: result.reasons, messageRelevanceVersion: result.version },
  })
  return result
}
