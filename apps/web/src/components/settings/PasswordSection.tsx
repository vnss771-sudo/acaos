import React from 'react'
import { s } from '../../styles.js'
import { Spinner } from '../Spinner.js'

export type PasswordForm = { currentPassword: string; newPassword: string; confirmPassword: string }

export function PasswordSection({ passwordForm, setPasswordForm, saving, onSave }: {
  passwordForm: PasswordForm
  setPasswordForm: React.Dispatch<React.SetStateAction<PasswordForm>>
  saving: boolean
  onSave: () => void
}) {
  return (
    <div style={s.card}>
      <div style={s.sectionHeader}>Change Password</div>
      <div style={{ display: 'grid', gap: 12, maxWidth: 400, marginBottom: 16 }}>
        {[
          { label: 'Current Password', field: 'currentPassword', autocomplete: 'current-password' },
          { label: 'New Password', field: 'newPassword', autocomplete: 'new-password' },
          { label: 'Confirm New Password', field: 'confirmPassword', autocomplete: 'new-password' }
        ].map(({ label, field, autocomplete }) => (
          <div key={field}>
            <label style={s.label} htmlFor={`settings-field-${field}`}>{label}</label>
            <input id={`settings-field-${field}`}
              style={s.input}
              type="password"
              value={(passwordForm as Record<string, string>)[field]}
              onChange={e => setPasswordForm(f => ({ ...f, [field]: e.target.value }))}
              autoComplete={autocomplete}
              minLength={field !== 'currentPassword' ? 12 : undefined}
            />
          </div>
        ))}
      </div>
      <button style={s.btn} disabled={saving} onClick={onSave}>
        {saving ? <><Spinner size={14} color="#fff" /> Saving…</> : 'Change Password'}
      </button>
    </div>
  )
}
