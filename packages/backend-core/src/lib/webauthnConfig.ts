export type WebAuthnConfig = {
  enabled: boolean
  rpName: string
  rpId: string
  origin: string
  challengeTtlMs: number
}

function bool(value: string | undefined, fallback = false) {
  if (value == null || value === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

export function getWebAuthnConfig(env: NodeJS.ProcessEnv = process.env): WebAuthnConfig {
  const enabled = bool(env.WEBAUTHN_ENABLED, false)
  const rpName = (env.WEBAUTHN_RP_NAME || 'ACAOS').trim()
  const rpId = (env.WEBAUTHN_RP_ID || '').trim().toLowerCase()
  const origin = (env.WEBAUTHN_ORIGIN || env.APP_URL || '').trim().replace(/\/$/, '')
  const challengeTtlMs = Math.max(60_000, Number(env.WEBAUTHN_CHALLENGE_TTL_MS || 5 * 60_000))

  if (enabled) {
    if (!rpId) throw new Error('WEBAUTHN_RP_ID is required when WEBAUTHN_ENABLED=true')
    if (!origin) throw new Error('WEBAUTHN_ORIGIN (or APP_URL) is required when WEBAUTHN_ENABLED=true')
    const u = new URL(origin)
    if (u.protocol !== 'https:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') {
      throw new Error('WebAuthn origin must use HTTPS outside localhost')
    }
    const host = u.hostname.toLowerCase()
    if (host !== rpId && !host.endsWith(`.${rpId}`)) {
      throw new Error('WEBAUTHN_RP_ID must equal or be a registrable parent of the WebAuthn origin host')
    }
  }

  return { enabled, rpName, rpId, origin, challengeTtlMs }
}
