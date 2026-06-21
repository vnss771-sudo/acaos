import React, { useState } from 'react'
import type { LoginRequest, ForgotPasswordRequest, ResetPasswordRequest } from '@acaos/shared'
import { s } from '../styles.js'

const API = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '')

type AuthScreenProps = {
  onToken: (token: string) => void
  resetToken?: string | null
  inviteToken?: string | null
}

export function AuthScreen({ onToken, resetToken, inviteToken }: AuthScreenProps) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [mode, setMode] = useState<'login' | 'signup' | 'forgot' | 'reset'>(
    resetToken ? 'reset' : inviteToken ? 'signup' : 'login'
  )
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [successMsg, setSuccessMsg] = useState('')

  // MFA (TOTP) second step: set once a login responds with mfaRequired. While
  // `mfaToken` is set we show the 6-digit code step instead of the credentials form.
  const [mfaToken, setMfaToken] = useState<string | null>(null)
  const [mfaCode, setMfaCode] = useState('')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setErr('')
    setSuccessMsg('')

    try {
      if (mode === 'forgot') {
        const forgotBody: ForgotPasswordRequest = { email: email.trim().toLowerCase() }
        const res = await fetch(`${API}/api/auth/forgot-password`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(forgotBody)
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || 'Request failed')
        setSuccessMsg('If that email is registered, a reset link has been sent.')
        setEmail('')
        return
      }

      if (mode === 'reset') {
        if (password !== confirmPassword) throw new Error('Passwords do not match')
        const resetBody: ResetPasswordRequest = { token: resetToken ?? '', password }
        const res = await fetch(`${API}/api/auth/reset-password`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(resetBody)
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || 'Reset failed')
        setSuccessMsg('Password reset! You can now sign in.')
        setPassword('')
        setConfirmPassword('')
        // Clear the ?reset= param from URL without reload
        window.history.replaceState({}, '', window.location.pathname)
        setTimeout(() => setMode('login'), 1500)
        return
      }

      const body: LoginRequest = {
        email: email.trim().toLowerCase(),
        password
      }
      if (mode === 'signup' && name.trim()) body.name = name.trim()

      const res = await fetch(`${API}/api/auth/${mode}`, {
        method: 'POST',
        credentials: 'include', // accept the HttpOnly refresh cookie the server sets
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Authentication failed')

      // MFA-enabled accounts get no token on login — instead a short-lived
      // mfaToken. Switch to the 6-digit code step; the actual token comes back
      // from /verify-totp once the user proves a code.
      if (data.mfaRequired) {
        setMfaToken(data.mfaToken)
        setMfaCode('')
        return
      }

      // The refresh token is now in an HttpOnly cookie; only the access token is
      // returned, and it is held in memory by the app (not localStorage).
      onToken(data.token)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Authentication failed')
    } finally {
      setLoading(false)
    }
  }

  async function submitMfa(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setErr('')
    try {
      const res = await fetch(`${API}/api/auth/verify-totp`, {
        method: 'POST',
        credentials: 'include', // accept the HttpOnly refresh cookie the server sets
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mfaToken, code: mfaCode.trim() })
      })
      const data = await res.json()
      if (res.status === 401) throw new Error('Incorrect code. Please try again.')
      if (!res.ok) throw new Error(data.error || 'Verification failed')
      // Completes the MFA login — same token path as a normal sign-in.
      onToken(data.token)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Verification failed')
    } finally {
      setLoading(false)
    }
  }

  function cancelMfa() {
    setMfaToken(null)
    setMfaCode('')
    setErr('')
    setPassword('')
  }

  const isForgotOrReset = mode === 'forgot' || mode === 'reset'

  return (
    <div style={{
      minHeight: '100vh', background: '#030712',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: 'system-ui, -apple-system, sans-serif'
    }}>
      <div style={{ width: 400 }}>
        {/* Logo */}
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{ color: '#2563eb', fontWeight: 800, fontSize: 26, letterSpacing: 2 }}>ACAOS</div>
          <div style={{ color: '#475569', fontSize: 13, marginTop: 4 }}>Agentic Client Acquisition OS</div>
        </div>

        <div style={{ ...s.card, padding: 28 }}>
          {/* MFA (TOTP) second step — shown once login responds with mfaRequired */}
          {mfaToken ? (
            <>
              <div style={{ marginBottom: 20 }}>
                <div style={{ color: '#f1f5f9', fontWeight: 600, fontSize: 16, marginBottom: 4 }}>
                  Two-factor authentication
                </div>
                <div style={{ color: '#64748b', fontSize: 13 }}>
                  Enter your 6-digit authentication code from your authenticator app.
                </div>
              </div>
              <form onSubmit={submitMfa} style={{ display: 'grid', gap: 16 }}>
                <div>
                  <label style={s.label} htmlFor="authscreen-mfa-code">Authentication code</label>
                  <input
                    id="authscreen-mfa-code"
                    style={{ ...s.input, letterSpacing: '0.4em', textAlign: 'center', fontSize: 18 }}
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]*"
                    maxLength={6}
                    value={mfaCode}
                    onChange={e => setMfaCode(e.target.value.replace(/\D/g, ''))}
                    placeholder="000000"
                    autoFocus
                    required
                  />
                </div>

                {err && (
                  <div style={{
                    background: '#450a0a', border: '1px solid #7f1d1d', borderRadius: 6,
                    padding: '10px 12px', color: '#fca5a5', fontSize: 13
                  }}>
                    {err}
                  </div>
                )}

                <button
                  type="submit"
                  style={{ ...s.btn, width: '100%', padding: '12px', opacity: loading || mfaCode.length < 6 ? 0.7 : 1 }}
                  disabled={loading || mfaCode.length < 6}
                >
                  {loading ? 'Verifying…' : 'Verify'}
                </button>
              </form>
              <div style={{ marginTop: 16, textAlign: 'center' }}>
                <button
                  onClick={cancelMfa}
                  style={{ background: 'none', border: 'none', color: '#64748b', fontSize: 13, cursor: 'pointer' }}
                >
                  ← Back to sign in
                </button>
              </div>
            </>
          ) : (
          <>
          {/* Invite banner */}
          {inviteToken && !isForgotOrReset && (
            <div style={{
              background: '#1e3a5f', border: '1px solid #3b82f6', borderRadius: 8,
              padding: '10px 14px', marginBottom: 20, color: '#93c5fd', fontSize: 13
            }}>
              You've been invited to join a workspace. Sign in or create an account to accept.
            </div>
          )}

          {/* Mode toggle (only for login/signup) */}
          {!isForgotOrReset && (
            <div style={{ display: 'flex', gap: 4, marginBottom: 24, background: '#0b1220', borderRadius: 8, padding: 4 }}>
              {(['login', 'signup'] as const).map(m => (
                <button
                  key={m}
                  onClick={() => { setMode(m); setErr(''); setSuccessMsg('') }}
                  style={{
                    flex: 1, padding: '8px 0', borderRadius: 6, border: 'none',
                    background: mode === m ? '#1e293b' : 'transparent',
                    color: mode === m ? '#f1f5f9' : '#64748b',
                    cursor: 'pointer', fontSize: 14, fontWeight: mode === m ? 600 : 400,
                    transition: 'all 0.15s'
                  }}
                >
                  {m === 'login' ? 'Sign in' : 'Create account'}
                </button>
              ))}
            </div>
          )}

          {/* Forgot/Reset header */}
          {isForgotOrReset && (
            <div style={{ marginBottom: 20 }}>
              <div style={{ color: '#f1f5f9', fontWeight: 600, fontSize: 16, marginBottom: 4 }}>
                {mode === 'forgot' ? 'Reset your password' : 'Set a new password'}
              </div>
              <div style={{ color: '#64748b', fontSize: 13 }}>
                {mode === 'forgot'
                  ? 'Enter your email and we\'ll send a reset link.'
                  : 'Enter your new password below.'}
              </div>
            </div>
          )}

          <form onSubmit={submit} style={{ display: 'grid', gap: 16 }}>
            {mode === 'signup' && (
              <div>
                <label style={s.label} htmlFor="authscreen-field-0">Name</label>
                <input id="authscreen-field-0"
                  style={s.input}
                  type="text"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="Your name"
                  autoComplete="name"
                />
              </div>
            )}

            {(mode === 'login' || mode === 'signup' || mode === 'forgot') && (
              <div>
                <label style={s.label} htmlFor="authscreen-field-1">Email</label>
                <input id="authscreen-field-1"
                  style={s.input}
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  required
                  autoComplete="email"
                />
              </div>
            )}

            {(mode === 'login' || mode === 'signup' || mode === 'reset') && (
              <div>
                <label style={s.label} htmlFor="authscreen-field-2">{mode === 'reset' ? 'New Password' : 'Password'}</label>
                <input id="authscreen-field-2"
                  style={s.input}
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder={mode === 'login' ? 'Enter your password' : 'At least 12 characters'}
                  required
                  // Enforce the 12-char floor only when setting a password
                  // (signup/reset). In login mode, never block submit on length —
                  // legacy/short or simply-wrong passwords must reach the server
                  // for a proper auth response.
                  minLength={mode === 'login' ? undefined : 12}
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                />
              </div>
            )}

            {mode === 'reset' && (
              <div>
                <label style={s.label} htmlFor="authscreen-field-3">Confirm New Password</label>
                <input id="authscreen-field-3"
                  style={s.input}
                  type="password"
                  value={confirmPassword}
                  onChange={e => setConfirmPassword(e.target.value)}
                  placeholder="Repeat password"
                  required
                  minLength={12}
                  autoComplete="new-password"
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

            {successMsg && (
              <div style={{
                background: '#052e16', border: '1px solid #166534', borderRadius: 6,
                padding: '10px 12px', color: '#86efac', fontSize: 13
              }}>
                {successMsg}
              </div>
            )}

            <button
              type="submit"
              style={{ ...s.btn, width: '100%', padding: '12px', opacity: loading ? 0.7 : 1 }}
              disabled={loading}
            >
              {loading ? 'Please wait…' :
                mode === 'login' ? 'Sign in' :
                mode === 'signup' ? 'Create account' :
                mode === 'forgot' ? 'Send reset link' :
                'Set new password'}
            </button>
          </form>

          {/* Forgot password link (login mode only) */}
          {mode === 'login' && (
            <div style={{ marginTop: 16, textAlign: 'center' }}>
              <button
                onClick={() => { setMode('forgot'); setErr(''); setSuccessMsg('') }}
                style={{ background: 'none', border: 'none', color: '#3b82f6', fontSize: 13, cursor: 'pointer' }}
              >
                Forgot your password?
              </button>
            </div>
          )}

          {/* Back to login link (forgot/reset mode) */}
          {isForgotOrReset && (
            <div style={{ marginTop: 16, textAlign: 'center' }}>
              <button
                onClick={() => { setMode('login'); setErr(''); setSuccessMsg('') }}
                style={{ background: 'none', border: 'none', color: '#64748b', fontSize: 13, cursor: 'pointer' }}
              >
                ← Back to sign in
              </button>
            </div>
          )}
          </>
          )}
        </div>
      </div>
    </div>
  )
}
