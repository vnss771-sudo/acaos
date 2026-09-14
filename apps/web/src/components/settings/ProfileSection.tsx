import React from 'react'
import type { User } from '../../types.js'
import { s } from '../../styles.js'
import { Spinner } from '../Spinner.js'

export function ProfileSection({ user, name, onNameChange, saving, onSave, onResendVerification }: {
  user: User
  name: string
  onNameChange: (name: string) => void
  saving: boolean
  onSave: () => void
  onResendVerification: () => void
}) {
  return (
    <div style={s.card}>
      <div style={s.sectionHeader}>Profile</div>
      {!user.emailVerified && (
        <div style={{ background: '#422006', border: '1px solid #92400e', borderRadius: 8, padding: '10px 14px', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ color: '#fbbf24', fontSize: 13 }}>Your email address is not verified.</span>
          <button
            style={{ ...s.btnSm, background: '#92400e', color: '#fbbf24', flexShrink: 0 }}
            onClick={onResendVerification}
          >
            Resend
          </button>
        </div>
      )}
      <div style={{ display: 'grid', gap: 12, maxWidth: 400, marginBottom: 16 }}>
        <div>
          <label style={s.label} htmlFor="settings-field-0">Email</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input id="settings-field-0" style={{ ...s.input, flex: 1, opacity: 0.6, cursor: 'not-allowed' }} value={user.email} disabled />
            {user.emailVerified && <span style={{ color: '#22c55e', fontSize: 12, fontWeight: 600, flexShrink: 0 }}>✓ Verified</span>}
          </div>
        </div>
        <div>
          <label style={s.label} htmlFor="settings-field-1">Name</label>
          <input id="settings-field-1" style={s.input} value={name} onChange={e => onNameChange(e.target.value)} placeholder="Your name" />
        </div>
      </div>
      <button style={s.btn} disabled={saving} onClick={onSave}>
        {saving ? <><Spinner size={14} color="#fff" /> Saving…</> : 'Save Profile'}
      </button>
    </div>
  )
}
