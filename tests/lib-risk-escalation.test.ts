// Unit tests for deterministic reply/enquiry risk escalation (pure).

import test from 'node:test'
import assert from 'node:assert/strict'
import { assessRisk, parseRiskFlags } from '../packages/backend-core/src/lib/riskEscalation.ts'

test('flags each risk category on unambiguous phrasing', () => {
  const cases: Array<[string, string]> = [
    ['I have spoken to my lawyer about this', 'LEGAL'],
    ["We'll take you to NCAT if this isn't fixed", 'LEGAL'],
    ['I am going to sue', 'LEGAL'],
    ['I want a refund for the call-out fee', 'PAYMENT_DISPUTE'],
    ['You charged me twice for the same job', 'PAYMENT_DISPUTE'],
    ['We dispute the invoice you sent', 'PAYMENT_DISPUTE'],
    ['I will be lodging a formal complaint with Fair Trading', 'COMPLAINT'],
    ['Your plumber caused a leak in the ceiling', 'DAMAGE_CLAIM'],
    ['your guys damaged the driveway', 'DAMAGE_CLAIM'],
    ['I think our account was compromised after your email', 'DATA_BREACH'],
  ]
  for (const [text, flag] of cases) {
    const r = assessRisk(text)
    assert.ok(r.flags.includes(flag as never), `${flag} expected for: ${text} (got ${r.flags.join(',')})`)
    assert.equal(r.escalate, true)
  }
})

test('does not flag ordinary trade work that shares the vocabulary', () => {
  for (const text of [
    'Can you quote for a security camera install at our office?',
    'Need the tennis court resurfaced before summer',
    'Looking for someone to repair water damage in the bathroom',
    'Hi, Sue here — are you free Thursday to look at the switchboard?',
    'We sat down and decided to go ahead with the quote',
    'Interested, send me some times next week',
    'The court date for the netball court line marking is flexible',
  ]) {
    assert.deepEqual(assessRisk(text), { flags: [], escalate: false }, text)
  }
})

test('empty or missing text never escalates', () => {
  assert.deepEqual(assessRisk(''), { flags: [], escalate: false })
  assert.deepEqual(assessRisk(null), { flags: [], escalate: false })
})

test('parseRiskFlags keeps only recognised flags', () => {
  assert.deepEqual(parseRiskFlags(['LEGAL', 'nonsense', 'COMPLAINT']), ['LEGAL', 'COMPLAINT'])
  assert.deepEqual(parseRiskFlags(null), [])
})
