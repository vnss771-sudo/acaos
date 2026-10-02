import test from 'node:test'
import assert from 'node:assert/strict'
import {
  checkDraftGrounding, factsFromCitations, groundedSummary, initialGrounding, specifics,
} from '../packages/backend-core/src/lib/draftGrounding.ts'
import { buildIntentDraftInput } from '../packages/backend-core/src/lib/outreachIntent.ts'

const NOW = Date.parse('2026-10-01T00:00:00Z')
const facts = factsFromCitations([
  { signalId: 's1', claim: '$4.2M project awarded for the Logan depot', source: 'tenders.example.gov', sourceUrl: 'https://tenders.example.gov/1', eventDate: '2026-09-22T00:00:00Z', ageDays: 9, quality: 88.4 },
  { signalId: 's2', claim: 'Hiring 17 field technicians', source: 'jobs.example.com', sourceUrl: null, eventDate: '2026-09-28T00:00:00Z', ageDays: 3, quality: 140 },
])
const record = initialGrounding(facts, ['Temporary field crews', 'Crewed a 40-person shutdown in 10 days', ' '])

test('facts carry claim → evidence → source → confidence', () => {
  assert.deepEqual(facts.map(f => [f.id, f.signalId, f.source, f.confidence]), [['F1', 's1', 'tenders.example.gov', 88], ['F2', 's2', 'jobs.example.com', 100]])
  assert.deepEqual(record.context, ['Temporary field crews', 'Crewed a 40-person shutdown in 10 days'])
  assert.equal(record.grounded, null)
  const summary = groundedSummary(facts)
  assert.match(summary, /^Verified facts/)
  assert.match(summary, /F1\. \$4\.2M project awarded for the Logan depot \(tenders\.example\.gov, 9 days ago\)/)
  assert.match(groundedSummary(factsFromCitations([{ ...facts[0], quality: 50, ageDays: 0 }, { ...facts[1], quality: 50, ageDays: 1 }])), /today[\s\S]*1 day ago/)
})

test('specifics normalises amounts, percentages and plain numbers', () => {
  assert.deepEqual(specifics('$4.2M, 4.2 million, 18 percent, 18%, 1,200 staff, 3k'), ['4.2m', '18%', '1200', '3k'])
  assert.deepEqual(specifics('no numbers here'), [])
})

test('a draft that states only evidenced specifics, and uses a fact, is grounded', () => {
  const g = checkDraftGrounding(
    { subject: 'crews for Logan', body: 'Saw the $4.2M Logan depot project was awarded and you are hiring 17 technicians. We crewed a 40-person shutdown in 10 days — worth a chat?' },
    record, { now: NOW },
  )
  assert.equal(g.grounded, true, g.problems.join('; '))
  assert.deepEqual(g.problems, [])
  assert.deepEqual(g.claims.map(c => c.factId), ['F1', 'F2'])
  assert.equal(g.claims[0].signalId, 's1')
  assert.equal(g.claims[0].confidence, 88)
  assert.ok(g.claims[0].matchedOn.includes('4.2m'))
  assert.equal(g.checkedAt, new Date(NOW).toISOString())
})

test('an invented specific makes the draft ungrounded', () => {
  const g = checkDraftGrounding({ subject: 'Logan depot', body: 'Congrats on the $5M Logan depot project award, and growing 30% this year.', followup: null }, record, { now: NOW })
  assert.equal(g.grounded, false)
  assert.deepEqual(g.problems, ['States "5m" without evidence', 'States "30%" without evidence'])
  // Still records which facts it used.
  assert.deepEqual(g.claims.map(c => c.factId), ['F1'])
})

test('a draft that uses none of the facts is not grounded; seller context is allowed', () => {
  const generic = checkDraftGrounding({ subject: 'quick question', body: 'How are you handling crews this quarter?' }, record, { now: NOW })
  assert.equal(generic.grounded, false)
  assert.deepEqual(generic.problems, ['Uses none of the verified facts'])

  const withContext = checkDraftGrounding(
    { subject: 'field technicians', body: 'Hiring field technicians is slow — we have 25 years in the trade.', followup: 'Following up on the technicians.' },
    record, { now: NOW, extraContext: ['25 years in the trade', null, undefined] },
  )
  assert.equal(withContext.grounded, true, withContext.problems.join('; '))
})

test('buildIntentDraftInput writes from the facts when the intent is grounded', () => {
  const prospect = { companyName: 'ABC Electrical' }
  const recommendation = { reasoning: 'free-text reasoning', messageAngle: 'angle' }
  assert.equal(buildIntentDraftInput({ prospect, recommendation, intent: {} }).aiSummary, 'free-text reasoning')
  assert.equal(buildIntentDraftInput({ prospect, recommendation, intent: {}, grounding: { facts: [] } }).aiSummary, 'free-text reasoning')
  assert.equal(buildIntentDraftInput({ prospect, recommendation, intent: {}, grounding: record }).aiSummary, groundedSummary(facts))
})
