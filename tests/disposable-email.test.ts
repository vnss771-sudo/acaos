// Unit tests for disposable-email detection + the enablement toggle (pure).

import test from 'node:test'
import assert from 'node:assert/strict'
import { isDisposableEmail, isDisposableDomain, disposableBlockingEnabled } from '../packages/backend-core/src/lib/disposableEmail.ts'

test('flags well-known disposable providers', () => {
  assert.equal(isDisposableEmail('a@mailinator.com'), true)
  assert.equal(isDisposableEmail('x@10minutemail.com'), true)
  assert.equal(isDisposableEmail('y@guerrillamail.com'), true)
})

test('allows normal/business mailboxes', () => {
  assert.equal(isDisposableEmail('alice@gmail.com'), false)
  assert.equal(isDisposableEmail('bob@acme.co'), false)
  assert.equal(isDisposableEmail('c@outlook.com'), false)
})

test('matches subdomains of a disposable provider', () => {
  assert.equal(isDisposableDomain('inbox.mailinator.com'), true)
  assert.equal(isDisposableDomain('mailinator.com'), true)
  // ...but not an unrelated domain that merely contains the name.
  assert.equal(isDisposableDomain('notmailinator.com'), false)
})

test('is case-insensitive and tolerant of malformed input', () => {
  assert.equal(isDisposableEmail('A@MailInator.COM'), true)
  assert.equal(isDisposableEmail('no-at-sign'), false)
  assert.equal(isDisposableEmail(''), false)
  assert.equal(isDisposableEmail(null), false)
})

test('honors the DISPOSABLE_EMAIL_DOMAINS env extension', () => {
  const saved = process.env.DISPOSABLE_EMAIL_DOMAINS
  try {
    assert.equal(isDisposableEmail('user@evilcorp.test'), false)
    process.env.DISPOSABLE_EMAIL_DOMAINS = 'evilcorp.test, @another.test'
    assert.equal(isDisposableEmail('user@evilcorp.test'), true)
    assert.equal(isDisposableEmail('user@another.test'), true, 'a leading @ in the list is normalized away')
  } finally {
    if (saved === undefined) delete process.env.DISPOSABLE_EMAIL_DOMAINS
    else process.env.DISPOSABLE_EMAIL_DOMAINS = saved
  }
})

test('disposableBlockingEnabled defaults on; explicit false disables', () => {
  const saved = process.env.BLOCK_DISPOSABLE_EMAILS
  try {
    delete process.env.BLOCK_DISPOSABLE_EMAILS
    assert.equal(disposableBlockingEnabled(), true)
    process.env.BLOCK_DISPOSABLE_EMAILS = 'false'
    assert.equal(disposableBlockingEnabled(), false)
    process.env.BLOCK_DISPOSABLE_EMAILS = 'true'
    assert.equal(disposableBlockingEnabled(), true)
  } finally {
    if (saved === undefined) delete process.env.BLOCK_DISPOSABLE_EMAILS
    else process.env.BLOCK_DISPOSABLE_EMAILS = saved
  }
})
