// The pilot scorecard's arithmetic: weekly buckets, what counts as found,
// pursued, quoted and won, close-out, pooled margin and the best source.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPilotScorecard, PILOT_TARGETS, type ScorecardOpportunity, type ScorecardQuote, type ScorecardJob } from '../packages/backend-core/src/lib/pilotScorecard.ts'

const NOW = new Date('2026-10-06T12:00:00Z')
const DAY = 86_400_000
const ago = (days: number) => new Date(NOW.getTime() - days * DAY)

function opp(o: Partial<ScorecardOpportunity> = {}): ScorecardOpportunity {
  return { kind: 'DEVELOPMENT_APPLICATION', status: 'NEW', firstSeenAt: ago(1), statusChangedAt: null, quotes: [], job: null, ...o }
}
function quote(q: Partial<ScorecardQuote> = {}): ScorecardQuote {
  return { status: 'SUBMITTED', amountCents: 1_000_000, submittedAt: ago(1), createdAt: ago(1), ...q }
}
function closedJob(revenueCents: number, grossMarginCents: number | null, completedDaysAgo = 1, invoiced = true): ScorecardJob {
  return {
    status: 'COMPLETE', invoicedRevenueCents: invoiced ? revenueCents : null, completedAt: ago(completedDaysAgo),
    closeout: { marginBasis: grossMarginCents == null ? 'LABOUR' : 'GROSS', grossMarginCents, revenueCents },
  }
}
const build = (opportunities: ScorecardOpportunity[], extra: { weeks?: number; since?: Date | null } = {}) =>
  buildPilotScorecard({ now: NOW, weeks: extra.weeks ?? 4, since: extra.since ?? null, findWorkSetUp: true, opportunities })

test('work is bucketed into rolling 7-day weeks ending now, newest first', () => {
  const sc = build([opp({ firstSeenAt: ago(1) }), opp({ firstSeenAt: ago(6.9) }), opp({ firstSeenAt: ago(7.1) }), opp({ firstSeenAt: ago(40) })])
  assert.equal(sc.weeks.length, 4)
  assert.equal(sc.weeks[0].end, NOW.toISOString())
  assert.deepEqual(sc.weeks.map(w => w.found), [2, 1, 0, 0])
  assert.equal(sc.totals.found, 3) // the 40-day-old one is outside the 4-week window
})

test('worth pursuing counts the week’s found work that was pursued, quoted, won or lost', () => {
  const sc = build([
    opp({ status: 'PURSUING' }),
    opp({ status: 'NEW', quotes: [quote()] }), // quoted without being marked pursuing
    opp({ status: 'LOST' }),
    opp({ status: 'DISMISSED' }),
    opp({ status: 'NEW' }),
  ])
  assert.equal(sc.weeks[0].found, 5)
  assert.equal(sc.weeks[0].pursued, 3)
})

test('quoted work counts once, in the week of its first submitted quote, at its latest live price', () => {
  const revised = opp({
    firstSeenAt: ago(20),
    quotes: [
      quote({ status: 'WITHDRAWN', amountCents: 5_000_000, submittedAt: ago(10), createdAt: ago(10) }),
      quote({ status: 'SUBMITTED', amountCents: 4_200_000, submittedAt: ago(2), createdAt: ago(2) }),
    ],
  })
  const draftOnly = opp({ quotes: [quote({ status: 'DRAFT', submittedAt: null })] })
  const sc = build([revised, draftOnly])
  assert.deepEqual(sc.weeks.map(w => w.quoted), [0, 1, 0, 0])
  assert.equal(sc.weeks[1].quotedCents, 4_200_000)
  assert.equal(sc.totals.quoted, 1)
})

test('wins count in the week they were marked won, at the accepted quote; a win without one has no amount', () => {
  const sc = build([
    opp({ status: 'WON', statusChangedAt: ago(2), quotes: [quote({ status: 'ACCEPTED', amountCents: 1_850_000 })] }),
    opp({ status: 'WON', statusChangedAt: ago(3) }),
    opp({ status: 'LOST', statusChangedAt: ago(3), quotes: [quote({ status: 'REJECTED' })] }),
  ])
  assert.equal(sc.weeks[0].won, 2)
  assert.equal(sc.weeks[0].wonCents, 1_850_000)
  assert.equal(sc.weeks[0].wonWithoutAmount, 1)
})

test('conversions: found → quoted over the found cohort, quote → won over everything quoted', () => {
  const sc = build([
    opp({ quotes: [quote({ status: 'ACCEPTED' })], status: 'WON', statusChangedAt: ago(1) }),
    opp({ quotes: [quote({ status: 'REJECTED' })], status: 'LOST', statusChangedAt: ago(1) }),
    opp({ quotes: [quote({ status: 'SUBMITTED' })] }),
    opp(),
  ])
  assert.deepEqual(sc.conversion.discoveryToQuote, { found: 4, quoted: 3, rate: 0.75 })
  assert.deepEqual(sc.conversion.quoteToWon, { quoted: 3, won: 1, lost: 1, awaiting: 1, rate: 0.333 })
})

