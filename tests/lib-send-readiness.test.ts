// Unit tests for lib/sendReadiness — the single gate deciding whether a
// workspace may send outreach. It enforces three preconditions (SMTP
// configured, business name set, postal address set); the latter two are
// legally required in commercial email (CAN-SPAM), so each check's pass/fail
// transition matters and `ready` must be the AND of all three.

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { getSendReadiness } from '../apps/api/src/lib/sendReadiness.ts'
import { createFakePrisma, installPrisma, resetPrisma } from './helpers/integration.ts'

// Build a fake Prisma whose workspaceEmailConfig + workspace rows reflect a
// given readiness scenario.
function withState(emailCfg: any, ws: any) {
  installPrisma(createFakePrisma({
    workspaceEmailConfig: { findUnique: async () => emailCfg },
    workspace: { findUnique: async () => ws },
  }))
}

const FULL_SMTP = { smtpHost: 'smtp.test', smtpFrom: 'noreply@test' }

beforeEach(() => {
  // Ensure env-level SMTP doesn't leak in and satisfy the check implicitly.
  delete process.env.SMTP_HOST
  delete process.env.SMTP_FROM
})
afterEach(() => resetPrisma())

test('a fully-configured workspace is ready with all checks passing', async () => {
  withState(FULL_SMTP, { senderBusinessName: 'Acme Inc', senderPostalAddress: '1 Main St' })
  const r = await getSendReadiness('ws1')
  assert.equal(r.ready, true)
  assert.ok(r.checks.every((c) => c.ok))
  assert.deepEqual(r.checks.map((c) => c.name), ['smtpConfigured', 'senderBusinessName', 'senderPostalAddress'])
})

test('missing SMTP config fails only the smtp check and blocks readiness', async () => {
  withState(null, { senderBusinessName: 'Acme Inc', senderPostalAddress: '1 Main St' })
  const r = await getSendReadiness('ws1')
  assert.equal(r.ready, false)
  assert.equal(r.checks.find((c) => c.name === 'smtpConfigured')?.ok, false)
  assert.equal(r.checks.find((c) => c.name === 'senderBusinessName')?.ok, true)
})

test('a blank/whitespace business name does not count as set', async () => {
  withState(FULL_SMTP, { senderBusinessName: '   ', senderPostalAddress: '1 Main St' })
  const r = await getSendReadiness('ws1')
  assert.equal(r.ready, false)
  assert.equal(r.checks.find((c) => c.name === 'senderBusinessName')?.ok, false)
})

test('a missing postal address blocks readiness', async () => {
  withState(FULL_SMTP, { senderBusinessName: 'Acme Inc', senderPostalAddress: null })
  const r = await getSendReadiness('ws1')
  assert.equal(r.ready, false)
  assert.equal(r.checks.find((c) => c.name === 'senderPostalAddress')?.ok, false)
})

test('a brand-new workspace (no config rows) is not ready and every check fails', async () => {
  withState(null, null)
  const r = await getSendReadiness('ws1')
  assert.equal(r.ready, false)
  assert.ok(r.checks.every((c) => !c.ok))
  // Each failing check carries an actionable hint for the onboarding panel.
  assert.ok(r.checks.every((c) => c.hint.length > 0))
})

test('env-level SMTP credentials satisfy the smtp check even without a workspace config row', async () => {
  process.env.SMTP_HOST = 'smtp.env'
  process.env.SMTP_FROM = 'noreply@env'
  withState(null, { senderBusinessName: 'Acme Inc', senderPostalAddress: '1 Main St' })
  const r = await getSendReadiness('ws1')
  assert.equal(r.checks.find((c) => c.name === 'smtpConfigured')?.ok, true)
  assert.equal(r.ready, true)
})
