// Integration tests for /api/mailbox — config guards, validation, and auth.
// SMTP/IMAP are intentionally left unconfigured so the routes return 503.

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mailboxRouter, dkimQueryName, isDkimRecord } from '../apps/api/src/routes/mailbox.ts'
import {
  createFakePrisma, installPrisma, resetPrisma, startTestServer, bearer, type TestServer,
} from './helpers/integration.ts'

let server: TestServer

beforeEach(async () => {
  // Ensure mail/mailbox are not configured.
  for (const k of ['SMTP_HOST', 'SMTP_FROM', 'IMAP_HOST', 'IMAP_USER', 'IMAP_PASS']) delete process.env[k]
  installPrisma(createFakePrisma({
    user: { findUnique: async () => ({ id: 'u1', email: 'u1@a.test', name: null, emailVerified: true }) },
    membership: { findFirst: async (a: any) => (a?.where?.userId === 'u1' && a?.where?.workspaceId === 'ws1' ? { id: 'm1', role: 'owner' } : null) },
    workspaceEmailConfig: { findUnique: async () => null },
  }))
  server = await startTestServer('/api/mailbox', mailboxRouter)
})
afterEach(async () => { await server.close(); resetPrisma() })

const jsonAuth = { Authorization: bearer('u1'), 'Content-Type': 'application/json' }

test('send-test requires authentication', async () => {
  const res = await server.request('/api/mailbox/send-test', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '1.1.1.1' },
    body: JSON.stringify({ to: 'a@b.test' }),
  })
  assert.equal(res.status, 401)
})

test('send-test returns 503 when SMTP is not configured', async () => {
  const res = await server.request('/api/mailbox/send-test', {
    method: 'POST', headers: { ...jsonAuth, 'X-Forwarded-For': '1.1.1.2' },
    body: JSON.stringify({ to: 'a@b.test', workspaceId: 'ws1' }),
  })
  assert.equal(res.status, 503)
})

test('send-test validates the recipient when SMTP IS configured', async () => {
  process.env.SMTP_HOST = 'smtp.test'
  process.env.SMTP_FROM = 'noreply@test'
  const res = await server.request('/api/mailbox/send-test', {
    method: 'POST', headers: { ...jsonAuth, 'X-Forwarded-For': '1.1.1.3' },
    body: JSON.stringify({ to: 'not-an-email', workspaceId: 'ws1' }),
  })
  assert.equal(res.status, 400)
})

test('check-domain DKIM lookup targets the selector subdomain, not the root', () => {
  // The bug fixed here: DKIM was probed at the root domain. It lives at
  // <selector>._domainkey.<domain>.
  assert.equal(dkimQueryName('google', 'example.com'), 'google._domainkey.example.com')
  // Multi-chunk TXT records (DKIM keys are often split) join before matching.
  assert.equal(isDkimRecord(['v=DKIM1; k=rsa; ', 'p=MIGf...']), true)
  assert.equal(isDkimRecord(['v=spf1 include:_spf.google.com ~all']), false)
})

test('check-domain rejects a malformed domain before any DNS lookup', async () => {
  const res = await server.request('/api/mailbox/check-domain?domain=not_a_domain', { headers: jsonAuth })
  assert.equal(res.status, 400)
})

test('sync requires workspaceId', async () => {
  const res = await server.request('/api/mailbox/sync', {
    method: 'POST', headers: { ...jsonAuth, 'X-Forwarded-For': '1.1.1.4' },
    body: JSON.stringify({}),
  })
  assert.equal(res.status, 400)
})

test('sync returns 503 when IMAP is not configured for the workspace', async () => {
  const res = await server.request('/api/mailbox/sync', {
    method: 'POST', headers: { ...jsonAuth, 'X-Forwarded-For': '1.1.1.5' },
    body: JSON.stringify({ workspaceId: 'ws1' }),
  })
  assert.equal(res.status, 503)
})

test('sync denies non-member workspace', async () => {
  const res = await server.request('/api/mailbox/sync', {
    method: 'POST', headers: { ...jsonAuth, 'X-Forwarded-For': '1.1.1.6' },
    body: JSON.stringify({ workspaceId: 'ws-other' }),
  })
  assert.equal(res.status, 403)
})
