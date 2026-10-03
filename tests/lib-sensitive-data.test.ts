// Unit tests for the outbound sensitive-data scan (pure).
// Secret-shaped fixtures are assembled at runtime so the repo's secret scanner
// never sees a literal key in source.

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  describeSensitiveKinds, redactSensitiveData, scanSensitiveData, sensitiveKinds,
} from '../packages/backend-core/src/lib/sensitiveData.ts'
import { checkDraftPolicy } from '../packages/backend-core/src/lib/policyCheck.ts'
import { resolveDraftSource } from '../apps/worker/src/processors.ts'

const STRIPE = 'sk_' + 'live_' + 'a1B2c3D4e5F6g7H8i9J0k1L2'
const GITHUB = 'gh' + 'p_' + 'Ab12'.repeat(9)
const AWS = 'AK' + 'IA' + 'ABCDEFGHIJKLMNOP'
const PEM = '-----BEGIN ' + 'RSA PRIVATE KEY-----'

test('catches card numbers, secret keys, passwords and TFNs', () => {
  const cases: Array<[string, string]> = [
    ['Card: 4111 1111 1111 1111 exp 12/27', 'PAYMENT_CARD'],
    ['Mastercard 5555-5555-5555-4444', 'PAYMENT_CARD'],
    ['amex 378282246310005 please charge it', 'PAYMENT_CARD'],
    [`Use this key: ${STRIPE}`, 'SECRET_KEY'],
    [`token ${GITHUB}`, 'SECRET_KEY'],
    [`aws ${AWS}`, 'SECRET_KEY'],
    [`${PEM}\nMIIEow...`, 'SECRET_KEY'],
    ['Login is jo@x.com, password: Tradie2026!', 'PASSWORD'],
    ['the wifi password is gr8wifi99', 'PASSWORD'],
    ['My TFN is 123 456 782 for the contractor form', 'TAX_FILE_NUMBER'],
    ['Tax file number: 123456782', 'TAX_FILE_NUMBER'],
  ]
  for (const [text, kind] of cases) {
    assert.deepEqual(sensitiveKinds(text), [kind], text)
  }
})

test('leaves ordinary contractor email alone', () => {
  for (const text of [
    'Invoice INV-1234567890123 attached, total $4,820 inc GST',
    'Call me on 0412 345 678 or (02) 9876 5432',
    'Our ABN is 51 824 753 556',
    'Pay by EFT: BSB 062-000, account 12345678, ref job 4471',
    'Tracking number 4111111111111112 for the switchboard parts',
    'The password is the same as last time, see you Tuesday',
    'Reset your password from the login page',
    'Job number 123 456 782 is booked for Friday',
    'sk_test placeholder in our docs',
  ]) {
    assert.deepEqual(scanSensitiveData(text), [], text)
  }
})

test('redaction names what was removed and keeps everything else', () => {
  assert.equal(
    redactSensitiveData('pay with 4111 1111 1111 1111 thanks, password: hunter22'),
    'pay with [payment card number removed] thanks, [password removed]',
  )
  assert.equal(redactSensitiveData('nothing to see'), 'nothing to see')
})

test('describeSensitiveKinds reads naturally', () => {
  assert.equal(describeSensitiveKinds(['PAYMENT_CARD']), 'a payment card number')
  assert.equal(describeSensitiveKinds(['PAYMENT_CARD', 'SECRET_KEY', 'PASSWORD']), 'a payment card number, a secret API or private key and a password')
})

test('draft policy flags sensitive data with a fixable message', () => {
  const v = checkDraftPolicy({ subject: 'Quote for the fit-out', emailBody: `Hi Jo, here is the quote. Our Stripe key is ${STRIPE} if you need it.` })
  const s = v.find(x => x.code === 'SENSITIVE_DATA')
  assert.ok(s)
  assert.match(s!.message, /secret API or private key/)
  assert.equal(checkDraftPolicy({ subject: 'Quote for the fit-out', emailBody: 'Hi Jo, here is the quote for the bathroom fit-out.' }).some(x => x.code === 'SENSITIVE_DATA'), false)
})

test('an existing draft carrying sensitive data is never reused for sending', () => {
  const lead = { id: 'l1', outreachDrafts: [{ id: 'd1', subject: 'Hi', emailBody: 'card 4111 1111 1111 1111' }] }
  assert.deepEqual(resolveDraftSource(lead, { approvalRequired: true, policyReviewLeadIds: new Set() }), { action: 'skip', reason: 'SENSITIVE_DATA' })
  const clean = { id: 'l2', outreachDrafts: [{ subject: 'Hi', emailBody: 'Hello there' }] }
  assert.deepEqual(resolveDraftSource(clean, { approvalRequired: true, policyReviewLeadIds: new Set() }), { action: 'reuse', subject: 'Hi', body: 'Hello there' })
})
