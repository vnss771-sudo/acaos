// Contractor pilot scorecard: is ACAOS helping this contractor find and win
// worthwhile work? Weekly counts against the pilot targets in POSITIONING.md
// (work found, quotes recorded from Find work, won jobs closed out with an
// invoice, a most profitable source), plus what was won and what it earned.
//
// Find work only: the work ACAOS surfaced (tenders, development applications,
// enquiries from the inbox), followed through its quotes and its job.
// buildPilotScorecard is pure; loadPilotScorecard reads one workspace's rows.
//
// Definitions, all over rolling 7-day weeks ending now:
// - found: work first seen in the week.
// - worth pursuing: of the work found in the week, what was pursued, quoted,
//   won or lost (not left new or dismissed).
// - quoted: work whose first quote went to the client in the week, counted
//   once however often it was revised, at its latest price.
// - won: work marked won in the week, at its accepted quote. A win with no
//   accepted quote counts with an unknown amount, never $0.
// - closed out: won work whose job is complete with an invoice entered.
// - margin: gross margin from the frozen closeouts of jobs completed in the
//   window, pooled (total margin over total revenue). Jobs without a gross
//   margin (other costs not entered) are counted as unknown.

import { prisma } from './prisma.js'
import type { JobEconomics } from './jobEconomics.js'

export const PILOT_TARGETS = { foundPerWeek: 3, quotesPerWeek: 2, closeoutRate: 0.8 } as const
export const SCORECARD_DEFAULT_WEEKS = 13 // the 90-day pilot
export const SCORECARD_MAX_WEEKS = 26
// A contractor's filtered Find work is tens of items a week; this only bounds
// a pathological workspace.
const MAX_OPPORTUNITIES = 5000
const WEEK_MS = 7 * 86_400_000

export const FIND_WORK_KIND_LABEL: Record<string, string> = {
  DEVELOPMENT_APPLICATION: 'Development applications',
  CONTRACT_AWARD: 'Contract awards',
  DIRECT_ENQUIRY: 'Direct enquiries',
}

export interface ScorecardQuote {
  status: string
  amountCents: number
  submittedAt: Date | null
  createdAt: Date
}

export interface ScorecardJob {
  status: string
  invoicedRevenueCents: number | null
  completedAt: Date | null
  closeout: unknown
}

export interface ScorecardOpportunity {
  kind: string
  status: string
  firstSeenAt: Date
  statusChangedAt: Date | null
  quotes: ScorecardQuote[]
  job: ScorecardJob | null
}

export interface ScorecardWeek {
  start: string
  end: string
  // The week began before Find work was set up, so it isn't a full week.
  partial: boolean
  found: number
  pursued: number
  quoted: number
  quotedCents: number
  won: number
  wonCents: number
  wonWithoutAmount: number
}

export interface ScorecardSource {
  kind: string
  label: string
  found: number
  quoted: number
  won: number
  wonCents: number
  closedJobs: number
  grossMarginJobs: number
  grossMarginCents: number | null
  grossMarginPct: number | null
}

export interface PilotScorecard {
  generatedAt: string
  findWorkSetUp: boolean
  window: { start: string; end: string; weeks: number }
  targets: typeof PILOT_TARGETS
  // Newest first: weeks[0] is the last 7 days.
  weeks: ScorecardWeek[]
  totals: Omit<ScorecardWeek, 'start' | 'end' | 'partial'>
  conversion: {
    // Of the work found in the window, how much has been quoted so far.
    discoveryToQuote: { found: number; quoted: number; rate: number | null }
    // Of the work first quoted in the window, how much the client accepted,
    // over the quotes with a decision.
    quoteToWon: { quoted: number; won: number; lost: number; awaiting: number; rate: number | null }
  }
  // Work won in the window and where its job stands. Cancelled jobs are left
  // out: they can't be closed out.
  closeout: { won: number; closedOut: number; closedWithoutInvoice: number; inProgress: number; notStarted: number; cancelled: number; rate: number | null }
  margin: { closedJobs: number; grossMarginJobs: number; grossMarginCents: number | null; revenueCents: number | null; grossMarginPct: number | null }
  sources: ScorecardSource[]
  // The source that made the most gross margin; until any job has one, the
  // source with the most won work by value.
  bestSource: null | { kind: string; label: string; basis: 'GROSS_MARGIN' | 'WON_VALUE'; cents: number; jobs: number }
  checks: {
    thisWeek: { found: boolean; quotes: boolean }
    // Full weeks only.
    weeksMet: { found: number; quotes: number; of: number }
    closeout: boolean | null
    sourceIdentified: boolean
  }
}

