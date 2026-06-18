// Unit tests for bounce/NDR detection. The suppression safety (only addresses we
// actually sent to) lives in syncMailboxOnce; this covers the parsing heuristic.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectBounceRecipients } from '../packages/backend-core/src/services/mail.ts'

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
