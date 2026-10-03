// Outcome graph — what happened after ACAOS spotted an opportunity.
//
//   DETECTED → RECOMMENDED → PROPOSED → APPROVED → SENT → REPLIED
//     → MEETING → QUOTED → WON / LOST (→ revenue)
//
// A read model over records that already exist: the CommercialOpportunity, its
// bridged Recommendation, the OutreachIntents proposed from it, the OutreachSent
// rows stamped with those intents (and their replies), the prospect's recorded
// outcomes (ProspectOutcome) and the opportunity's own WON/LOST status. Nothing
// is written here. Deterministic: the same records give the same chain.
//
// Attribution: an outcome is SOURCED when it follows an ACAOS send for this
// opportunity, INFLUENCED when ACAOS had detected the opportunity first but no
// send preceded it, and NONE when nothing has happened yet.

export const OUTCOME_STAGES = [
  'DETECTED', 'RECOMMENDED', 'PROPOSED', 'APPROVED', 'SENT', 'REPLIED', 'MEETING', 'QUOTED', 'WON', 'LOST',
] as const
export type OutcomeGraphStage = (typeof OUTCOME_STAGES)[number]

/** The stages that are the buyer's response, not ACAOS's own steps. */
const BUYER_STAGES: ReadonlySet<OutcomeGraphStage> = new Set(['REPLIED', 'MEETING', 'QUOTED', 'WON', 'LOST'])
/** Buyer stages that imply the earlier ones were passed (a loss implies nothing). */
const PROGRESS_STAGES: ReadonlySet<OutcomeGraphStage> = new Set(['REPLIED', 'MEETING', 'QUOTED', 'WON'])

export type OutcomeNode = {
  stage: OutcomeGraphStage
  at: string
  ref: { type: 'commercialOpportunity' | 'recommendation' | 'outreachIntent' | 'outreachSent' | 'prospectOutcome' | 'quote'; id: string }
  detail: string | null
}

export type OutcomeAttribution = 'SOURCED' | 'INFLUENCED' | 'NONE'

export type OutcomeChain = {
  opportunityId: string
  nodes: OutcomeNode[]
  /** The furthest stage reached (WON/LOST count as final). */
  furthest: OutcomeGraphStage
  final: 'WON' | 'LOST' | null
  revenueCents: number | null
  attribution: OutcomeAttribution
  /** Days from detection to the final outcome, when there is one. */
  daysToOutcome: number | null
}

export type OutcomeOpportunity = {
  id: string
  status: string
  statusChangedAt: Date | null
  firstDetectedAt: Date
  eventTitle?: string | null
}
export type OutcomeRecommendation = { id: string; createdAt: Date; actionText: string | null } | null
export type OutcomeIntent = { id: string; status: string; createdAt: Date; approvedAt: Date | null }
export type OutcomeSend = {
  id: string
  outreachIntentId: string | null
  status: string
  sentAt: Date
  repliedAt: Date | null
  replyIntent: string | null
  replyIsAutoReply: boolean | null
}
export type OutcomeRecord = { id: string; stage: string; recordedAt: Date; dealValue: number | null }
// A quote priced against THIS opportunity (phase 15A). Exact attribution, so
// when an opportunity has any, they replace the prospect-level PROPOSAL/WON/LOST
// records (which count one win toward every opportunity of the prospect).
export type OutcomeQuote = { id: string; status: string; amountCents: number; createdAt: Date; submittedAt: Date | null; decidedAt: Date | null }

const DAY = 86_400_000
const SENT_STATUSES = new Set(['SENT', 'REPLIED'])
const RECORD_STAGE: Record<string, OutcomeGraphStage | undefined> = {
  MEETING: 'MEETING', PROPOSAL: 'QUOTED', WON: 'WON', LOST: 'LOST',
}
const ORDER = Object.fromEntries(OUTCOME_STAGES.map((s, i) => [s, i])) as Record<OutcomeGraphStage, number>

