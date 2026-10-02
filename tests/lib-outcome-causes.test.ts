import test from 'node:test'
import assert from 'node:assert/strict'
import { buildOutcomeChain, type OutcomeSend } from '../packages/backend-core/src/lib/outcomeGraph.ts'
import {
  attributeCause, buildCauseFindings, buildCauseProposal, summarizeCauses, MIN_CAUSE_SHARE, STALL_DAYS,
  type CauseContext, type CausedOpportunity,
} from '../packages/backend-core/src/lib/outcomeCauses.ts'

const DAY = 86_400_000
const T0 = Date.parse('2026-09-01T00:00:00Z')
const at = (d: number) => new Date(T0 + d * DAY)
const NOW = T0 + 60 * DAY
const intents = [{ id: 'i1', status: 'SENT', createdAt: at(1), approvedAt: at(2) }]
const send = (over: Partial<OutcomeSend> = {}): OutcomeSend => ({
  id: 's1', outreachIntentId: 'i1', status: 'SENT', sentAt: at(3), repliedAt: null, replyIntent: null, replyIsAutoReply: null, ...over,
})
const ctx = (over: Partial<CauseContext> = {}): CauseContext => ({
  eventStatus: 'ACTIVE', intelligenceGate: true, buyingStage: 'ACTIVE_REQUIREMENT', competition: 30, contactability: 80,
  newestEvidenceAt: at(0).toISOString(), sends: [send()], draftGrounded: true, ...over,
})
function chain(opts: { status?: string; sends?: OutcomeSend[]; outcomes?: Array<{ stage: string; day: number }> } = {}) {
  return buildOutcomeChain({
    opportunity: { id: 'o1', status: opts.status ?? 'OPEN', statusChangedAt: at(40), firstDetectedAt: at(0) },
    intents,
    sends: opts.sends ?? [send()],
    outcomes: (opts.outcomes ?? []).map((o, i) => ({ id: `r${i}`, stage: o.stage, recordedAt: at(o.day), dealValue: null })),
  })
}

test('won and still-open (not yet stalled) chains have no cause', () => {
  assert.equal(attributeCause(chain({ outcomes: [{ stage: 'WON', day: 20 }] }), ctx(), NOW), null)
  assert.equal(attributeCause(chain(), ctx(), T0 + (3 + STALL_DAYS - 1) * DAY), null, 'inside the stall window')
  assert.equal(attributeCause(chain({ sends: [] }), ctx({ sends: [] }), NOW), null, 'never sent, never closed')
  const replied = chain({ sends: [send({ status: 'REPLIED', repliedAt: at(5), replyIntent: 'INTERESTED' })] })
  assert.equal(attributeCause(replied, ctx({ sends: [send({ repliedAt: at(5), replyIntent: 'INTERESTED' })] }), NOW), null, 'responded, still open')
})

test('each cause, in precedence order', () => {
  const lostAfterQuote = attributeCause(chain({ status: 'LOST', outcomes: [{ stage: 'PROPOSAL', day: 10 }] }), ctx(), NOW)
  assert.deepEqual([lostAfterQuote?.cause, lostAfterQuote?.basis], ['LOST_TO_COMPETITOR', 'CLOSED'])
  assert.equal(attributeCause(chain({ status: 'LOST' }), ctx({ competition: 70 }), NOW)?.cause, 'LOST_TO_COMPETITOR')

  const bounced = [send({ status: 'BOUNCED' })]
  assert.equal(attributeCause(chain({ status: 'LOST' }), ctx({ sends: bounced }), NOW)?.cause, 'WRONG_CONTACT')
  const referral = [send({ repliedAt: at(5), replyIntent: 'REFERRAL' })]
  assert.equal(attributeCause(chain({ status: 'LOST' }), ctx({ sends: referral }), NOW)?.cause, 'WRONG_CONTACT')

  // An explicit "not now" outranks a stale signal.
  const notNow = [send({ repliedAt: at(5), replyIntent: 'NOT_NOW' })]
  assert.equal(attributeCause(chain({ status: 'LOST' }), ctx({ sends: notNow, eventStatus: 'STALE' }), NOW)?.cause, 'WRONG_TIMING')

  const stale = attributeCause(chain(), ctx({ eventStatus: 'STALE' }), NOW)
  assert.deepEqual([stale?.cause, stale?.basis], ['WRONG_SIGNAL', 'STALLED'])
  assert.equal(attributeCause(chain(), ctx({ intelligenceGate: false }), NOW)?.cause, 'WRONG_SIGNAL')
  assert.equal(attributeCause(chain(), ctx({ contactability: 20 }), NOW)?.cause, 'WRONG_CONTACT')

  assert.equal(attributeCause(chain(), ctx({ buyingStage: 'PROBLEM_LIKELY' }), NOW)?.cause, 'WRONG_TIMING')
  const old = attributeCause(chain(), ctx({ newestEvidenceAt: at(-40).toISOString() }), NOW)
  assert.equal(old?.cause, 'WRONG_TIMING')
  assert.match(old?.reasons[0] ?? '', /43 days old/)

  assert.equal(attributeCause(chain(), ctx({ draftGrounded: false }), NOW)?.cause, 'BAD_MESSAGE')
  const notInterested = [send({ repliedAt: at(5), replyIntent: 'NOT_INTERESTED' })]
  assert.equal(attributeCause(chain({ status: 'LOST', sends: notInterested }), ctx({ sends: notInterested }), NOW)?.cause, 'BAD_MESSAGE')
  const silent = attributeCause(chain(), ctx(), NOW)
  assert.deepEqual([silent?.cause, silent?.basis], ['BAD_MESSAGE', 'STALLED'])

  // Auto-replies don't count as a reply.
  const ooo = [send({ repliedAt: at(5), replyIntent: 'NOT_NOW', replyIsAutoReply: true })]
  assert.equal(attributeCause(chain(), ctx({ sends: ooo }), NOW)?.cause, 'BAD_MESSAGE')

  const lostUnsent = attributeCause(chain({ status: 'LOST', sends: [] }), ctx({ sends: [] }), NOW)
  assert.deepEqual([lostUnsent?.cause, lostUnsent?.confidence], ['UNKNOWN', 20])
})

