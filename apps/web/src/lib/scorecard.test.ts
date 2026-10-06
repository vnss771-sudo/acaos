import { describe, test, expect } from 'vitest'
import { insightText, marginText, thisWeekItems, windowText } from './scorecard.js'
import { makeScorecard } from '../test/scorecardFixture.js'

describe('scorecard lines', () => {
  test('this week reads as the pilot customer would say it', () => {
    expect(thisWeekItems(makeScorecard())).toEqual(['7 found', '3 worth pursuing', '2 quotes ($42,000)', '1 won ($18,500)'])
  })

  test('the window is the pilot weeks, or since Find work was set up when that is newer', () => {
    const sc = makeScorecard()
    expect(windowText(sc)).toBe('in the last 2 weeks')
    expect(windowText({ ...sc, weeks: [sc.weeks[0], { ...sc.weeks[1], partial: true }] })).toBe('since you set up Find work')
  })

  test('margin says what it rests on, and unknown is never zero', () => {
    const sc = makeScorecard()
    expect(marginText(sc)).toBe('31% gross margin (1 closed job)')
    expect(marginText({ ...sc, margin: { closedJobs: 2, grossMarginJobs: 0, grossMarginCents: null, revenueCents: null, grossMarginPct: null } }))
      .toBe('Gross margin unknown (costs not entered)')
    expect(marginText({ ...sc, margin: { closedJobs: 0, grossMarginJobs: 0, grossMarginCents: null, revenueCents: null, grossMarginPct: null } }))
      .toBe('No closed jobs yet')
  })

  test('the insight names the source that made the most money, and only advises with a comparison', () => {
    const sc = makeScorecard()
    expect(insightText(sc)).toBe('You made the most money from development applications in the last 2 weeks: $12,400 gross margin from 1 closed job.')
    const compared = makeScorecard({
      sources: [...sc.sources.slice(0, 1), { ...sc.sources[1], closedJobs: 1, grossMarginJobs: 1, grossMarginCents: 200_000, grossMarginPct: 10 }],
    })
    expect(insightText(compared)).toMatch(/Consider pursuing more of this work\.$/)
  })

  test('before any margin, the insight points at won value and asks for closeouts', () => {
    const sc = makeScorecard({ bestSource: { kind: 'CONTRACT_AWARD', label: 'Contract awards', basis: 'WON_VALUE', cents: 9_000_000, jobs: 2 } })
    expect(insightText(sc)).toBe('Most of the work you won by value came from contract awards ($90,000). Close out finished jobs with their costs to see which source makes the most money.')
    expect(insightText(makeScorecard({ bestSource: null }))).toBeNull()
  })
})
