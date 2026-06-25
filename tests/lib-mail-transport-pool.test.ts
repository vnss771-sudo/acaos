import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { buildTransport, closeMailTransports } from '../packages/backend-core/src/services/mail.ts'

// SMTP_HOST is required by buildTransport for the system-relay path. createTransport
// does NOT open a connection until a send, so building one here is cheap and offline.
const saved = { ...process.env }
beforeEach(() => { process.env.SMTP_HOST = 'smtp.system.test'; process.env.SMTP_PORT = '587' })
afterEach(() => { closeMailTransports(); process.env = { ...saved } })

test('system relay is pooled: repeated buildTransport returns the SAME instance', () => {
  const a = buildTransport()
  const b = buildTransport(null)
  assert.strictEqual(a, b)
})

test('closeMailTransports resets the pool: a fresh instance is built afterwards', () => {
  const a = buildTransport()
  closeMailTransports()
  const b = buildTransport()
  assert.notStrictEqual(a, b)
})

test('workspace custom host is NOT pooled (per-send build preserves SSRF re-resolution)', () => {
  const pin = { host: '203.0.113.10', servername: 'mail.tenant.test' }
  const cfg = { smtpHost: 'mail.tenant.test', smtpPort: 587 }
  const a = buildTransport(cfg, pin)
  const b = buildTransport(cfg, pin)
  assert.notStrictEqual(a, b)
})

test('workspace-specific credentials are NOT pooled even on the system host', () => {
  const cfg = { smtpUser: 'tenant@x.test', smtpPass: 'secret' }
  const a = buildTransport(cfg)
  const b = buildTransport(cfg)
  assert.notStrictEqual(a, b)
  // and the pure-system transporter remains distinct from the credentialed one
  assert.notStrictEqual(buildTransport(), a)
})