const inRange = (d: Date | null, start: number, end: number) => d != null && d.getTime() >= start && d.getTime() < end
const ratio = (num: number, den: number): number | null => (den > 0 ? Math.round((num / den) * 1000) / 1000 : null)
const pct1 = (num: number, den: number): number | null => (den > 0 ? Math.round((num / den) * 1000) / 10 : null)

function firstQuoteAt(o: ScorecardOpportunity): Date | null {
  let first: Date | null = null
  for (const q of o.quotes) if (q.submittedAt && (!first || q.submittedAt < first)) first = q.submittedAt
  return first
}

// The price the client is looking at: the latest submitted quote that wasn't
// withdrawn, else the latest submitted one.
function currentQuote(o: ScorecardOpportunity): ScorecardQuote | null {
  const submitted = o.quotes.filter(q => q.submittedAt != null).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
  const live = submitted.filter(q => q.status !== 'WITHDRAWN')
  return live[live.length - 1] ?? submitted[submitted.length - 1] ?? null
}

const acceptedQuote = (o: ScorecardOpportunity) => o.quotes.find(q => q.status === 'ACCEPTED') ?? null
const isPursued = (o: ScorecardOpportunity) => ['PURSUING', 'WON', 'LOST'].includes(o.status) || firstQuoteAt(o) != null
const wonAt = (o: ScorecardOpportunity) => (o.status === 'WON' ? o.statusChangedAt : null)

function grossOf(job: ScorecardJob | null): { revenueCents: number; grossMarginCents: number } | null {
  const e = job?.closeout as Partial<JobEconomics> | null | undefined
  if (!e || e.marginBasis !== 'GROSS' || e.grossMarginCents == null || !e.revenueCents) return null
  return { revenueCents: e.revenueCents, grossMarginCents: e.grossMarginCents }
}

function closedIn(job: ScorecardJob | null, start: number, end: number): boolean {
  return job != null && job.status === 'COMPLETE' && job.closeout != null && inRange(job.completedAt, start, end)
}

function tally(opps: ScorecardOpportunity[], start: number, end: number) {
  const t = { found: 0, pursued: 0, quoted: 0, quotedCents: 0, won: 0, wonCents: 0, wonWithoutAmount: 0 }
  for (const o of opps) {
    if (inRange(o.firstSeenAt, start, end)) {
      t.found++
      if (isPursued(o)) t.pursued++
    }
    if (inRange(firstQuoteAt(o), start, end)) {
      t.quoted++
      t.quotedCents += currentQuote(o)?.amountCents ?? 0
    }
    if (inRange(wonAt(o), start, end)) {
      t.won++
      const accepted = acceptedQuote(o)
      if (accepted) t.wonCents += accepted.amountCents
      else t.wonWithoutAmount++
    }
  }
  return t
}

