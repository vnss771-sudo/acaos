import { describe, expect, it } from 'vitest'
import { getWebAuthnConfig } from '../packages/backend-core/src/lib/webauthnConfig.js'

describe('WebAuthn configuration', () => {
  it('ships disabled by default', () => {
    expect(getWebAuthnConfig({} as NodeJS.ProcessEnv).enabled).toBe(false)
  })

  it('requires an RP ID when enabled', () => {
    expect(() => getWebAuthnConfig({ WEBAUTHN_ENABLED: 'true', WEBAUTHN_ORIGIN: 'https://app.example.com' } as NodeJS.ProcessEnv)).toThrow(/RP_ID/)
  })

  it('requires HTTPS outside localhost', () => {
    expect(() => getWebAuthnConfig({ WEBAUTHN_ENABLED: 'true', WEBAUTHN_RP_ID: 'example.com', WEBAUTHN_ORIGIN: 'http://app.example.com' } as NodeJS.ProcessEnv)).toThrow(/HTTPS/)
  })

  it('accepts a subdomain of the RP ID', () => {
    const cfg = getWebAuthnConfig({ WEBAUTHN_ENABLED: 'true', WEBAUTHN_RP_ID: 'example.com', WEBAUTHN_ORIGIN: 'https://app.example.com' } as NodeJS.ProcessEnv)
    expect(cfg.rpId).toBe('example.com')
  })
})
