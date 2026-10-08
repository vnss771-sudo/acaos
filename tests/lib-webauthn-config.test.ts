import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getWebAuthnConfig } from '../packages/backend-core/src/lib/webauthnConfig.ts'

const env = (vars: Record<string, string>) => vars as NodeJS.ProcessEnv

test('WebAuthn ships disabled by default', () => {
  assert.equal(getWebAuthnConfig(env({})).enabled, false)
})

test('WebAuthn requires an RP ID when enabled', () => {
  assert.throws(() => getWebAuthnConfig(env({ WEBAUTHN_ENABLED: 'true', WEBAUTHN_ORIGIN: 'https://app.example.com' })), /RP_ID/)
})

test('WebAuthn requires HTTPS outside localhost', () => {
  assert.throws(() => getWebAuthnConfig(env({ WEBAUTHN_ENABLED: 'true', WEBAUTHN_RP_ID: 'example.com', WEBAUTHN_ORIGIN: 'http://app.example.com' })), /HTTPS/)
})

test('WebAuthn accepts a subdomain of the RP ID', () => {
  const cfg = getWebAuthnConfig(env({ WEBAUTHN_ENABLED: 'true', WEBAUTHN_RP_ID: 'example.com', WEBAUTHN_ORIGIN: 'https://app.example.com' }))
  assert.equal(cfg.rpId, 'example.com')
})
