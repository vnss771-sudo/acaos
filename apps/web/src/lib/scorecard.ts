import { formatCents } from './money.js'

// The pilot scorecard as GET /api/delivery/scorecard returns it (see
// packages/backend-core/src/lib/pilotScorecard.ts for the definitions), and the
// plain-language lines Today, the Scorecard tab and the admin panel share.

export type ScorecardWeek = {
  start: string; end: string; partial: boolean
  found: number; pursued: number; quoted: number; quotedCents: number
  won: number; wonCents: number; wonWithoutAmount: number
}

export type ScorecardSource = {
  kind: string; label: string; found: number; quoted: number; won: number; wonCents: number
  closedJobs: number; grossMarginJobs: number; grossMarginCents: number | null; grossMarginPct: number | null
}

export type PilotScorecard = {
  generatedAt: string
  findWorkSetUp: boolean
  window: { start: string; end: string; weeks: number }
  targets: { foundPerWeek: number; quotesPerWeek: number; closeoutRate: number }
  weeks: ScorecardWeek[]
  totals: Omit<ScorecardWeek, 'start' | 'end' | 'partial'>
  conversion: {
    discoveryToQuote: { found: number; quoted: number; rate: number | null }
    quoteToWon: { quoted: number; won: number; lost: number; awaiting: number; rate: number | null }
  }
  closeout: { won: number; closedOut: number; closedWithoutInvoice: number; inProgress: number; notStarted: number; cancelled: number; rate: number | null }
  margin: { closedJobs: number; grossMarginJobs: number; grossMarginCents: number | null; revenueCents: number | null; grossMarginPct: number | null }
  sources: ScorecardSource[]
  bestSource: null | { kind: string; label: string; basis: 'GROSS_MARGIN' | 'WON_VALUE'; cents: number; jobs: number }
  checks: {
    thisWeek: { found: boolean; quotes: boolean }
    weeksMet: { found: number; quotes: number; of: number }
    closeout: boolean | null
    sourceIdentified: boolean
  }
}

export const ratePct = (r: number | null | undefined) => (r == null ? '—' : `${Math.round(r * 100)}%`)
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** "the last 13 weeks", or "since you set up Find work" when it's newer. */
export function windowText(sc: PilotScorecard): string {
  const started = sc.weeks.some(w => w.partial)
  return started ? 'since you set up Find work' : `in the last ${plural(sc.window.weeks, 'week')}`
}

/** The last 7 days in short phrases: "7 found", "3 worth pursuing", … */
export function thisWeekItems(sc: PilotScorecard): string[] {
  const w = sc.weeks[0]
  const items = [`${w.found} found`, `${w.pursued} worth pursuing`, `${plural(w.quoted, 'quote')}`]
  if (w.quoted > 0) items[2] += ` (${formatCents(w.quotedCents)})`
  items.push(`${w.won} won${w.wonCents > 0 ? ` (${formatCents(w.wonCents)})` : ''}`)
  return items
}

/** What the money says, once there is something to say. */
export function insightText(sc: PilotScorecard): string | null {
  const best = sc.bestSource
  if (!best) return null
  const source = best.label.toLowerCase()
  if (best.basis === 'GROSS_MARGIN') {
    const others = sc.sources.filter(s => s.kind !== best.kind && s.grossMarginJobs > 0).length
    return `You made the most money from ${source} ${windowText(sc)}: ${formatCents(best.cents)} gross margin from ${plural(best.jobs, 'closed job')}.`
      + (others > 0 ? ' Consider pursuing more of this work.' : '')
  }
  return `Most of the work you won by value came from ${source} (${formatCents(best.cents)}). `
    + 'Close out finished jobs with their costs to see which source makes the most money.'
}

/** The margin, labelled with what it rests on. */
export function marginText(sc: PilotScorecard): string {
  const m = sc.margin
  if (m.grossMarginPct == null) return m.closedJobs > 0 ? 'Gross margin unknown (costs not entered)' : 'No closed jobs yet'
  return `${m.grossMarginPct}% gross margin (${plural(m.grossMarginJobs, 'closed job')})`
}
