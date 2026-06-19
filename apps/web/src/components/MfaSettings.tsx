import React, { useState } from 'react'
import { s, colors } from '../styles.js'
import { Spinner } from './Spinner.js'
import { authedPost, ReauthRequiredError, type ApiHook } from '../hooks/useApi.js'
import type { ToastHook } from '../hooks/useToast.js'

type Props = {
  api: ApiHook
  // Whether the account currently has TOTP enabled (from /api/auth/me).
  enabled: boolean
  // Bubbled up so the rest of the app (e.g. the reauth modal) knows MFA state.
  onEnabledChange: (enabled: boolean) => void
  toast: ToastHook
}

type SetupData = { secret: string; otpauthUri: string }

// Security section: set up / disable TOTP two-factor authentication.
export function MfaSettings({ api, enabled, onEnabledChange, toast }: Props) {
  const [setup, setSetup] = useState<SetupData | null>(null)
  const [code, setCode] = useState('')
  const [working, setWorking] = useState(false)
  const [copied, setCopied] = useState(false)

  async function startSetup() {
    setWorking(true)
    try {
      const d = await authedPost<SetupData>(api, '/api/auth/mfa/setup')
      setSetup(d)
      setCode('')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to start 2FA setup')
    } finally {
      setWorking(false)
    }
  }

  async function activate() {
    setWorking(true)
    try {
      await authedPost(api, '/api/auth/mfa/activate', { code: code.trim() })
      setSetup(null)
      setCode('')
      onEnabledChange(true)
      toast.success('Two-factor authentication enabled')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to enable 2FA — check the code and try again')
    } finally {
      setWorking(false)
    }
  }

  async function disable() {
    if (!confirm('Disable two-factor authentication? Your account will be less secure.')) return
    setWorking(true)
    try {
      await authedPost(api, '/api/auth/mfa/disable')
      onEnabledChange(false)
      toast.success('Two-factor authentication disabled')
    } catch (e) {
      // The reauth modal is surfaced globally by App when a 403 REAUTH_REQUIRED
      // is seen; after the user reauths they can click Disable again.
      if (e instanceof ReauthRequiredError) {
        toast.error('Please confirm your identity, then try again')
      } else {
        toast.error(e instanceof Error ? e.message : 'Failed to disable 2FA')
      }
    } finally {
      setWorking(false)
    }
  }

  function copySecret(secret: string) {
    navigator.clipboard.writeText(secret).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <div style={s.card}>
      <div style={s.sectionHeader}>Two-Factor Authentication</div>
      <div style={{ color: colors.textMuted, fontSize: 13, marginBottom: 16 }}>
        Add an extra layer of security using a time-based one-time password (TOTP) from an
        authenticator app like Google Authenticator, 1Password, or Authy.
      </div>

      {/* Status */}
      <div style={{ ...s.cardInner, display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: enabled ? colors.green : colors.textFaint, display: 'inline-block' }} />
          <span style={{ color: enabled ? colors.green : colors.textFaint, fontSize: 13, fontWeight: 600 }}>
            {enabled ? 'Enabled' : 'Disabled'}
          </span>
        </div>
        {enabled ? (
          <button style={{ ...s.btnGhost, color: colors.red }} disabled={working} onClick={disable}>
            {working ? <><Spinner size={13} /> Working…</> : 'Disable 2FA'}
          </button>
        ) : !setup ? (
          <button style={s.btn} disabled={working} onClick={startSetup}>
            {working ? <><Spinner size={14} color="#fff" /> Working…</> : 'Set up 2FA'}
          </button>
        ) : null}
      </div>

      {/* Setup flow (disabled → setup → activate) */}
      {!enabled && setup && (
        <div style={{ display: 'grid', gap: 14 }}>
          <div style={{ color: colors.text, fontSize: 13 }}>
            1. Add this account to your authenticator app — scan the link below or enter the secret manually.
          </div>

          <div>
            <label style={s.label} htmlFor="mfa-otpauth">Setup link (otpauth URI)</label>
            <div
              id="mfa-otpauth"
              style={{
                background: '#0b1220', border: `1px solid ${colors.border}`,
                borderRadius: 6, padding: '10px 14px', fontFamily: 'monospace',
                fontSize: 12, color: colors.textMuted, wordBreak: 'break-all'
              }}
            >
              {setup.otpauthUri}
            </div>
          </div>

          <div>
            <label style={s.label} htmlFor="mfa-secret">Manual entry secret</label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <div
                id="mfa-secret"
                style={{
                  flex: 1, background: '#0b1220', border: `1px solid ${colors.border}`,
                  borderRadius: 6, padding: '10px 14px', fontFamily: 'monospace',
                  fontSize: 15, letterSpacing: '0.12em', color: colors.text, wordBreak: 'break-all'
                }}
              >
                {setup.secret}
              </div>
              <button type="button" style={s.btnSm} onClick={() => copySecret(setup.secret)}>
                {copied ? '✓ Copied' : 'Copy'}
              </button>
            </div>
          </div>

          <div>
            <div style={{ color: colors.text, fontSize: 13, marginBottom: 8 }}>
              2. Enter the 6-digit code from your app to finish enabling.
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div>
                <label style={s.label} htmlFor="mfa-activate-code">Authentication code</label>
                <input
                  id="mfa-activate-code"
                  style={{ ...s.input, width: 160, letterSpacing: '0.3em', textAlign: 'center' }}
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]*"
                  maxLength={6}
                  value={code}
                  onChange={e => setCode(e.target.value.replace(/\D/g, ''))}
                  placeholder="000000"
                />
              </div>
              <button style={s.btn} disabled={working || code.length < 6} onClick={activate}>
                {working ? <><Spinner size={14} color="#fff" /> Verifying…</> : 'Enable 2FA'}
              </button>
              <button
                style={s.btnGhost}
                disabled={working}
                onClick={() => { setSetup(null); setCode('') }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
