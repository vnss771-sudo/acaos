import type { PilotScorecard, ScorecardWeek } from '../lib/scorecard.js'

// A pilot scorecard as the API returns it: a good week (7 found, 3 worth
// pursuing, 2 quotes for $42,000, 1 win at $18,500) after a quiet one, with a
// closed development-application job that made $12,400 gross margin.

const week = (end: string, w: Partial<ScorecardWeek> = {}): ScorecardWeek => ({
  start: new Date(new Date(end).getTime() - 7 * 86_400_000).toISOString(), end, partial: false,
  found: 0, pursued: 0, quoted: 0, quotedCents: 0, won: 0, wonCents: 0, wonWithoutAmount: 0, ...w,
})

export function makeScorecard(overrides: Partial<PilotScorecard> = {}): PilotScorecard {
  return {
    generatedAt: '2026-10-06T12:00:00.000Z',
    findWorkSetUp: true,
    window: { start: '2026-09-22T12:00:00.000Z', end: '2026-10-06T12:00:00.000Z', weeks: 2 },
    targets: { foundPerWeek: 3, quotesPerWeek: 2, closeoutRate: 0.8 },
    weeks: [
      week('2026-10-06T12:00:00.000Z', { found: 7, pursued: 3, quoted: 2, quotedCents: 4_200_000, won: 1, wonCents: 1_850_000 }),
      week('2026-09-29T12:00:00.000Z', { found: 2, pursued: 1, quoted: 1, quotedCents: 900_000 }),
    ],
    totals: { found: 9, pursued: 4, quoted: 3, quotedCents: 5_100_000, won: 1, wonCents: 1_850_000, wonWithoutAmount: 0 },
    conversion: {
      discoveryToQuote: { found: 9, quoted: 3, rate: 0.333 },
      quoteToWon: { quoted: 3, won: 1, lost: 1, awaiting: 1, rate: 0.5 },
    },
    closeout: { won: 2, closedOut: 1, closedWithoutInvoice: 0, inProgress: 1, notStarted: 0, cancelled: 0, rate: 0.5 },
    margin: { closedJobs: 1, grossMarginJobs: 1, grossMarginCents: 1_240_000, revenueCents: 4_000_000, grossMarginPct: 31 },
    sources: [
      { kind: 'DEVELOPMENT_APPLICATION', label: 'Development applications', found: 6, quoted: 2, won: 1, wonCents: 1_850_000, closedJobs: 1, grossMarginJobs: 1, grossMarginCents: 1_240_000, grossMarginPct: 31 },
      { kind: 'CONTRACT_AWARD', label: 'Contract awards', found: 3, quoted: 1, won: 0, wonCents: 0, closedJobs: 0, grossMarginJobs: 0, grossMarginCents: null, grossMarginPct: null },
    ],
    bestSource: { kind: 'DEVELOPMENT_APPLICATION', label: 'Development applications', basis: 'GROSS_MARGIN', cents: 1_240_000, jobs: 1 },
    checks: { thisWeek: { found: true, quotes: true }, weeksMet: { found: 1, quotes: 1, of: 2 }, closeout: false, sourceIdentified: true },
    ...overrides,
  }
}
