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

// ── Qualitative claims (rapid growth, scale, leadership, recency) ───────────
const fact = (claim: string, ageDays = 5) => factsFromCitations([
  { signalId: 'q1', claim, source: 'news.example.com', sourceUrl: null, eventDate: '2026-09-01T00:00:00Z', ageDays, quality: 80 },
])
const check = (body: string, facts: ReturnType<typeof fact>, context: string[] = []) =>
  checkDraftGrounding({ subject: 'Logan depot crews', body }, initialGrounding(facts, context), { now: NOW })

test('ordinary hiring evidence does not back a "rapidly expanding" claim', () => {
  const g = check('You are hiring field technicians and rapidly expanding across Logan.', fact('Hiring field technicians in Logan'))
  assert.equal(g.grounded, false)
  assert.ok(g.problems.includes('Claims "rapidly expanding" without supporting evidence'), g.problems.join('; '))
})

test('evidence that itself shows fast growth backs a rapid-growth claim', () => {
  const g = check('Your field technicians headcount doubled — rapid growth like that strains crews.', fact('Field technicians headcount doubled this year'))
  assert.equal(g.grounded, true, g.problems.join('; '))
})

test('"recently opened" needs a matching fact no older than 90 days', () => {
  const stale = check('You recently opened the Logan depot for field technicians.', fact('Opened the Logan depot for field technicians', 120))
  assert.ok(stale.problems.includes('Claims "recently opened" without supporting evidence'), stale.problems.join('; '))
  const fresh = check('You recently opened the Logan depot for field technicians.', fact('Opened the Logan depot for field technicians', 30))
  assert.equal(fresh.grounded, true, fresh.problems.join('; '))
  const otherEvent = check('You recently launched the Logan depot for field technicians.', fact('Opened the Logan depot for field technicians', 30))
  assert.ok(otherEvent.problems.some(p => p.includes('recently launched')))
})

test('leadership claims about the buyer need evidence; the seller may repeat its own wording', () => {
  const buyer = check('As the market leader for Logan depot technicians you need crews.', fact('Logan depot hiring field technicians'))
  assert.ok(buyer.problems.includes('Claims "market leader" without supporting evidence'), buyer.problems.join('; '))
  const seller = check('We are a leading supplier of crews for Logan depot technicians.', fact('Logan depot hiring field technicians'), ['A leading supplier of temporary crews'])
  assert.equal(seller.grounded, true, seller.problems.join('; '))
})

test('seller context cannot back a buyer growth or scale claim, and filler is not flagged', () => {
  const g = check('Your major expansion at the Logan depot technicians site needs crews.', fact('Logan depot hiring field technicians'), ['Supported a major expansion for another client'])
  assert.ok(g.problems.includes('Claims "major expansion" without supporting evidence'), g.problems.join('; '))
  const filler = check('Crews for your Logan depot technicians could make a significant difference.', fact('Logan depot hiring field technicians'))
  assert.equal(filler.grounded, true, filler.problems.join('; '))
})
