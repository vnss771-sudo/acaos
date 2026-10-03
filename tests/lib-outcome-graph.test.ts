import test from 'node:test'
import assert from 'node:assert/strict'
import { buildOutcomeChain, summarizeOutcomes, type OutcomeSend } from '../packages/backend-core/src/lib/outcomeGraph.ts'

const T0 = Date.parse('2026-09-01T00:00:00Z')
const at = (days: number) => new Date(T0 + days * 86_400_000)
const opportunity = { id: 'opp1', status: 'OPEN', statusChangedAt: null, firstDetectedAt: at(0), eventTitle: 'Capacity expansion' }
const recommendation = { id: 'rec1', createdAt: at(0), actionText: 'Contact now' }
const intents = [{ id: 'i1', status: 'SENT', createdAt: at(1), approvedAt: at(2) }]
const send = (over: Partial<OutcomeSend> = {}): OutcomeSend => ({
  id: 's1', outreachIntentId: 'i1', status: 'SENT', sentAt: at(3), repliedAt: null, replyIntent: null, replyIsAutoReply: null, ...over,
})

test('full chain: recommendation → intent → send → reply → meeting → quote → won, with revenue', () => {
  const c = buildOutcomeChain({
    opportunity, recommendation, intents,
    sends: [send({ status: 'REPLIED', repliedAt: at(5), replyIntent: 'INTERESTED' })],
    outcomes: [
      { id: 'o1', stage: 'MEETING', recordedAt: at(8), dealValue: null },
      { id: 'o2', stage: 'PROPOSAL', recordedAt: at(12), dealValue: 5_000_000 },
      { id: 'o3', stage: 'WON', recordedAt: at(20), dealValue: 6_000_000 },
    ],
  })
  assert.deepEqual(c.nodes.map(n => n.stage), ['DETECTED', 'RECOMMENDED', 'PROPOSED', 'APPROVED', 'SENT', 'REPLIED', 'MEETING', 'QUOTED', 'WON'])
  assert.equal(c.final, 'WON')
  assert.equal(c.furthest, 'WON')
  assert.equal(c.revenueCents, 6_000_000)
  assert.equal(c.attribution, 'SOURCED')
  assert.equal(c.daysToOutcome, 20)
  assert.deepEqual(c.nodes.find(n => n.stage === 'REPLIED')?.ref, { type: 'outreachSent', id: 's1' })
  assert.equal(c.nodes.find(n => n.stage === 'REPLIED')?.detail, 'INTERESTED')
})

test('only this opportunity\'s sent outreach counts; auto-replies and failed sends do not', () => {
  const c = buildOutcomeChain({
    opportunity, recommendation, intents,
    sends: [
      send({ id: 'other', outreachIntentId: 'someone-else', sentAt: at(1) }),
      send({ id: 'unstamped', outreachIntentId: null, sentAt: at(1) }),
      send({ id: 'failed', status: 'FAILED', sentAt: at(2) }),
      send({ id: 's1', repliedAt: at(4), replyIsAutoReply: true }),
    ],
  })
  assert.deepEqual(c.nodes.map(n => n.stage), ['DETECTED', 'RECOMMENDED', 'PROPOSED', 'APPROVED', 'SENT'])
  assert.equal(c.nodes.find(n => n.stage === 'SENT')?.ref.id, 's1')
  assert.equal(c.furthest, 'SENT')
  assert.equal(c.final, null)
  assert.equal(c.attribution, 'NONE')
  assert.equal(c.daysToOutcome, null)
})

test('an outcome with no ACAOS send before it is influenced, not sourced; outcomes before detection are ignored', () => {
  const c = buildOutcomeChain({
    opportunity,
    outcomes: [
      { id: 'old', stage: 'WON', recordedAt: at(-30), dealValue: 9_000_000 },
      { id: 'o1', stage: 'MEETING', recordedAt: at(4), dealValue: null },
      { id: 'o2', stage: 'WON', recordedAt: at(9), dealValue: null },
    ],
  })
  assert.deepEqual(c.nodes.map(n => n.stage), ['DETECTED', 'MEETING', 'WON'])
  assert.equal(c.attribution, 'INFLUENCED')
  assert.equal(c.revenueCents, null, 'a win with no recorded value has no revenue')

  // A send after the buyer already moved doesn't make it sourced.
  const late = buildOutcomeChain({ opportunity, intents, sends: [send({ sentAt: at(6) })], outcomes: [{ id: 'o1', stage: 'MEETING', recordedAt: at(4), dealValue: null }] })
  assert.equal(late.attribution, 'INFLUENCED')
})