export function buildPilotScorecard(input: {
  now: Date
  weeks: number
  // When Find work was set up (else when the workspace was created): weeks
  // that ended before it aren't shown.
  since: Date | null
  findWorkSetUp: boolean
  opportunities: ScorecardOpportunity[]
}): PilotScorecard {
  const { opportunities: opps } = input
  const nowMs = input.now.getTime()
  const sinceMs = input.since?.getTime() ?? null
  const count = Math.max(1, Math.min(SCORECARD_MAX_WEEKS, Math.floor(input.weeks)))

  const weeks: ScorecardWeek[] = []
  for (let i = 0; i < count; i++) {
    const end = nowMs - i * WEEK_MS
    const start = end - WEEK_MS
    if (i > 0 && sinceMs != null && end <= sinceMs) break
    weeks.push({
      start: new Date(start).toISOString(), end: new Date(end).toISOString(),
      partial: sinceMs != null && start < sinceMs,
      ...tally(opps, start, end),
    })
  }
  const windowStart = nowMs - weeks.length * WEEK_MS
  const totals = tally(opps, windowStart, nowMs)

  // Conversions.
  const foundCohort = opps.filter(o => inRange(o.firstSeenAt, windowStart, nowMs))
  const quotedCohort = opps.filter(o => inRange(firstQuoteAt(o), windowStart, nowMs))
  let qWon = 0, qLost = 0
  for (const o of quotedCohort) {
    const status = currentQuote(o)?.status
    if (status === 'ACCEPTED' || o.status === 'WON') qWon++
    else if (status === 'REJECTED' || o.status === 'LOST') qLost++
  }

  // Close-out of the work won in the window.
  const won = opps.filter(o => inRange(wonAt(o), windowStart, nowMs))
  const closeout = { won: won.length, closedOut: 0, closedWithoutInvoice: 0, inProgress: 0, notStarted: 0, cancelled: 0, rate: null as number | null }
  for (const o of won) {
    const job = o.job
    if (!job) closeout.notStarted++
    else if (job.status === 'CANCELLED') closeout.cancelled++
    else if (job.status === 'COMPLETE' && job.invoicedRevenueCents != null) closeout.closedOut++
    else if (job.status === 'COMPLETE') closeout.closedWithoutInvoice++
    else closeout.inProgress++
  }
  closeout.rate = ratio(closeout.closedOut, closeout.won - closeout.cancelled)

  // Margin from the jobs closed out in the window, and the same by source.
  const closed = opps.filter(o => closedIn(o.job, windowStart, nowMs))
  const pooled = (list: ScorecardOpportunity[]) => {
    let marginCents = 0, revenueCents = 0, jobs = 0
    for (const o of list) {
      const g = grossOf(o.job)
      if (!g) continue
      jobs++
      marginCents += g.grossMarginCents
      revenueCents += g.revenueCents
    }
    return jobs > 0
      ? { grossMarginJobs: jobs, grossMarginCents: marginCents, revenueCents, grossMarginPct: pct1(marginCents, revenueCents) }
      : { grossMarginJobs: 0, grossMarginCents: null, revenueCents: null, grossMarginPct: null }
  }
  const margin = { closedJobs: closed.length, ...pooled(closed) }

  const kinds = [...new Set([...Object.keys(FIND_WORK_KIND_LABEL), ...opps.map(o => o.kind)])]
  const sources: ScorecardSource[] = kinds.map(kind => {
    const mine = opps.filter(o => o.kind === kind)
    const t = tally(mine, windowStart, nowMs)
    const closedMine = closed.filter(o => o.kind === kind)
    const p = pooled(closedMine)
    return {
      kind, label: FIND_WORK_KIND_LABEL[kind] ?? kind,
      found: t.found, quoted: t.quoted, won: t.won, wonCents: t.wonCents,
      closedJobs: closedMine.length, grossMarginJobs: p.grossMarginJobs, grossMarginCents: p.grossMarginCents, grossMarginPct: p.grossMarginPct,
    }
  }).filter(s => s.found + s.quoted + s.won + s.closedJobs > 0)

  let bestSource: PilotScorecard['bestSource'] = null
  const byMargin = sources.filter(s => s.grossMarginCents != null).sort((a, b) => b.grossMarginCents! - a.grossMarginCents!)
  if (byMargin.length > 0) {
    const s = byMargin[0]
    bestSource = { kind: s.kind, label: s.label, basis: 'GROSS_MARGIN', cents: s.grossMarginCents!, jobs: s.grossMarginJobs }
  } else {
    const byValue = sources.filter(s => s.wonCents > 0).sort((a, b) => b.wonCents - a.wonCents)
    if (byValue.length > 0) {
      const s = byValue[0]
      bestSource = { kind: s.kind, label: s.label, basis: 'WON_VALUE', cents: s.wonCents, jobs: s.won }
    }
  }

  const full = weeks.filter(w => !w.partial)
  return {
    generatedAt: input.now.toISOString(),
    findWorkSetUp: input.findWorkSetUp,
    window: { start: new Date(windowStart).toISOString(), end: input.now.toISOString(), weeks: weeks.length },
    targets: PILOT_TARGETS,
    weeks,
    totals,
    conversion: {
      discoveryToQuote: {
        found: foundCohort.length,
        quoted: foundCohort.filter(o => firstQuoteAt(o) != null).length,
        rate: ratio(foundCohort.filter(o => firstQuoteAt(o) != null).length, foundCohort.length),
      },
      quoteToWon: { quoted: quotedCohort.length, won: qWon, lost: qLost, awaiting: quotedCohort.length - qWon - qLost, rate: ratio(qWon, qWon + qLost) },
    },
    closeout,
    margin,
    sources,
    bestSource,
    checks: {
      thisWeek: { found: weeks[0].found >= PILOT_TARGETS.foundPerWeek, quotes: weeks[0].quoted >= PILOT_TARGETS.quotesPerWeek },
      weeksMet: {
        found: full.filter(w => w.found >= PILOT_TARGETS.foundPerWeek).length,
        quotes: full.filter(w => w.quoted >= PILOT_TARGETS.quotesPerWeek).length,
        of: full.length,
      },
      closeout: closeout.rate == null ? null : closeout.rate >= PILOT_TARGETS.closeoutRate,
      sourceIdentified: bestSource?.basis === 'GROSS_MARGIN',
    },
  }
}

