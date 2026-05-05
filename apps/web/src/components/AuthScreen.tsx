import React, { useState } from 'react'
import { s } from '../styles.js'

const API = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '')

type AuthScreenProps = {
  onToken: (token: string, refreshToken: string) => void
}

export function AuthScreen({ onToken }: AuthScreenProps) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setErr('')
    try {
      const body: Record<string, string> = {
        email: email.trim().toLowerCase(),
        password
      }
      if (mode === 'signup' && name.trim()) body.name = name.trim()

      const res = await fetch(`${API}/api/auth/${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Authentication failed')

      localStorage.setItem('acaos_token', data.token)
      if (data.refreshToken) localStorage.setItem('acaos_refresh', data.refreshToken)
      onToken(data.token, data.refreshToken)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Authentication failed')
    } finally {
      setLoading(false)
    }
  }

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
          {/* Mode toggle */}
          <div style={{ display: 'flex', gap: 4, marginBottom: 24, background: '#0b1220', borderRadius: 8, padding: 4 }}>
            {(['login', 'signup'] as const).map(m => (
              <button
                key={m}
                onClick={() => { setMode(m); setErr('') }}
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

          <form onSubmit={submit} style={{ display: 'grid', gap: 16 }}>
            {mode === 'signup' && (
              <div>
                <label style={s.label}>Name</label>
                <input
                  style={s.input}
                  type="text"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="Your name"
                  autoComplete="name"
                />
              </div>
            )}
            <div>
              <label style={s.label}>Email</label>
              <input
                style={s.input}
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="you@example.com"
                required
                autoComplete="email"
              />
            </div>
            <div>
              <label style={s.label}>Password</label>
              <input
                style={s.input}
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="At least 8 characters"
                required
                minLength={8}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
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
              style={{ ...s.btn, width: '100%', padding: '12px', opacity: loading ? 0.7 : 1 }}
              disabled={loading}
            >
              {loading ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
