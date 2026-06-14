// Production log-redaction for token-bearing URLs. When SMTP is not configured,
// the auth flows fall back to logging the action — but in production they must
// NOT log the URL containing the raw reset/verification token. (The invite flow
// in workspaces.ts uses the identical guard.)

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { authRouter } from '../apps/api/src/routes/auth.ts'
import {
  createFakePrisma, installPrisma, resetPrisma, startTestServer, type TestServer,
} from './helpers/integration.ts'

let server: TestServer
let logs: string[]
const origEnv = process.env.NODE_ENV
const origLog = console.log
const origWarn = console.warn
const origSmtpHost = process.env.SMTP_HOST
const origSmtpFrom = process.env.SMTP_FROM

beforeEach(async () => {
  logs = []
  console.log = (...a: unknown[]) => { logs.push(a.join(' ')) }
  console.warn = (...a: unknown[]) => { logs.push(a.join(' ')) }
  // Make SMTP look unconfigured so the fallback log branch runs.
  delete process.env.SMTP_HOST
  delete process.env.SMTP_FROM
  installPrisma(createFakePrisma({
    user: {
      findUnique: async (x: any) =>
        x?.where?.email === 'u@a.test' ? { id: 'u1', email: 'u@a.test', passwordHash: 'x' } : null,
    },
    passwordResetToken: { create: async () => ({ id: 'prt1' }) },
  }))
  server = await startTestServer('/api/auth', authRouter)
})

afterEach(async () => {
  await server.close()
  resetPrisma()
  console.log = origLog
  console.warn = origWarn
  process.env.NODE_ENV = origEnv
  if (origSmtpHost === undefined) delete process.env.SMTP_HOST; else process.env.SMTP_HOST = origSmtpHost
  if (origSmtpFrom === undefined) delete process.env.SMTP_FROM; else process.env.SMTP_FROM = origSmtpFrom
})

// Unique source IP per call so the per-IP auth rate limiter doesn't interfere.
let ip = 0
const forgot = (email: string) =>
  server.request('/api/auth/forgot-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `7.0.0.${ip++ % 250}` },
    body: JSON.stringify({ email }),
  })

test('production: forgot-password never logs the reset token URL', async () => {
  process.env.NODE_ENV = 'production'
  const res = await forgot('u@a.test')
  assert.equal(res.status, 200)
  assert.ok(logs.some(l => /SMTP not configured/.test(l)), 'should note SMTP is unconfigured')
  assert.ok(!logs.some(l => /reset=/.test(l)), 'must NOT log a URL containing the reset token')
})

test('development: forgot-password logs the reset URL for convenience', async () => {
  process.env.NODE_ENV = 'development'
  const res = await forgot('u@a.test')
  assert.equal(res.status, 200)
  assert.ok(logs.some(l => /reset=/.test(l)), 'dev convenience logging is preserved')
})