/** One workspace's scorecard over the last `weeks` weeks. Every read is scoped
 *  to the workspace. */
export async function loadPilotScorecard(
  workspaceId: string,
  opts: { now?: Date; weeks?: number } = {},
): Promise<PilotScorecard> {
  const now = opts.now ?? new Date()
  const weeks = Math.max(1, Math.min(SCORECARD_MAX_WEEKS, Math.floor(opts.weeks ?? SCORECARD_DEFAULT_WEEKS)))
  const start = new Date(now.getTime() - weeks * WEEK_MS)

  const [workspace, rows] = await Promise.all([
    prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { createdAt: true, discoveryProfile: { select: { createdAt: true } } },
    }) as Promise<{ createdAt: Date; discoveryProfile: { createdAt: Date } | null } | null>,
    // Everything that could count in the window: found, quoted, decided or
    // closed out in it.
    prisma.opportunity.findMany({
      where: {
        workspaceId,
        OR: [
          { firstSeenAt: { gte: start } },
          { statusChangedAt: { gte: start } },
          { quotes: { some: { submittedAt: { gte: start } } } },
          { opsJobSite: { is: { job: { is: { completedAt: { gte: start } } } } } },
        ],
      },
      orderBy: { firstSeenAt: 'desc' },
      take: MAX_OPPORTUNITIES,
      select: {
        kind: true, status: true, firstSeenAt: true, statusChangedAt: true,
        quotes: { select: { status: true, amountCents: true, submittedAt: true, createdAt: true } },
        opsJobSite: { select: { job: { select: { status: true, invoicedRevenueCents: true, completedAt: true, closeout: true } } } },
      },
    }) as Promise<Array<Omit<ScorecardOpportunity, 'job'> & { opsJobSite: { job: ScorecardJob | null } | null }>>,
  ])

  return buildPilotScorecard({
    now,
    weeks,
    since: workspace?.discoveryProfile?.createdAt ?? workspace?.createdAt ?? null,
    findWorkSetUp: workspace?.discoveryProfile != null,
    opportunities: rows.map(({ opsJobSite, ...o }) => ({ ...o, job: opsJobSite?.job ?? null })),
  })
}
