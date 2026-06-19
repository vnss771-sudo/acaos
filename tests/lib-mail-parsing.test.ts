// Unit tests for the mail-parsing helpers and SMTP transport construction —
// the pure/branchy logic inside mail.ts that does not need a live SMTP/IMAP
// server. extractReplyBody/extractPlainText are exercised directly; buildTransport
// is checked for its auth-presence and SSRF-pin (TLS servername) branches.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  extractReplyBody,
  extractPlainText,
  buildTransport,
} from '../packages/backend-core/src/services/mail.ts'

// ── extractReplyBody ───────────────────────────────────────────────────────────
test('extractReplyBody keeps the fresh reply and drops quoted history', () => {
  const raw = [
    'Yes, let\'s talk Tuesday.',
    '',
    'On Mon, Jan 1, 2026 at 9:00 AM Sales <s@x.test> wrote:',
    '> Are you free this week?',
    '> Best, Sales',
  ].join('\n')
  assert.equal(extractReplyBody(raw), "Yes, let's talk Tuesday.")
})

test('extractReplyBody stops at a signature delimiter', () => {
  const raw = 'Sounds good.\n--\nJane Doe\nCEO'
  assert.equal(extractReplyBody(raw), 'Sounds good.')
})

test('extractReplyBody returns trimmed content when there is nothing to strip', () => {
  assert.equal(extractReplyBody('  just this  '), 'just this')
  assert.equal(extractReplyBody(''), '')
})

// ── extractPlainText ───────────────────────────────────────────────────────────
test('extractPlainText pulls the text/plain MIME part', () => {
  const mime = Buffer.from(
    [
      'From: a@x.test',
      'Content-Type: multipart/alternative; boundary=bnd',
      '',
      '--bnd',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Hello in plain text',
      '--bnd',
      'Content-Type: text/html',
      '',
      '<p>Hello in HTML</p>',
      '--bnd--',
    ].join('\n'),
  )
  assert.match(extractPlainText(mime), /Hello in plain text/)
})

test('extractPlainText falls back to the body after the header block', () => {
  const msg = Buffer.from('Subject: Hi\nFrom: a@x.test\n\nBody after headers')
  assert.equal(extractPlainText(msg), 'Body after headers')
})

// ── buildTransport ─────────────────────────────────────────────────────────────
test('buildTransport sets auth only when a user is configured', () => {
  const withAuth: any = buildTransport({ smtpHost: 'smtp.example.com', smtpPort: 587, smtpUser: 'u', smtpPass: 'p' })
  assert.ok(withAuth.options.auth, 'auth present when user set')
  assert.equal(withAuth.options.auth.user, 'u')

  const noAuth: any = buildTransport({ smtpHost: 'smtp.example.com', smtpPort: 587 })
  assert.equal(noAuth.options.auth, undefined, 'no auth when user absent')
})

test('buildTransport pins the resolved IP and preserves the hostname as TLS servername', () => {
  const t: any = buildTransport(
    { smtpHost: 'smtp.example.com', smtpPort: 465, smtpSecure: true },
    { host: '93.184.216.34', servername: 'smtp.example.com' },
  )
  assert.equal(t.options.host, '93.184.216.34', 'dials the pinned IP')
  assert.equal(t.options.tls.servername, 'smtp.example.com', 'TLS SNI keeps the hostname')
  assert.equal(t.options.secure, true)
})
