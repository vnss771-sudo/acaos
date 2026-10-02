// Loads the records behind the outcome graph (outcomeGraph.ts) — batched, every
// query scoped by workspaceId — and attributes each closed or stalled chain to a
// cause (outcomeCauses.ts). Read-only.
import { prisma } from './prisma.js'
import {
  buildOutcomeChain, summarizeOutcomes,
  type OutcomeChain, type OutcomeIntent, type OutcomeOpportunity, type OutcomeRecord, type OutcomeSend, type OutcomeSummary,
} from './outcomeGraph.js'
import { attributeCause, OUTCOME_CAUSES, type CauseAttribution, type OutcomeCause } from './outcomeCauses.js'

/** Upper bound on opportunities rolled into one summary. */
export const MAX_SUMMARY_OPPORTUNITIES = 2000

type OppRow = OutcomeOpportunity & {
  prospectId: string
  eventType: string
  offerKey: string
  buyingStage: string
  competition: number | null
  contactability: number
  intelligenceGate: boolean
  evidence: unknown
  commercialEvent: { status: string } | null
}
type RecRow = { id: string; createdAt: Date; actionText: string | null; commercialOpportunityId: string }
type IntentRow = OutcomeIntent & { commercialOpportunityId: string; grounding: unknown }

export type CausedChain = { chain: OutcomeChain; cause: CauseAttribution | null; opportunity: OppRow }

function newestEvidenceAt(evidence: unknown): string | null {
  const dates = (Array.isArray(evidence) ? evidence : [])
    .map(e => (e as { eventDate?: unknown }).eventDate)
    .filter((d): d is string => typeof d === 'string' && !Number.isNaN(Date.parse(d)))
  return dates.length ? dates.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a)) : null
}
type OutcomeRow = OutcomeRecord & { prospectId: string }

function groupBy<T, K>(rows: T[], key: (r: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>()
  for (const r of rows) m.set(key(r), [...(m.get(key(r)) ?? []), r])
  return m
}

async function chainsFor(workspaceId: string, opps: OppRow[], now: Date): Promise<CausedChain[]> {
  if (opps.length === 0) return []
  const oppIds = opps.map(o => o.id)
  const prospectIds = [...new Set(opps.map(o => o.prospectId))]
  const [recs, intents, outcomes] = await Promise.all([
    prisma.recommendation.findMany({
      where: { workspaceId, commercialOpportunityId: { in: oppIds } },
      select: { id: true, createdAt: true, actionText: true, commercialOpportunityId: true },
    }) as Promise<RecRow[]>,
    prisma.outreachIntent.findMany({
      where: { workspaceId, commercialOpportunityId: { in: oppIds } },
      select: { id: true, status: true, createdAt: true, approvedAt: true, commercialOpportunityId: true, grounding: true },
    }) as Promise<IntentRow[]>,
    prisma.prospectOutcome.findMany({
      where: { workspaceId, prospectId: { in: prospectIds } },
      select: { id: true, stage: true, recordedAt: true, dealValue: true, prospectId: true },
    }) as Promise<OutcomeRow[]>,
  ])
  const sends = intents.length
    ? await prisma.outreachSent.findMany({
        where: { workspaceId, outreachIntentId: { in: intents.map(i => i.id) } },
        select: { id: true, outreachIntentId: true, status: true, sentAt: true, repliedAt: true, replyIntent: true, replyIsAutoReply: true },
      }) as OutcomeSend[]
    : []

  const recByOpp = new Map(recs.map(r => [r.commercialOpportunityId, r]))
  const intentsByOpp = groupBy(intents, i => i.commercialOpportunityId)
  const sendsByIntent = groupBy(sends, s => s.outreachIntentId)
  const outcomesByProspect = groupBy(outcomes, o => o.prospectId)

  return opps.map(o => {
    const its = intentsByOpp.get(o.id) ?? []
    const oppSends = its.flatMap(i => sendsByIntent.get(i.id) ?? [])
    const chain = buildOutcomeChain({
      opportunity: o,
      recommendation: recByOpp.get(o.id) ?? null,
      intents: its,
      sends: oppSends,
      outcomes: outcomesByProspect.get(o.prospectId) ?? [],
    })
    // Only drafts that went out (an intent with a send) say anything about the message.
    const sentIntents = its.filter(i => (sendsByIntent.get(i.id) ?? []).length > 0)
    const groundings = sentIntents.map(i => (i.grounding as { grounded?: boolean | null } | null)?.grounded ?? null)
    const cause = attributeCause(chain, {
      eventStatus: o.commercialEvent?.status ?? null,
      intelligenceGate: o.intelligenceGate,
      buyingStage: o.buyingStage,
      competition: o.competition,
      contactability: o.contactability,
      newestEvidenceAt: newestEvidenceAt(o.evidence),
      sends: oppSends,
      draftGrounded: groundings.includes(false) ? false : groundings.includes(true) ? true : null,
    }, now.getTime())
    return { chain, cause, opportunity: o }
  })
}

const OPP_SELECT = {
  id: true, prospectId: true, status: true, statusChangedAt: true, firstDetectedAt: true, eventTitle: true,
  eventType: true, offerKey: true, buyingStage: true, competition: true, contactability: true, intelligenceGate: true, evidence: true,
  commercialEvent: { select: { status: true } },
}

export async function loadOutcomeChain(
  workspaceId: string,
  opportunityId: string,
  opts: { now?: Date } = {},
): Promise<{ chain: OutcomeChain; cause: CauseAttribution | null } | null> {
  const opp = await prisma.commercialOpportunity.findFirst({ where: { id: opportunityId, workspaceId }, select: OPP_SELECT }) as OppRow | null
  if (!opp) return null
  const [{ chain, cause }] = await chainsFor(workspaceId, [opp], opts.now ?? new Date())
  return { chain, cause }
}

/** Every recent opportunity's chain with its cause — the input to closed-loop learning. */
export async function loadCausedChains(
  workspaceId: string,
  opts: { since?: Date; now?: Date } = {},
): Promise<{ items: CausedChain[]; truncated: boolean }> {
  const opps = await prisma.commercialOpportunity.findMany({
    where: { workspaceId, ...(opts.since ? { firstDetectedAt: { gte: opts.since } } : {}) },
    orderBy: { firstDetectedAt: 'desc' },
    take: MAX_SUMMARY_OPPORTUNITIES + 1,
    select: OPP_SELECT,
  }) as OppRow[]
  const truncated = opps.length > MAX_SUMMARY_OPPORTUNITIES
  return { items: await chainsFor(workspaceId, opps.slice(0, MAX_SUMMARY_OPPORTUNITIES), opts.now ?? new Date()), truncated }
}

/** The funnel and attributed revenue over the workspace's most recent opportunities. */
export async function loadOutcomeSummary(
  workspaceId: string,
  opts: { since?: Date; now?: Date } = {},
): Promise<OutcomeSummary & { causes: Record<OutcomeCause, number>; truncated: boolean }> {
  const { items, truncated } = await loadCausedChains(workspaceId, opts)
  const causes = Object.fromEntries(OUTCOME_CAUSES.map(c => [c, 0])) as Record<OutcomeCause, number>
  for (const i of items) if (i.cause) causes[i.cause.cause]++
  return { ...summarizeOutcomes(items.map(i => i.chain)), causes, truncated }
}