test('the operator\'s won/lost decision closes the chain; the latest final wins', () => {
  const lost = buildOutcomeChain({ opportunity: { ...opportunity, status: 'LOST', statusChangedAt: at(7) }, intents, sends: [send()] })
  assert.equal(lost.final, 'LOST')
  assert.equal(lost.nodes.at(-1)?.ref.type, 'commercialOpportunity')
  assert.equal(lost.attribution, 'SOURCED')
  assert.equal(lost.revenueCents, null)

  const noDate = buildOutcomeChain({ opportunity: { ...opportunity, status: 'WON', statusChangedAt: null } })
  assert.equal(noDate.final, 'WON')
  assert.equal(noDate.daysToOutcome, 0)

  const reversed = buildOutcomeChain({
    opportunity: { ...opportunity, status: 'WON', statusChangedAt: at(15) },
    outcomes: [{ id: 'o1', stage: 'LOST', recordedAt: at(10), dealValue: null }, { id: 'o2', stage: 'LOST', recordedAt: at(11), dealValue: null }],
  })
  assert.deepEqual(reversed.nodes.map(n => n.stage), ['DETECTED', 'LOST', 'WON'])
  assert.equal(reversed.final, 'WON')
})

test('summary: funnel, implied stages, conversion and attributed revenue', () => {
  const won = buildOutcomeChain({
    opportunity, recommendation, intents,
    sends: [send({ repliedAt: at(5) })],
    outcomes: [{ id: 'o1', stage: 'WON', recordedAt: at(20), dealValue: 6_000_000 }],
  })
  const influenced = buildOutcomeChain({ opportunity: { ...opportunity, id: 'opp2' }, outcomes: [{ id: 'o2', stage: 'WON', recordedAt: at(3), dealValue: 1_000_000 }] })
  const lostAfterReply = buildOutcomeChain({ opportunity: { ...opportunity, id: 'opp3', status: 'LOST', statusChangedAt: at(9) }, intents, sends: [send({ repliedAt: at(5) })] })
  const quiet = buildOutcomeChain({ opportunity: { ...opportunity, id: 'opp4' } })

  const s = summarizeOutcomes([won, influenced, lostAfterReply, quiet])
  assert.equal(s.opportunities, 4)
  assert.equal(s.reached.DETECTED, 4)
  assert.equal(s.reached.SENT, 2)
  assert.equal(s.reached.REPLIED, 3, 'the influenced win implies a reply')
  assert.equal(s.reached.MEETING, 2, 'wins imply a meeting; a loss implies nothing')
  assert.equal(s.reached.QUOTED, 2)
  assert.equal(s.reached.WON, 2)
  assert.equal(s.reached.LOST, 1)
  assert.deepEqual(s.conversion, { detectedToSent: 0.5, sentToReplied: 1, repliedToMeeting: 0.667, meetingToQuoted: 1, quotedToWon: 1 })
  assert.deepEqual(s.wonRevenueCents, { sourced: 6_000_000, influenced: 1_000_000 })
  assert.deepEqual(s.attribution, { SOURCED: 2, INFLUENCED: 1, NONE: 1 })

  const empty = summarizeOutcomes([])
  assert.equal(empty.conversion.detectedToSent, null)
})

test('quotes on the opportunity are authoritative: prospect-level PROPOSAL/WON are ignored, meetings kept', () => {
  const c = buildOutcomeChain({
    opportunity: { ...opportunity, status: 'WON', statusChangedAt: at(15) }, intents, sends: [send()],
    outcomes: [
      { id: 'o1', stage: 'MEETING', recordedAt: at(8), dealValue: null },
      // A win on ANOTHER of this prospect's opportunities — must not count here.
      { id: 'o2', stage: 'WON', recordedAt: at(9), dealValue: 9_999_999 },
    ],
    quotes: [
      { id: 'q1', status: 'REJECTED', amountCents: 5_000_000, createdAt: at(10), submittedAt: at(10), decidedAt: at(12) },
      { id: 'q2', status: 'ACCEPTED', amountCents: 4_500_000, createdAt: at(13), submittedAt: at(13), decidedAt: at(15) },
    ],
  })
  assert.deepEqual(c.nodes.map(n => n.stage), ['DETECTED', 'PROPOSED', 'APPROVED', 'SENT', 'MEETING', 'QUOTED', 'WON'])
  assert.equal(c.revenueCents, 4_500_000)
  assert.deepEqual(c.nodes.find(n => n.stage === 'QUOTED')?.ref, { type: 'quote', id: 'q1' })
  assert.deepEqual(c.nodes.find(n => n.stage === 'WON')?.ref, { type: 'quote', id: 'q2' })
  assert.equal(c.daysToOutcome, 15)
})