export function buildOutcomeChain(input: {
  opportunity: OutcomeOpportunity
  recommendation?: OutcomeRecommendation
  intents?: OutcomeIntent[]
  sends?: OutcomeSend[]
  outcomes?: OutcomeRecord[]
  quotes?: OutcomeQuote[]
}): OutcomeChain {
  const opp = input.opportunity
  const detectedAt = opp.firstDetectedAt.getTime()
  const nodes: OutcomeNode[] = [{
    stage: 'DETECTED', at: opp.firstDetectedAt.toISOString(),
    ref: { type: 'commercialOpportunity', id: opp.id }, detail: opp.eventTitle ?? null,
  }]
  const add = (n: OutcomeNode) => { nodes.push(n) }

  const rec = input.recommendation ?? null
  if (rec) add({ stage: 'RECOMMENDED', at: rec.createdAt.toISOString(), ref: { type: 'recommendation', id: rec.id }, detail: rec.actionText })

  const intents = [...(input.intents ?? [])].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
  const intentIds = new Set(intents.map(i => i.id))
  if (intents[0]) add({ stage: 'PROPOSED', at: intents[0].createdAt.toISOString(), ref: { type: 'outreachIntent', id: intents[0].id }, detail: intents[0].status })
  const approved = intents.filter(i => i.approvedAt).sort((a, b) => a.approvedAt!.getTime() - b.approvedAt!.getTime())[0]
  if (approved) add({ stage: 'APPROVED', at: approved.approvedAt!.toISOString(), ref: { type: 'outreachIntent', id: approved.id }, detail: null })

  // Only sends stamped with this opportunity's intents count as ACAOS outreach.
  const sends = (input.sends ?? [])
    .filter(s => s.outreachIntentId != null && intentIds.has(s.outreachIntentId) && SENT_STATUSES.has(s.status))
    .sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime())
  const firstSend = sends[0]
  if (firstSend) add({ stage: 'SENT', at: firstSend.sentAt.toISOString(), ref: { type: 'outreachSent', id: firstSend.id }, detail: null })
  const reply = sends
    .filter(s => s.repliedAt && s.replyIsAutoReply !== true)
    .sort((a, b) => a.repliedAt!.getTime() - b.repliedAt!.getTime())[0]
  if (reply) add({ stage: 'REPLIED', at: reply.repliedAt!.toISOString(), ref: { type: 'outreachSent', id: reply.id }, detail: reply.replyIntent })

  const seen = new Set<OutcomeGraphStage>()
  let revenueCents: number | null = null
  const quotes = input.quotes ?? []
  if (quotes.length) {
    const submitted = quotes.filter(q => q.submittedAt).sort((a, b) => a.submittedAt!.getTime() - b.submittedAt!.getTime())[0]
    if (submitted) { seen.add('QUOTED'); add({ stage: 'QUOTED', at: submitted.submittedAt!.toISOString(), ref: { type: 'quote', id: submitted.id }, detail: `${submitted.amountCents}` }) }
    const accepted = quotes.find(q => q.status === 'ACCEPTED')
    if (accepted) {
      seen.add('WON')
      revenueCents = accepted.amountCents
      add({ stage: 'WON', at: (accepted.decidedAt ?? accepted.createdAt).toISOString(), ref: { type: 'quote', id: accepted.id }, detail: `${accepted.amountCents}` })
    }
  }
  // Recorded outcomes for the prospect, from the moment the opportunity was
  // detected. With quotes, only MEETING still comes from here.
  const records = [...(input.outcomes ?? [])]
    .filter(o => o.recordedAt.getTime() >= detectedAt && RECORD_STAGE[o.stage] && (!quotes.length || o.stage === 'MEETING'))
    .sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime())
  for (const o of records) {
    const stage = RECORD_STAGE[o.stage]!
    if (stage === 'WON' && o.dealValue != null) revenueCents = o.dealValue
    if (seen.has(stage)) continue
    seen.add(stage)
    add({ stage, at: o.recordedAt.toISOString(), ref: { type: 'prospectOutcome', id: o.id }, detail: o.dealValue != null ? `${o.dealValue}` : null })
  }
  // The operator's decision on the opportunity itself.
  if ((opp.status === 'WON' || opp.status === 'LOST') && !seen.has(opp.status)) {
    const at = (opp.statusChangedAt ?? opp.firstDetectedAt).toISOString()
    add({ stage: opp.status, at, ref: { type: 'commercialOpportunity', id: opp.id }, detail: 'Operator decision' })
  }

  nodes.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || ORDER[a.stage] - ORDER[b.stage])

  const finals = nodes.filter(n => n.stage === 'WON' || n.stage === 'LOST')
  const finalNode = finals[finals.length - 1] ?? null
  const final = (finalNode?.stage ?? null) as OutcomeChain['final']
  const furthest = final ?? nodes.reduce<OutcomeGraphStage>((f, n) => (ORDER[n.stage] > ORDER[f] ? n.stage : f), 'DETECTED')

  const firstBuyer = nodes.find(n => BUYER_STAGES.has(n.stage))
  const attribution: OutcomeAttribution = !firstBuyer
    ? 'NONE'
    : firstSend && Date.parse(firstBuyer.at) >= firstSend.sentAt.getTime() ? 'SOURCED' : 'INFLUENCED'

  return {
    opportunityId: opp.id,
    nodes,
    furthest,
    final,
    revenueCents: final === 'WON' ? revenueCents : null,
    attribution,
    daysToOutcome: finalNode ? Math.max(0, Math.round((Date.parse(finalNode.at) - detectedAt) / DAY)) : null,
  }
}

