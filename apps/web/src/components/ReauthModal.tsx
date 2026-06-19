import React, { useState } from 'react'
import { s, colors } from '../styles.js'
import { Spinner } from './Spinner.js'
import { authedPost, type ApiHook } from '../hooks/useApi.js'

type Props = {
  api: ApiHook
  // When the user has MFA enabled the backend also requires a 6-digit code to
  // refresh the step-up window, so we show the code field.
  mfaEnabled: boolean
  // Called after a successful reauth — the app can then retry the gated action.
  onSuccess: () => void
  onCancel: () => void
}

// Step-up re-authentication modal. Shown whenever an authed API call returns
// HTTP 403 {code:"REAUTH_REQUIRED"}. Refreshes the recent-credential-proof
// window via POST /api/auth/reauth, then lets the caller retry.
export function ReauthModal({ api, mfaEnabled, onSuccess, onCancel }: Props) {
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setErr('')
    try {
      const body: { password: string; code?: string } = { password }
      if (mfaEnabled) body.code = code.trim()
      await authedPost(api, '/api/auth/reauth', body)
      onSuccess()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Re-authentication failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 300
    }}>
      <div role="dialog" aria-modal="true" aria-label="Confirm your identity" style={{ ...s.card, maxWidth: 420, width: '90%' }}>
        <div style={{ color: colors.text, fontWeight: 700, fontSize: 16, marginBottom: 4 }}>
          Confirm your identity
        </div>
        <div style={{ color: colors.textMuted, fontSize: 13, marginBottom: 16 }}>
          For your security, please re-enter your password to continue.
        </div>
        <form onSubmit={submit} style={{ display: 'grid', gap: 12 }}>
          <div>
            <label style={s.label} htmlFor="reauth-password">Password</label>
            <input
              id="reauth-password"
              style={s.input}
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              autoComplete="current-password"
              autoFocus
              required
            />
          </div>
          {mfaEnabled && (
            <div>
              <label style={s.label} htmlFor="reauth-code">Authentication code</label>
              <input
                id="reauth-code"
                style={{ ...s.input, letterSpacing: '0.3em' }}
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]*"
                maxLength={6}
                value={code}
                onChange={e => setCode(e.target.value.replace(/\D/g, ''))}
                placeholder="000000"
                required
              />
            </div>
          )}
          {err && (
            <div style={{
              background: '#450a0a', border: '1px solid #7f1d1d', borderRadius: 6,
              padding: '10px 12px', color: '#fca5a5', fontSize: 13
            }}>
              {err}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <button
              type="submit"
              style={{ ...s.btn, opacity: loading ? 0.7 : 1 }}
              disabled={loading || !password || (mfaEnabled && code.length < 6)}
            >
              {loading ? <><Spinner size={14} color="#fff" /> Verifying…</> : 'Confirm'}
            </button>
            <button type="button" style={s.btnGhost} onClick={onCancel} disabled={loading}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
