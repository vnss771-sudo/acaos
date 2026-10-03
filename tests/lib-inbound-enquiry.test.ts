// Unit tests for inbound job-enquiry triage (pure).

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  assessInboundEnquiry, enquiryExcerpt, parseHeaderBlock, redactSensitive, ENQUIRY_EXCERPT_MAX,
  type InboundEmail,
} from '../packages/backend-core/src/lib/inboundEnquiry.ts'

const base = (over: Partial<InboundEmail> = {}): InboundEmail => ({
  fromAddress: 'jo@gmail.com', fromName: 'Jo Smith', subject: '', body: '', headers: {}, ownAddresses: ['office@sparky.com.au'], ...over,
})

test('a person asking for a quote is an enquiry with stated reasons', () => {
  const r = assessInboundEnquiry(base({
    subject: 'Switchboard upgrade quote',
    body: 'Hi, can you quote for a switchboard upgrade at 12 Smith Street, Brunswick VIC 3056? It is urgent. Call me on 0412 345 678.',
  }))
  assert.equal(r.enquiry, true)
  if (!r.enquiry) return
  assert.ok(r.score >= 80, `score ${r.score}`)
  assert.ok(r.reasons.includes('Asks for a quote or price'))
  assert.ok(r.reasons.includes('Mentions electrical work'))
  assert.ok(r.reasons.includes('Says it is urgent'))
  assert.ok(r.reasons.includes('Gives a location'))
  assert.ok(r.reasons.includes('Left a phone number'))
  assert.deepEqual(r.matchedTrades, ['electrical'])
  assert.equal(r.phone, '0412 345 678')
  assert.equal(r.region, 'VIC')
  assert.equal(r.postcode, '3056')
  assert.deepEqual(r.riskFlags, [])
  assert.match(r.recommendedAction, /Call them back/)
})

test('describing a job without the word quote still counts', () => {
  const r = assessInboundEnquiry(base({ subject: 'Hot water', body: 'Our hot water system stopped working, do you service Geelong?' }))
  assert.equal(r.enquiry, true)
})

test('automated, bulk, transactional and own mail is never an enquiry', () => {
  const cases: Array<[Partial<InboundEmail>, string]> = [
    [{ fromAddress: 'no-reply@bank.com', body: 'Can you quote?' }, 'automated sender'],
    [{ fromAddress: 'office@sparky.com.au', body: 'Need a quote' }, 'own address'],
    [{ headers: { 'list-unsubscribe': '<mailto:x>' }, body: 'Get a quote today' }, 'mailing list'],
    [{ headers: { 'auto-submitted': 'auto-replied' }, body: 'quote' }, 'auto-submitted'],
    [{ headers: { precedence: 'bulk' }, body: 'quote' }, 'bulk precedence'],
    [{ subject: 'Your order has shipped', body: 'Tracking number 123. Need help? Reply here.' }, 'transactional or marketing'],
    [{ subject: 'Lunch?', body: 'Are we still on for Friday?' }, 'no request for work'],
  ]
  for (const [over, reason] of cases) {
    assert.deepEqual(assessInboundEnquiry(base(over)), { enquiry: false, reason }, reason)
  }
})

test('a bare region word or a year is not read as a location', () => {
  const r = assessInboundEnquiry(base({ body: 'We need to act fast on the 2024 renovation, can you quote?' }))
  assert.equal(r.enquiry, true)
  if (r.enquiry) {
    assert.ok(!r.reasons.includes('Gives a location'))
    assert.equal(r.region, undefined)
  }
})

test('a risky email is surfaced at the top for a person, even without a work request', () => {
  const r = assessInboundEnquiry(base({ subject: 'Your invoice', body: 'I have spoken to my lawyer and we dispute the invoice.' }))
  assert.equal(r.enquiry, true)
  if (!r.enquiry) return
  assert.equal(r.score, 100)
  assert.deepEqual(r.riskFlags, ['LEGAL', 'PAYMENT_DISPUTE'])
  assert.match(r.reasons[0], /^Needs you personally/)
  assert.match(r.recommendedAction, /Handle this yourself/)
})

test('excerpt collapses whitespace, masks card numbers and is capped', () => {
  assert.equal(redactSensitive('card 4111 1111 1111 1111 ok'), 'card [payment card number removed] ok')
  assert.equal(redactSensitive('invoice 1234567890123 ref'), 'invoice 1234567890123 ref', 'non-Luhn digit runs are kept')
  assert.equal(enquiryExcerpt('a\n\n  b'), 'a b')
  const long = enquiryExcerpt('x'.repeat(2000))
  assert.equal(long.length, ENQUIRY_EXCERPT_MAX)
  assert.ok(long.endsWith('…'))
})

test('parseHeaderBlock lower-cases names, unfolds lines and stops at the body', () => {
  const h = parseHeaderBlock('From: a@b.c\r\nList-Unsubscribe: <mailto:x>,\r\n <https://y>\r\nSubject: Hi\r\n\r\nList-Id: not a header')
  assert.equal(h['from'], 'a@b.c')
  assert.equal(h['list-unsubscribe'], '<mailto:x>, <https://y>')
  assert.equal(h['list-id'], undefined)
})