export type OutcomeSummary = {
  opportunities: number
  /** How many chains reached each stage (WON and LOST are exclusive finals). */
  reached: Record<OutcomeGraphStage, number>
  /** Of the chains that reached a step, the share that reached the next (0..1); null when none reached it. */
  conversion: { detectedToSent: number | null; sentToReplied: number | null; repliedToMeeting: number | null; meetingToQuoted: number | null; quotedToWon: number | null }
  wonRevenueCents: { sourced: number; influenced: number }
  attribution: Record<OutcomeAttribution, number>
}

/** The stages a chain reached, counting the earlier buyer stages a later one implies. */
export function reachedStages(c: OutcomeChain): Set<OutcomeGraphStage> {
  const stages = new Set(c.nodes.map(n => n.stage))
  const out = new Set<OutcomeGraphStage>()
  for (const s of OUTCOME_STAGES) {
    if (s === 'WON' || s === 'LOST') { if (c.final === s) out.add(s); continue }
    // A meeting means they replied; a win means a quote.
    if (stages.has(s) || (PROGRESS_STAGES.has(s) && [...stages].some(x => PROGRESS_STAGES.has(x) && ORDER[x] > ORDER[s]))) out.add(s)
  }
  return out
}

export function summarizeOutcomes(chains: OutcomeChain[]): OutcomeSummary {
  const reached = Object.fromEntries(OUTCOME_STAGES.map(s => [s, 0])) as Record<OutcomeGraphStage, number>
  const attribution: Record<OutcomeAttribution, number> = { SOURCED: 0, INFLUENCED: 0, NONE: 0 }
  const wonRevenueCents = { sourced: 0, influenced: 0 }
  const sets = chains.map(reachedStages)
  for (const [i, c] of chains.entries()) {
    for (const s of sets[i]) reached[s]++
    attribution[c.attribution]++
    if (c.final === 'WON' && c.revenueCents != null) {
      if (c.attribution === 'SOURCED') wonRevenueCents.sourced += c.revenueCents
      else wonRevenueCents.influenced += c.revenueCents
    }
  }
  // Of the chains that reached `from`, the share that also reached `to`.
  const rate = (from: OutcomeGraphStage, to: OutcomeGraphStage): number | null => {
    const base = sets.filter(x => x.has(from))
    return base.length === 0 ? null : Math.round((base.filter(x => x.has(to)).length / base.length) * 1000) / 1000
  }
  return {
    opportunities: chains.length,
    reached,
    conversion: {
      detectedToSent: rate('DETECTED', 'SENT'),
      sentToReplied: rate('SENT', 'REPLIED'),
      repliedToMeeting: rate('REPLIED', 'MEETING'),
      meetingToQuoted: rate('MEETING', 'QUOTED'),
      quotedToWon: rate('QUOTED', 'WON'),
    },
    wonRevenueCents,
    attribution,
  }
}
