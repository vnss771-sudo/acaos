// Loads the records behind the outcome graph (outcomeGraph.ts) — batched, every
// query scoped by workspaceId. Read-only.
import { prisma } from './prisma.js'
import {
  buildOutcomeChain, summarizeOutcomes,
  type OutcomeChain, type OutcomeIntent, type OutcomeOpportunity, type OutcomeRecord, type OutcomeSend, type OutcomeSummary,
} from './outcomeGraph.js'

/** Upper bound on opportunities rolled into one summary. */
export const MAX_SUMMARY_OPPORTUNITIES = 2000

type OppRow = OutcomeOpportunity & { prospectId: string }
type RecRow = { id: string; createdAt: Date; actionText: string | null; commercialOpportunityId: string }
type IntentRow = OutcomeIntent & { commercialOpportunityId: string }
type OutcomeRow = OutcomeRecord & { prospectId: string }

function groupBy<T, K>(rows: T[], key: (r: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>()
  for (const r of rows) m.set(key(r), [...(m.get(key(r)) ?? []), r])
  return m
}

async function chainsFor(workspaceId: string, opps: OppRow[]): Promise<OutcomeChain[]> {
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
      select: { id: true, status: true, createdAt: true, approvedAt: true, commercialOpportunityId: true },
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
    return buildOutcomeChain({
      opportunity: o,
      recommendation: recByOpp.get(o.id) ?? null,
      intents: its,
      sends: its.flatMap(i => sendsByIntent.get(i.id) ?? []),
      outcomes: outcomesByProspect.get(o.prospectId) ?? [],
    })
  })
}

const OPP_SELECT = { id: true, prospectId: true, status: true, statusChangedAt: true, firstDetectedAt: true, eventTitle: true }

export async function loadOutcomeChain(workspaceId: string, opportunityId: string): Promise<OutcomeChain | null> {
  const opp = await prisma.commercialOpportunity.findFirst({ where: { id: opportunityId, workspaceId }, select: OPP_SELECT }) as OppRow | null
  if (!opp) return null
  const [chain] = await chainsFor(workspaceId, [opp])
  return chain
}

/** The funnel and attributed revenue over the workspace's most recent opportunities. */
export async function loadOutcomeSummary(
  workspaceId: string,
  opts: { since?: Date } = {},
): Promise<OutcomeSummary & { truncated: boolean }> {
  const opps = await prisma.commercialOpportunity.findMany({
    where: { workspaceId, ...(opts.since ? { firstDetectedAt: { gte: opts.since } } : {}) },
    orderBy: { firstDetectedAt: 'desc' },
    take: MAX_SUMMARY_OPPORTUNITIES + 1,
    select: OPP_SELECT,
  }) as OppRow[]
  const truncated = opps.length > MAX_SUMMARY_OPPORTUNITIES
  const chains = await chainsFor(workspaceId, opps.slice(0, MAX_SUMMARY_OPPORTUNITIES))
  return { ...summarizeOutcomes(chains), truncated }
}
