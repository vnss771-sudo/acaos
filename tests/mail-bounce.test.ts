// Unit tests for bounce/NDR detection. The suppression safety (only addresses we
// actually sent to) lives in syncMailboxOnce; this covers the parsing heuristic.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectBounceRecipients, classifyBounce, softBounceSuppressThreshold } from '../packages/backend-core/src/services/mail.ts'

test('detects a DSN bounce and extracts the Final-Recipient', () => {
  const body = [
    'This is the mail system at host mail.example.com.',
    'Final-Recipient: rfc822; jane@acme.test',
    'Action: failed',
    'Status: 5.1.1',
  ].join('\n')
  const r = detectBounceRecipients('Undeliverable: Your message', 'MAILER-DAEMON@mail.example.com', body)
  assert.ok(r.includes('jane@acme.test'))
})

test('falls back to any address in a subject-flagged bounce', () => {
  const r = detectBounceRecipients(
    'Mail delivery failed: returning message to sender',
    'noreply@host.test',
    'The following address failed permanently: bob@corp.test (550 mailbox not found)'
  )
  assert.ok(r.includes('bob@corp.test'))
})

test('returns nothing for a normal reply (not a bounce)', () => {
  const r = detectBounceRecipients('Re: your offer', 'lead@company.test', 'Sure, sounds good — call me tomorrow.')
  assert.deepEqual(r, [])
})

test('a postmaster sender alone triggers detection', () => {
  const r = detectBounceRecipients('', 'postmaster@isp.test', 'Original-Recipient: rfc822;deadbox@x.test')
  assert.ok(r.includes('deadbox@x.test'))
})

// ── classifyBounce: hard vs soft vs unknown ────────────────────────────────────
test('classify: a 5.x.x DSN status is a hard bounce', () => {
  assert.equal(classifyBounce('Undeliverable', 'Action: failed\nStatus: 5.1.1\nuser unknown'), 'hard')
})

test('classify: a 4.x.x DSN status is a soft bounce', () => {
  assert.equal(classifyBounce('Delivery delayed', 'Action: delayed\nStatus: 4.2.2\nmailbox full'), 'soft')
})

test('classify: an enhanced status wins over conflicting phrases', () => {
  // 4.x.x status present even though "user unknown" appears — status wins.
  assert.equal(classifyBounce('', 'Status: 4.3.0\nuser unknown was seen earlier'), 'soft')
})

test('classify: a bare 550 SMTP reply code is hard', () => {
  assert.equal(classifyBounce('Mail delivery failed', 'remote server replied: 550 mailbox not found'), 'hard')
})

test('classify: a bare 452 SMTP reply code is soft', () => {
  assert.equal(classifyBounce('', 'smtp; 452 4.2.2 over quota, try later'), 'soft')
})

test('classify: transient phrases without a code are soft', () => {
  assert.equal(classifyBounce('', 'The recipient mailbox is over quota. Please try again later.'), 'soft')
})

test('classify: permanent phrases without a code are hard', () => {
  assert.equal(classifyBounce('', 'No such user here. The address does not exist.'), 'hard')
})

test('classify: an unrecognized bounce body is unknown (treated as hard by the caller)', () => {
  assert.equal(classifyBounce('Returned mail', 'Your message could not be processed for an unspecified reason.'), 'unknown')
})

test('soft-bounce threshold: defaults to 3 and honors a valid override', () => {
  const saved = process.env.SOFT_BOUNCE_SUPPRESS_THRESHOLD
  try {
    delete process.env.SOFT_BOUNCE_SUPPRESS_THRESHOLD
    assert.equal(softBounceSuppressThreshold(), 3)
    process.env.SOFT_BOUNCE_SUPPRESS_THRESHOLD = '5'
    assert.equal(softBounceSuppressThreshold(), 5)
    process.env.SOFT_BOUNCE_SUPPRESS_THRESHOLD = '0'
    assert.equal(softBounceSuppressThreshold(), 3, 'a sub-1 value falls back to the default')
  } finally {
    if (saved === undefined) delete process.env.SOFT_BOUNCE_SUPPRESS_THRESHOLD
    else process.env.SOFT_BOUNCE_SUPPRESS_THRESHOLD = saved
  }
})