test('close-out: won work whose job is complete with an invoice; cancelled jobs are left out', () => {
  const won = (job: ScorecardJob | null) => opp({ status: 'WON', statusChangedAt: ago(10), job })
  const sc = build([
    won(closedJob(4_200_000, 1_300_000)),
    won({ status: 'COMPLETE', invoicedRevenueCents: null, completedAt: ago(1), closeout: {} }),
    won({ status: 'ACTIVE', invoicedRevenueCents: null, completedAt: null, closeout: null }),
    won(null),
    won({ status: 'CANCELLED', invoicedRevenueCents: null, completedAt: null, closeout: null }),
  ])
  assert.deepEqual(sc.closeout, { won: 5, closedOut: 1, closedWithoutInvoice: 1, inProgress: 1, notStarted: 1, cancelled: 1, rate: 0.25 })
  assert.equal(sc.checks.closeout, false)
})

test('margin pools the gross margin of jobs closed in the window; labour-only jobs are unknown, not zero', () => {
  const sc = build([
    opp({ status: 'WON', statusChangedAt: ago(20), job: closedJob(4_000_000, 1_200_000) }),
    opp({ status: 'WON', statusChangedAt: ago(20), job: closedJob(1_000_000, 300_000) }),
    opp({ status: 'WON', statusChangedAt: ago(20), job: closedJob(2_000_000, null) }),
    opp({ status: 'WON', statusChangedAt: ago(20), job: closedJob(9_000_000, 9_000_000, 60) }), // closed before the window
  ])
  assert.deepEqual(sc.margin, { closedJobs: 3, grossMarginJobs: 2, grossMarginCents: 1_500_000, revenueCents: 5_000_000, grossMarginPct: 30 })
})

test('best source: most gross margin once known, else most won value; identified only on margin', () => {
  const byValue = build([
    opp({ kind: 'CONTRACT_AWARD', status: 'WON', statusChangedAt: ago(2), quotes: [quote({ status: 'ACCEPTED', amountCents: 9_000_000 })] }),
    opp({ kind: 'DEVELOPMENT_APPLICATION', status: 'WON', statusChangedAt: ago(2), quotes: [quote({ status: 'ACCEPTED', amountCents: 2_000_000 })] }),
  ])
  assert.equal(byValue.bestSource?.kind, 'CONTRACT_AWARD')
  assert.equal(byValue.bestSource?.basis, 'WON_VALUE')
  assert.equal(byValue.checks.sourceIdentified, false)

  const byMargin = build([
    opp({ kind: 'CONTRACT_AWARD', status: 'WON', statusChangedAt: ago(9), job: closedJob(9_000_000, 900_000) }),
    opp({ kind: 'DEVELOPMENT_APPLICATION', status: 'WON', statusChangedAt: ago(9), job: closedJob(4_000_000, 1_600_000) }),
  ])
  assert.deepEqual(byMargin.bestSource, { kind: 'DEVELOPMENT_APPLICATION', label: 'Development applications', basis: 'GROSS_MARGIN', cents: 1_600_000, jobs: 1 })
  assert.equal(byMargin.checks.sourceIdentified, true)
  const da = byMargin.sources.find(s => s.kind === 'DEVELOPMENT_APPLICATION')!
  assert.equal(da.grossMarginPct, 40)
})

test('targets: this week and full weeks on target; a week before Find work was set up is not shown', () => {
  const found = (days: number) => opp({ firstSeenAt: ago(days) })
  const quoted = (days: number) => opp({ firstSeenAt: ago(days), quotes: [quote({ submittedAt: ago(days) })] })
  const sc = build([found(1), found(2), quoted(3), quoted(4), found(8), quoted(9)], { weeks: 13, since: ago(10) })
  assert.equal(sc.weeks.length, 2) // the week before set-up ended before it: not shown
  assert.equal(sc.weeks[1].partial, true)
  assert.deepEqual(sc.checks.thisWeek, { found: true, quotes: true })
  assert.deepEqual(sc.checks.weeksMet, { found: 1, quotes: 1, of: 1 }) // the part week doesn't count
  assert.deepEqual(sc.targets, PILOT_TARGETS)
})

test('an empty workspace still has a week, with nothing met and nothing identified', () => {
  const sc = build([], { weeks: 13, since: NOW })
  assert.equal(sc.weeks.length, 1)
  assert.equal(sc.weeks[0].found, 0)
  assert.equal(sc.closeout.rate, null)
  assert.equal(sc.checks.closeout, null)
  assert.equal(sc.bestSource, null)
  assert.deepEqual(sc.sources, [])
})