const item = (id: string, cause: CausedOpportunity['cause'], eventType = 'HIRING_SURGE', offerKey = 'offer:a', buyingStage = 'ACTIVE_REQUIREMENT'): CausedOpportunity =>
  ({ opportunityId: id, cause, eventType, offerKey, buyingStage })

test('summary counts causes overall and per event, offer and stage', () => {
  const s = summarizeCauses([item('1', 'WRONG_TIMING'), item('2', 'WRONG_TIMING', 'NEW_PROJECT'), item('3', 'UNKNOWN', 'NEW_PROJECT', 'offer:b')])
  assert.equal(s.total, 3)
  assert.equal(s.byCause.WRONG_TIMING, 2)
  assert.equal(s.byCause.UNKNOWN, 1)
  const offerA = s.groups.find(g => g.dimension === 'offerKey' && g.value === 'offer:a')
  assert.deepEqual([offerA?.total, offerA?.byCause], [2, { WRONG_TIMING: 2 }])
  assert.deepEqual([s.groups[0].dimension, s.groups[0].total], ['buyingStage', 3], 'largest groups first')
})

test('findings: one per group whose dominant cause clears the sample and share bars; never UNKNOWN', () => {
  const items = [
    ...['1', '2', '3'].map(id => item(id, 'WRONG_TIMING')),
    item('4', 'BAD_MESSAGE'),
    ...['5', '6', '7', '8'].map(id => item(id, 'UNKNOWN', 'NEW_PROJECT', 'offer:b', 'PROBLEM_LIKELY')),
  ]
  const findings = buildCauseFindings(items, 4)
  assert.deepEqual(findings.map(f => `${f.dimension}:${f.value}:${f.cause}`).sort(), ['buyingStage:ACTIVE_REQUIREMENT:WRONG_TIMING', 'eventType:HIRING_SURGE:WRONG_TIMING', 'offerKey:offer:a:WRONG_TIMING'])
  const f = findings.find(x => x.dimension === 'eventType')!
  assert.deepEqual([f.total, f.causeCount, f.share], [4, 3, 0.75])
  assert.deepEqual(f.examples, ['1', '2', '3'])
  assert.match(f.basis, /3 of 4 closed or stalled opportunities for event HIRING_SURGE/)
  assert.match(f.advice, /active requirement/)

  assert.deepEqual(buildCauseFindings(items, 5), [], 'below the minimum sample nothing is found')
  // A split with no cause reaching the share bar finds nothing.
  const split = ['WRONG_TIMING', 'BAD_MESSAGE', 'WRONG_SIGNAL', 'WRONG_CONTACT', 'UNKNOWN'] as const
  assert.ok(1 / split.length < MIN_CAUSE_SHARE)
  assert.deepEqual(buildCauseFindings(split.map((c, i) => item(String(i), c)), 5), [])
})

test('the proposal: one advisory review holding every finding; stats in evidence, not in the proposed value', () => {
  const items = [...['1', '2', '3'].map(id => item(id, 'WRONG_TIMING')), item('4', 'BAD_MESSAGE')]
  const p = buildCauseProposal(items, 4)!
  assert.equal(p.type, 'OPPORTUNITY_CAUSE')
  assert.equal(p.currentValue, null)
  assert.equal(p.sampleSize, 4)
  assert.equal(p.proposedValue.findings.length, 3)
  assert.deepEqual(Object.keys(p.proposedValue.findings[0]).sort(), ['advice', 'cause', 'dimension', 'value'])
  assert.equal(p.evidence.attributed, 4)
  assert.equal(p.evidence.byCause.WRONG_TIMING, 3)
  assert.match(p.evidence.basis, /^3 repeated causes across 4/)
  assert.match(buildCauseProposal(items.slice(0, 3), 3)!.evidence.basis, /^3 repeated causes across 3/)
  assert.equal(buildCauseProposal(items, 5), null)
})
